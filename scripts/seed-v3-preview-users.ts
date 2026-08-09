import "dotenv/config";
import bcrypt from "bcrypt";
import { upsertUserAccessAsync } from "../src/user-access-store.js";

if (process.env.VERCEL_ENV !== "preview") {
  throw new Error("Refusing to seed V3 test users outside Vercel Preview.");
}

if (process.env.GUTO_V3_TEST_SEED_ENABLED !== "true") {
  throw new Error("GUTO_V3_TEST_SEED_ENABLED=true is required to seed V3 test users.");
}

const required = [
  "GUTO_V3_TEST_USER_A_EMAIL",
  "GUTO_V3_TEST_USER_A_PASSWORD",
  "GUTO_V3_TEST_USER_B_EMAIL",
  "GUTO_V3_TEST_USER_B_PASSWORD",
] as const;

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  throw new Error(`Missing V3 Preview seed variables: ${missing.join(", ")}`);
}

const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000).toISOString();
const users = [
  {
    userId: "guto-v3-founder-test-a",
    email: process.env.GUTO_V3_TEST_USER_A_EMAIL!.trim().toLowerCase(),
    password: process.env.GUTO_V3_TEST_USER_A_PASSWORD!,
    firstName: "Fundador",
    lastName: "V3 A",
  },
  {
    userId: "guto-v3-founder-test-b",
    email: process.env.GUTO_V3_TEST_USER_B_EMAIL!.trim().toLowerCase(),
    password: process.env.GUTO_V3_TEST_USER_B_PASSWORD!,
    firstName: "Concorrência",
    lastName: "V3 B",
  },
] as const;

for (const user of users) {
  const passwordHash = await bcrypt.hash(user.password, 10);
  await upsertUserAccessAsync(user.userId, {
    role: "student",
    coachId: "will-coach",
    active: true,
    visibleInArena: true,
    archived: false,
    subscriptionStatus: "active",
    paymentStatus: "active",
    subscriptionEndsAt: expiresAt,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    name: `${user.firstName} ${user.lastName}`,
    country: "Italia",
    language: "pt-BR",
    plan: "beta_simple",
    teamId: "GUTO_CORE",
    passwordHash,
  });
}

process.stdout.write(`${JSON.stringify({ ok: true, environment: "preview", users: users.map(({ userId }) => userId) })}\n`);
