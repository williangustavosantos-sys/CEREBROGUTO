import { join } from "path";

/** Modelo Gemini padrão do ecossistema GUTO (chat, dieta, classificadores, proatividade). */
export const GUTO_DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

const LOCAL_FRONTEND_URL = "http://localhost:3000";
const PRODUCTION_FRONTEND_URL = "https://corpoguto.vercel.app";

export function resolveFrontendPublicUrl(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const configuredUrl = env.FRONTEND_PUBLIC_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/+$/, "");

  const isProduction =
    env.NODE_ENV === "production" ||
    env.RENDER === "true" ||
    env.VERCEL_ENV === "production";
  return isProduction ? PRODUCTION_FRONTEND_URL : LOCAL_FRONTEND_URL;
}

export const config = {
  port: Number(process.env.PORT || 3001),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GUTO_GEMINI_MODEL || GUTO_DEFAULT_GEMINI_MODEL,
  modelTimeoutMs: Number(process.env.GUTO_MODEL_TIMEOUT_MS || 30_000),
  modelTemperature: Number(process.env.GUTO_MODEL_TEMPERATURE || 0.28),
  voiceApiKey: (process.env.VOICE_API_KEY || "").replace(/['"]/g, ""),
  workoutxApiKey: (process.env.WORKOUTX_API_KEY || "").replace(/['"]/g, ""),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  memoryFile: process.env.GUTO_MEMORY_FILE || join(process.cwd(), "data", "guto-memory.json"),
  timeZone: process.env.GUTO_TIME_ZONE || process.env.TZ || "Europe/Rome",
  allowedOrigins: (process.env.GUTO_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  rateLimitWindowMs: Number(process.env.GUTO_RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMaxRequests: Number(process.env.GUTO_RATE_LIMIT_MAX_REQUESTS || 120),
  // Upstash Redis — set in production for persistent memory across serverless instances
  upstashRedisUrl: process.env.UPSTASH_REDIS_REST_URL || "",
  upstashRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",
  // Auth
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-in-production",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  adminEmail: process.env.ADMIN_EMAIL || "",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || "",
  adminKey: process.env.ADMIN_KEY || "",
  frontendPublicUrl: resolveFrontendPublicUrl(),
  // Dev access bypass — never true in production
  allowDevAccess: process.env.GUTO_ALLOW_DEV_ACCESS === "true",
  enableLegacyCoachRoutes: process.env.GUTO_ENABLE_LEGACY_COACH_ROUTES === "true",
  // Cérebro soberano — Fatia 1 (assembleWorldState + decideTurn atrás de feature flag).
  // Default OFF: escada antiga 100% intacta. Só "true" liga o caminho novo (fluxo simples).
  brainSlice1: process.env.GUTO_BRAIN_SLICE1 === "true",
  // Web Push (VAPID) — see scripts/generate-vapid-keys.mjs
  pushVapidPublicKey: process.env.PUSH_VAPID_PUBLIC_KEY || "",
  pushVapidPrivateKey: process.env.PUSH_VAPID_PRIVATE_KEY || "",
  pushVapidSubject: process.env.PUSH_VAPID_SUBJECT || "mailto:app.guto.life@gmail.com",
  // Cron secret — required to call POST /guto/push/dispatch
  pushCronSecret: process.env.PUSH_CRON_SECRET || "",
  // Stripe (B2C subscriptions). Disabled when secretKey is empty.
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePriceMonthly: process.env.STRIPE_PRICE_MONTHLY || "",
  stripePriceAnnual: process.env.STRIPE_PRICE_ANNUAL || "",
  stripePriceBeta: process.env.STRIPE_PRICE_BETA || "",
};

// P0 — Render sets RENDER=true; standard Node.js prod sets NODE_ENV=production.
export const isProductionEnv =
  process.env.NODE_ENV === "production" || process.env.RENDER === "true";

// P0 guard: GUTO_ALLOW_DEV_ACCESS must never reach production/Render.
// Failing here causes a visible deploy crash instead of a silent auth bypass.
if (config.allowDevAccess && isProductionEnv) {
  throw new Error(
    "[GUTO] FATAL: GUTO_ALLOW_DEV_ACCESS=true is forbidden in production/Render. " +
      "Remove this environment variable before deploying."
  );
}

// P0 guard: JWT_SECRET must be strong in production.
// A weak or missing secret lets anyone forge valid tokens.
const DEV_JWT_SECRET = "dev-secret-change-in-production";
if (isProductionEnv && (!config.jwtSecret || config.jwtSecret === DEV_JWT_SECRET)) {
  throw new Error(
    "[GUTO] FATAL: JWT_SECRET is weak or missing in production/Render. " +
      "Set a strong JWT_SECRET (32+ random characters) before deploying."
  );
}
