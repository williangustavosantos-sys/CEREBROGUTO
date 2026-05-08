import { Router, raw, type Request, type Response } from "express";
import Stripe from "stripe";
import { config } from "./config.js";
import { requireActiveUser } from "./auth-middleware.js";
import { getUserAccess, upsertUserAccess, type SubscriptionStatus } from "./user-access-store.js";
import { addLog } from "./log-store.js";

export const stripeEnabled = Boolean(config.stripeSecretKey);

const stripe = stripeEnabled ? new Stripe(config.stripeSecretKey) : null;

type PlanKey = "monthly" | "annual" | "beta";

function priceFor(plan: PlanKey): string | null {
  if (plan === "monthly") return config.stripePriceMonthly || null;
  if (plan === "annual") return config.stripePriceAnnual || null;
  if (plan === "beta") return config.stripePriceBeta || null;
  return null;
}

function disabled(res: Response) {
  return res.status(503).json({ message: "Billing not configured.", code: "BILLING_DISABLED" });
}

// Webhook needs the raw body for signature verification, so it must be mounted
// before express.json() runs. We export the handler separately to wire it on
// the app directly.
export async function stripeWebhookHandler(req: Request, res: Response) {
  if (!stripe || !config.stripeWebhookSecret) {
    return disabled(res);
  }

  const sig = req.headers["stripe-signature"];
  if (!sig || typeof sig !== "string") {
    return res.status(400).json({ message: "Missing stripe-signature." });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, config.stripeWebhookSecret);
  } catch (err: any) {
    console.error("[stripe] signature verification failed", err?.message);
    return res.status(400).json({ message: `Webhook error: ${err?.message ?? "invalid signature"}` });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id || (session.metadata?.userId as string | undefined);
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (userId && customerId) {
          upsertUserAccess(userId, {
            active: true,
            subscriptionStatus: "active" as SubscriptionStatus,
            paymentStatus: "active",
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId || undefined,
          });
          addLog({
            action: "billing_checkout_completed",
            actorUserId: "stripe",
            actorRole: "system",
            targetUserId: userId,
            metadata: { sessionId: session.id, customerId, subscriptionId: subscriptionId || null },
          });
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const userId = (sub.metadata?.userId as string | undefined) || findUserByCustomerId(customerId);
        if (!userId) break;

        const status: SubscriptionStatus = mapStripeStatus(sub.status);
        const periodEnd = (sub.items.data[0]?.current_period_end ?? null);
        const endsAt = typeof periodEnd === "number" ? new Date(periodEnd * 1000).toISOString() : null;
        upsertUserAccess(userId, {
          active: status === "active",
          subscriptionStatus: status,
          paymentStatus: status === "active" ? "active" : status === "expired" ? "expired" : "cancelled",
          subscriptionEndsAt: endsAt,
          stripeSubscriptionId: sub.id,
          stripePriceId: sub.items.data[0]?.price.id,
        });
        addLog({
          action: "billing_subscription_updated",
          actorUserId: "stripe",
          actorRole: "system",
          targetUserId: userId,
          metadata: { status: sub.status, eventType: event.type },
        });
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error("[stripe] webhook handler failed", err);
    res.status(500).json({ message: "Webhook handler error." });
  }
}

function mapStripeStatus(s: Stripe.Subscription.Status): SubscriptionStatus {
  if (s === "active" || s === "trialing") return "active";
  if (s === "canceled" || s === "incomplete_expired") return "cancelled";
  if (s === "past_due" || s === "unpaid" || s === "incomplete") return "expired";
  return "expired";
}

function findUserByCustomerId(customerId: string): string | undefined {
  // Lazy import to avoid circular dep.
  const { getAllUserAccess } = require("./user-access-store.js") as typeof import("./user-access-store.js");
  return getAllUserAccess().find((u) => u.stripeCustomerId === customerId)?.userId;
}

export const billingRouter = Router();

billingRouter.use(requireActiveUser);

billingRouter.post("/checkout", async (req, res) => {
  if (!stripe) return disabled(res);
  const userId = req.gutoUser!.userId;
  const access = getUserAccess(userId);
  if (!access) return res.status(404).json({ message: "User not found.", code: "USER_NOT_FOUND" });

  const plan = String(req.body?.plan || "monthly") as PlanKey;
  const priceId = priceFor(plan);
  if (!priceId) {
    return res.status(400).json({ message: `Plan "${plan}" not configured.`, code: "PRICE_NOT_CONFIGURED" });
  }

  try {
    let customerId = access.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: access.email,
        name: access.name,
        metadata: { userId },
      });
      customerId = customer.id;
      upsertUserAccess(userId, { stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: userId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${config.frontendPublicUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.frontendPublicUrl}/billing/cancel`,
      allow_promotion_codes: true,
      subscription_data: { metadata: { userId } },
      metadata: { userId, plan },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err: any) {
    console.error("[stripe] checkout creation failed", err);
    res.status(500).json({ message: err?.message || "Checkout creation failed.", code: "CHECKOUT_FAILED" });
  }
});

billingRouter.post("/portal", async (req, res) => {
  if (!stripe) return disabled(res);
  const userId = req.gutoUser!.userId;
  const access = getUserAccess(userId);
  if (!access?.stripeCustomerId) {
    return res.status(400).json({ message: "No Stripe customer for this user.", code: "NO_CUSTOMER" });
  }
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: access.stripeCustomerId,
      return_url: `${config.frontendPublicUrl}/`,
    });
    res.json({ url: portal.url });
  } catch (err: any) {
    console.error("[stripe] portal creation failed", err);
    res.status(500).json({ message: err?.message || "Portal creation failed.", code: "PORTAL_FAILED" });
  }
});

billingRouter.get("/me", (req, res) => {
  const userId = req.gutoUser!.userId;
  const access = getUserAccess(userId);
  if (!access) return res.status(404).json({ message: "User not found." });
  res.json({
    active: access.active,
    subscriptionStatus: access.subscriptionStatus,
    subscriptionEndsAt: access.subscriptionEndsAt,
    paymentStatus: access.paymentStatus ?? null,
    plan: access.plan ?? null,
    hasStripeCustomer: Boolean(access.stripeCustomerId),
    hasStripeSubscription: Boolean(access.stripeSubscriptionId),
  });
});
