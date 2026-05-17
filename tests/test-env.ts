// This file must be imported at the very top of every integration test
// to ensure environment variables are set before server.ts is statically imported.
process.env.GUTO_DISABLE_LISTEN = "1";
process.env.GUTO_ALLOW_DEV_ACCESS = "true";
process.env.JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
// Hard isolation: tests must NEVER reach production Redis.
// memory-store.ts checks this flag inside getRedisClient on every call.
process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
// Use a safe default for memory file during initialization phase
process.env.GUTO_MEMORY_FILE = process.env.GUTO_MEMORY_FILE || "tmp/guto-memory.init.json";
