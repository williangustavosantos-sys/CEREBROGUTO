import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { writeUserAccessStoreRaw, type UserAccess } from "../src/user-access-store.js";
import { createTeam } from "../src/team-store.js";
import { config } from "../src/config.js";
import { writeMemoryStoreSync } from "../src/memory-store.js";

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const testMemoryFile = join(tmpDir, "guto-memory.weekly-diet-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;
let originalMemoryFile: string;

const adminA = fixture("admin-diet-w-a", "admin", "admin-diet-w-a", "TEAM_DW");
const adminB = fixture("admin-diet-w-b", "admin", "admin-diet-w-b", "TEAM_DX");
const coachA = fixture("coach-diet-w-a", "coach", "coach-diet-w-a", "TEAM_DW");
const coachB = fixture("coach-diet-w-b", "coach", "coach-diet-w-b", "TEAM_DX");
const studentA = fixture("student-diet-w-a", "student", coachA.userId, "TEAM_DW");
const studentB = fixture("student-diet-w-b", "student", coachB.userId, "TEAM_DX");
const studentUnlinked = fixture("student-diet-w-unlinked", "student", "other-coach", "TEAM_DW");

function fixture(userId: string, role: UserAccess["role"], coachId: string, teamId?: string): UserAccess {
  const now = new Date().toISOString();
  return { userId, role, coachId, teamId, active: true, visibleInArena: true, archived: false, createdAt: now, updatedAt: now, subscriptionStatus: "active", subscriptionEndsAt: null };
}

function seedTeams(): void {
  const now = new Date().toISOString();
  createTeam({ id: "TEAM_DW", name: "Time DW", plan: "pro", status: "active", createdAt: now, updatedAt: now });
  createTeam({ id: "TEAM_DX", name: "Time DX", plan: "pro", status: "active", createdAt: now, updatedAt: now });
}

function seedAccess(): void {
  writeUserAccessStoreRaw({
    users: {
      [adminA.userId]: adminA,
      [adminB.userId]: adminB,
      [coachA.userId]: coachA,
      [coachB.userId]: coachB,
      [studentA.userId]: studentA,
      [studentB.userId]: studentB,
      [studentUnlinked.userId]: studentUnlinked,
    },
  });
}

function token(user: UserAccess): string {
  return jwt.sign({ userId: user.userId, role: user.role, coachId: user.coachId }, process.env.JWT_SECRET || "dev-secret-change-in-production");
}

function superToken(): string {
  return jwt.sign({ userId: "super-diet-weekly-test", role: "super_admin" }, process.env.JWT_SECRET || "dev-secret-change-in-production");
}

async function req(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

function authHeaders(tok: string) {
  return { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
}

function validWeekDietBody() {
  return {
    days: {
      monday: {
        breakfast: "Aveia com banana e mel",
        lunch: "Frango grelhado com arroz e legumes",
        dinner: "Omelete com queijo",
        snacks: "Iogurte natural",
        hydration: "2,5 litros",
        notes: "Evitar açúcar refinado",
        caloriesEstimate: 2200,
        proteinEstimate: 160,
      },
      wednesday: {
        breakfast: "Ovos mexidos com torrada integral",
        lunch: "Salada de atum com azeite",
        dinner: "Peixe grelhado com batata-doce",
      },
      friday: {
        breakfast: "Vitamina de banana com aveia",
        lunch: "Carne magra com mandioca",
        dinner: "Sopa de legumes",
        hydration: "3 litros",
      },
    },
  };
}

before(async () => {
  process.env.GUTO_DISABLE_LISTEN = "1";
  originalMemoryFile = config.memoryFile;
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  config.memoryFile = testMemoryFile;
  mkdirSync(tmpDir, { recursive: true });
  originalUserAccess = existsSync(userAccessFile) ? readFileSync(userAccessFile, "utf8") : null;

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  app = serverModule.app;

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind weekly diet test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  seedTeams();
  seedAccess();
  writeMemoryStoreSync({});
});

after(async () => {
  await new Promise<void>((resolve, reject) => { server.close((err) => (err ? reject(err) : resolve())); });
  if (originalUserAccess === null) rmSync(userAccessFile, { force: true });
  else writeFileSync(userAccessFile, originalUserAccess);
  rmSync(testMemoryFile, { force: true });
  config.memoryFile = originalMemoryFile;
  process.env.GUTO_MEMORY_FILE = originalMemoryFile;
});

describe("weekly diet plan — admin/coach routes", () => {

  // A) Admin saves weekly diet for student in own team
  it("A) allows admin to save weekly diet for student in own team", async () => {
    const res = await req(`/admin/students/${studentA.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(validWeekDietBody()),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { weeklyDiet: { studentId: string; days: Record<string, unknown> } };
    assert.equal(body.weeklyDiet.studentId, studentA.userId);
    assert.ok(body.weeklyDiet.days.monday, "monday should be present");
    assert.ok(body.weeklyDiet.days.wednesday, "wednesday should be present");
    assert.ok(body.weeklyDiet.days.friday, "friday should be present");
  });

  // B) Coach saves weekly diet for linked student
  it("B) allows coach to save weekly diet for their own linked student", async () => {
    const res = await req(`/admin/students/${studentA.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(coachA)),
      body: JSON.stringify(validWeekDietBody()),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { weeklyDiet: { studentId: string } };
    assert.equal(body.weeklyDiet.studentId, studentA.userId);
  });

  // C) Admin blocked from student in another team
  it("C) blocks admin from saving weekly diet for student in another team", async () => {
    const res = await req(`/admin/students/${studentB.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(validWeekDietBody()),
    });
    assert.ok(res.status === 403 || res.status === 404, `expected 403 or 404, got ${res.status}`);
  });

  // D) Coach blocked from student linked to another coach
  it("D) blocks coach from saving weekly diet for student linked to another coach", async () => {
    const res = await req(`/admin/students/${studentUnlinked.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(coachA)),
      body: JSON.stringify(validWeekDietBody()),
    });
    assert.ok(res.status === 403 || res.status === 404, `expected 403 or 404, got ${res.status}`);
  });

  // E) Student token blocked
  it("E) blocks student token from weekly diet routes", async () => {
    const res = await req(`/admin/students/${studentA.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(studentA)),
      body: JSON.stringify(validWeekDietBody()),
    });
    assert.equal(res.status, 403);
  });

  // F) GET week returns null when no plan saved
  it("F) GET /diet/week returns null when no plan saved", async () => {
    const res = await req(`/admin/students/${studentA.userId}/diet/week`, {
      headers: authHeaders(token(adminA)),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { weeklyDiet: unknown };
    assert.equal(body.weeklyDiet, null);
  });

  // G) GET week returns saved plan
  it("G) GET /diet/week returns the saved weekly diet plan", async () => {
    await req(`/admin/students/${studentA.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(validWeekDietBody()),
    });
    const res = await req(`/admin/students/${studentA.userId}/diet/week`, {
      headers: authHeaders(token(adminA)),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { weeklyDiet: { days: Record<string, unknown> } };
    assert.ok(body.weeklyDiet?.days?.monday, "monday must be present");
    assert.ok(body.weeklyDiet?.days?.wednesday, "wednesday must be present");
  });

  // H) GET today returns today's diet from the weekly plan
  it("H) GET /diet/today returns today's diet from the weekly plan", async () => {
    await req(`/admin/students/${studentA.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(validWeekDietBody()),
    });
    const res = await req(`/admin/students/${studentA.userId}/diet/today`, {
      headers: authHeaders(token(adminA)),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { diet: unknown; dayKey: string; fromWeeklyPlan: boolean };
    assert.equal(typeof body.dayKey, "string");
    assert.ok(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].includes(body.dayKey));
    assert.equal(typeof body.fromWeeklyPlan, "boolean");
  });

  // I) GET today falls back to official diet when no weeklyDietPlan
  it("I) GET /diet/today falls back to null when no weeklyDietPlan and no official diet", async () => {
    const res = await req(`/admin/students/${studentA.userId}/diet/today`, {
      headers: authHeaders(token(adminA)),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { diet: unknown; dayKey: string; fromWeeklyPlan: boolean };
    assert.equal(body.diet, null);
    assert.equal(body.fromWeeklyPlan, false);
  });

  // J) Payload vazio é recusado
  it("J) rejects empty payload with 400", async () => {
    const res = await req(`/admin/students/${studentA.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify({ days: {} }),
    });
    assert.equal(res.status, 400);
  });

  // K) Dia inválido é recusado
  it("K) rejects invalid day key with 400", async () => {
    const res = await req(`/admin/students/${studentA.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify({
        days: {
          lunes: { breakfast: "Café", lunch: "Almoço" },
        },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { message: string };
    assert.match(body.message, /lunes/i);
  });

  // L) Texto gigante é recusado
  it("L) rejects oversized text field with 400", async () => {
    const bigText = "A".repeat(2001);
    const res = await req(`/admin/students/${studentA.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify({
        days: {
          monday: {
            breakfast: bigText,
          },
        },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { message: string };
    assert.match(body.message, /breakfast/i);
  });

  // super_admin can access any team
  it("super_admin can save weekly diet for any team student", async () => {
    const res = await req(`/admin/students/${studentB.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(superToken()),
      body: JSON.stringify(validWeekDietBody()),
    });
    assert.equal(res.status, 200);
  });

  // Campos inesperados dentro de um dia são recusados
  it("rejects unexpected fields inside a diet day with 400", async () => {
    const res = await req(`/admin/students/${studentA.userId}/diet/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify({
        days: {
          tuesday: {
            breakfast: "Café",
            invalidField: "valor não permitido",
          },
        },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { message: string };
    assert.match(body.message, /invalidField/i);
  });

});
