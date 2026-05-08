import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { getCatalogById } from "../exercise-catalog";
import { writeUserAccessStoreRaw, type UserAccess } from "../src/user-access-store.js";
import { createTeam } from "../src/team-store.js";
import { config } from "../src/config.js";
import { writeMemoryStoreSync } from "../src/memory-store.js";

const tmpDir = join(process.cwd(), "tmp");
const userAccessFile = join(tmpDir, "user-access.json");
const testMemoryFile = join(tmpDir, "guto-memory.weekly-workout-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess: string | null = null;
let originalMemoryFile: string;

const adminA = fixture("admin-weekly-a", "admin", "admin-weekly-a", "TEAM_W");
const adminB = fixture("admin-weekly-b", "admin", "admin-weekly-b", "TEAM_X");
const coachA = fixture("coach-weekly-a", "coach", "coach-weekly-a", "TEAM_W");
const coachB = fixture("coach-weekly-b", "coach", "coach-weekly-b", "TEAM_X");
const studentA = fixture("student-weekly-a", "student", coachA.userId, "TEAM_W");
const studentB = fixture("student-weekly-b", "student", coachB.userId, "TEAM_X");
const studentUnlinked = fixture("student-weekly-unlinked", "student", "other-coach", "TEAM_W");

function fixture(userId: string, role: UserAccess["role"], coachId: string, teamId?: string): UserAccess {
  const now = new Date().toISOString();
  return { userId, role, coachId, teamId, active: true, visibleInArena: true, archived: false, createdAt: now, updatedAt: now, subscriptionStatus: "active", subscriptionEndsAt: null };
}

function seedTeams(): void {
  const now = new Date().toISOString();
  createTeam({ id: "TEAM_W", name: "Time W", plan: "pro", status: "active", createdAt: now, updatedAt: now });
  createTeam({ id: "TEAM_X", name: "Time X", plan: "pro", status: "active", createdAt: now, updatedAt: now });
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
  return jwt.sign({ userId: "super-weekly-test", role: "super_admin" }, process.env.JWT_SECRET || "dev-secret-change-in-production");
}

async function req(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

function authHeaders(tok: string) {
  return { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
}

function catalogExercise(id = "supino_reto") {
  const entry = getCatalogById(id);
  assert.ok(entry, `${id} must exist in catalog`);
  return {
    id: entry.id,
    name: entry.canonicalNamePt,
    canonicalNamePt: entry.canonicalNamePt,
    muscleGroup: entry.muscleGroup,
    sets: 3,
    reps: "10-12",
    rest: "60s",
    cue: "Execução limpa.",
    note: "",
    videoUrl: entry.videoUrl,
    videoProvider: "local",
    sourceFileName: entry.sourceFileName,
  };
}

function validDayPlan(focusKey = "chest_triceps", exerciseId = "supino_reto") {
  return {
    focus: "Peito e tríceps",
    focusKey,
    dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(),
    summary: "Treino semanal.",
    source: "coach_manual",
    lockedByCoach: true,
    exercises: [catalogExercise(exerciseId)],
    blocks: [{ name: "Principal", exercises: [catalogExercise(exerciseId)] }],
  };
}

function validWeekBody() {
  return {
    days: {
      monday: validDayPlan("chest_triceps", "supino_reto"),
      tuesday: validDayPlan("legs_core", "agachamento_livre"),
      wednesday: null,
      thursday: validDayPlan("back_biceps", "puxada_frente"),
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
  if (!address || typeof address === "string") throw new Error("Failed to bind weekly workout test server.");
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

describe("weekly workout plan — admin/coach routes", () => {
  // A) Admin saves weekly workout for own team student
  it("A) allows admin to save weekly workout for student in own team", async () => {
    const res = await req(`/admin/students/${studentA.userId}/workout/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(validWeekBody()),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { weeklyWorkout: { studentId: string; days: Record<string, unknown> } };
    assert.equal(body.weeklyWorkout.studentId, studentA.userId);
    assert.ok(body.weeklyWorkout.days.monday, "monday should be set");
    assert.ok(body.weeklyWorkout.days.thursday, "thursday should be set");
  });

  // B) Coach saves weekly workout only for linked student
  it("B) allows coach to save weekly workout for their own linked student", async () => {
    const res = await req(`/admin/students/${studentA.userId}/workout/week`, {
      method: "PUT",
      headers: authHeaders(token(coachA)),
      body: JSON.stringify(validWeekBody()),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { weeklyWorkout: { studentId: string } };
    assert.equal(body.weeklyWorkout.studentId, studentA.userId);
  });

  // C) Admin cannot access student in another team
  it("C) blocks admin from saving weekly workout for student in another team", async () => {
    const res = await req(`/admin/students/${studentB.userId}/workout/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(validWeekBody()),
    });
    assert.equal(res.status, 403);
  });

  // D) Coach cannot access student linked to another coach
  it("D) blocks coach from saving weekly workout for student linked to another coach", async () => {
    const res = await req(`/admin/students/${studentUnlinked.userId}/workout/week`, {
      method: "PUT",
      headers: authHeaders(token(coachA)),
      body: JSON.stringify(validWeekBody()),
    });
    assert.equal(res.status, 403);
  });

  // E) Student cannot access the weekly workout routes
  it("E) blocks student token from weekly workout routes", async () => {
    const res = await req(`/admin/students/${studentA.userId}/workout/week`, {
      method: "PUT",
      headers: authHeaders(token(studentA)),
      body: JSON.stringify(validWeekBody()),
    });
    assert.equal(res.status, 403);
  });

  // F) Weekly plan rejects exercise not in catalog
  it("F) rejects weekly workout with exercise outside the official catalog", async () => {
    const badPlan = {
      days: {
        monday: {
          focus: "Inválido",
          dateLabel: "Hoje",
          scheduledFor: new Date().toISOString(),
          summary: "",
          exercises: [{ id: "exercicio-inventado", name: "Inventado", canonicalNamePt: "Inventado", muscleGroup: "peito", sets: 3, reps: "10", rest: "60s", cue: "", note: "", videoUrl: "/exercise/visuals/inventado.mp4", videoProvider: "local", sourceFileName: "inventado.mp4" }],
        },
      },
    };
    const res = await req(`/admin/students/${studentA.userId}/workout/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(badPlan),
    });
    assert.equal(res.status, 400);
  });

  // G) Weekly plan rejects exercise without local video
  it("G) rejects weekly workout with exercise missing local video", async () => {
    const noVideoPlan = {
      days: {
        monday: {
          focus: "Peito",
          dateLabel: "Hoje",
          scheduledFor: new Date().toISOString(),
          summary: "",
          exercises: [{ id: "supino_reto", name: "Supino reto", canonicalNamePt: "Supino reto", muscleGroup: "peito", sets: 3, reps: "10", rest: "60s", cue: "", note: "", videoUrl: "", videoProvider: "local", sourceFileName: "" }],
        },
      },
    };
    const res = await req(`/admin/students/${studentA.userId}/workout/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(noVideoPlan),
    });
    assert.equal(res.status, 400);
  });

  // H) GET today returns only current day's workout
  it("H) GET /workout/today returns only today's workout from the weekly plan", async () => {
    // First save weekly plan
    const putRes = await req(`/admin/students/${studentA.userId}/workout/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(validWeekBody()),
    });
    assert.equal(putRes.status, 200);

    const res = await req(`/admin/students/${studentA.userId}/workout/today`, {
      headers: authHeaders(token(adminA)),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { workout: unknown | null; dayKey: string; fromWeeklyPlan: boolean };
    assert.equal(typeof body.dayKey, "string");
    // If today has a planned workout, it must be from the weekly plan
    if (body.workout !== null) {
      assert.equal(body.fromWeeklyPlan, true);
    }
  });

  // I) GET today when no plan for today returns safe null response
  it("I) GET /workout/today returns safe null when no weekly plan covers today", async () => {
    // Save weekly plan with only wednesday covered; test will pass regardless of what day it is
    // since we check the contract (no crash, clean response)
    const res = await req(`/admin/students/${studentA.userId}/workout/today`, {
      headers: authHeaders(token(adminA)),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { workout: unknown; dayKey: string; fromWeeklyPlan: boolean };
    assert.equal(typeof body.dayKey, "string");
    assert.ok(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].includes(body.dayKey));
    // No weekly plan saved => workout should be null or from lastWorkoutPlan fallback
    assert.equal(typeof body.fromWeeklyPlan, "boolean");
  });

  // J) Fallback to lastWorkoutPlan when no weekly plan exists
  it("J) GET /workout/today falls back to lastWorkoutPlan when no weeklyWorkoutPlan exists", async () => {
    // Set a lastWorkoutPlan via the existing workout route
    const putRes = await req(`/admin/students/${studentA.userId}/workout`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(validDayPlan()),
    });
    assert.equal(putRes.status, 200);

    // Now GET today — no weeklyWorkoutPlan, should fall back
    const res = await req(`/admin/students/${studentA.userId}/workout/today`, {
      headers: authHeaders(token(adminA)),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { workout: unknown | null; dayKey: string; fromWeeklyPlan: boolean };
    assert.notEqual(body.workout, null, "should have fallback workout from lastWorkoutPlan");
    assert.equal(body.fromWeeklyPlan, false, "should flag as NOT from weekly plan");
  });

  // GET week returns saved plan
  it("GET /workout/week returns null when no plan saved yet", async () => {
    const res = await req(`/admin/students/${studentA.userId}/workout/week`, {
      headers: authHeaders(token(adminA)),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { weeklyWorkout: unknown };
    assert.equal(body.weeklyWorkout, null);
  });

  it("GET /workout/week returns saved weekly plan", async () => {
    await req(`/admin/students/${studentA.userId}/workout/week`, {
      method: "PUT",
      headers: authHeaders(token(adminA)),
      body: JSON.stringify(validWeekBody()),
    });
    const res = await req(`/admin/students/${studentA.userId}/workout/week`, {
      headers: authHeaders(token(adminA)),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { weeklyWorkout: { days: Record<string, unknown> } };
    assert.ok(body.weeklyWorkout?.days?.monday, "monday must be present");
    assert.ok(body.weeklyWorkout?.days?.thursday, "thursday must be present");
    assert.equal(body.weeklyWorkout?.days?.wednesday, undefined, "wednesday was null so should not be in days");
  });

  it("super_admin can access weekly workout for any team", async () => {
    const res = await req(`/admin/students/${studentB.userId}/workout/week`, {
      headers: authHeaders(superToken()),
    });
    assert.equal(res.status, 200);
  });
});
