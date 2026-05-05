import { join } from "path";

export const config = {
  port: Number(process.env.PORT || 3001),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GUTO_GEMINI_MODEL || "gemini-2.5-flash",
  modelTimeoutMs: Number(process.env.GUTO_MODEL_TIMEOUT_MS || 30_000),
  modelTemperature: Number(process.env.GUTO_MODEL_TEMPERATURE || 0.28),
  voiceApiKey: (process.env.VOICE_API_KEY || "").replace(/['"]/g, ""),
  workoutxApiKey: (process.env.WORKOUTX_API_KEY || "").replace(/['"]/g, ""),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  memoryFile: process.env.GUTO_MEMORY_FILE || join(process.cwd(), "data", "guto-memory.json"),
  defaultUserId: process.env.GUTO_DEFAULT_USER_ID || "local-user",
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
  frontendPublicUrl: process.env.FRONTEND_PUBLIC_URL || "http://localhost:3000",
  // Dev access bypass — never true in production
  allowDevAccess: process.env.GUTO_ALLOW_DEV_ACCESS === "true",
};
