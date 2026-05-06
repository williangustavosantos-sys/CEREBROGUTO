import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import { getCatalogById } from "../exercise-catalog";
import {
  normalizeWorkoutPlanAgainstCatalog,
  WorkoutCatalogValidationError,
} from "../src/workout-catalog-validation";

const testMemoryFile = join(process.cwd(), "tmp", "guto-memory.video-gate-test.json");
const userAccessFile = join(process.cwd(), "tmp", "user-access.json");

let app: { listen: (port: number, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalUserAccess = "";
let upsertUserAccess: typeof import("../src/user-access-store")["upsertUserAccess"];

function catalogExercise(id = "supino_reto") {
  const entry = getCatalogById(id);
  assert.ok(entry, `${id} must exist in catalog for this test`);
  return {
    id: entry.id,
    name: entry.canonicalNamePt,
    canonicalNamePt: entry.canonicalNamePt,
    muscleGroup: entry.muscleGroup,
    sets: 3,
    reps: "10",
    rest: "60s",
    cue: "Execução limpa.",
    note: "Sem improviso.",
    videoUrl: entry.videoUrl,
    videoProvider: "local",
    sourceFileName: entry.sourceFileName,
  };
}

function workoutPlan(exercise = catalogExercise()) {
  return {
    focus: "Peito e tríceps",
    focusKey: "chest_triceps",
    dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(),
    summary: "Treino oficial.",
    exercises: [exercise],
  };
}

function assertCatalogError(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error) => error instanceof WorkoutCatalogValidationError && error.code === code
  );
}

function signToken(role: "student" | "admin", userId: string) {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET || "dev-secret-change-in-production");
}

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

before(async () => {
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_ALLOW_DEV_ACCESS = "true";

  originalUserAccess = existsSync(userAccessFile) ? readFileSync(userAccessFile, "utf8") : "";
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, callback?: () => void) => Server };
  };
  const userAccessModule = await import(pathToFileURL(join(process.cwd(), "src", "user-access-store.ts")).href);
  upsertUserAccess = userAccessModule.upsertUserAccess;
  app = serverModule.app;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  upsertUserAccess("student-video-gate", {
    role: "student",
    coachId: "admin",
    active: true,
    visibleInArena: true,
    archived: false,
    subscriptionStatus: "active",
    subscriptionEndsAt: null,
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (existsSync(testMemoryFile)) unlinkSync(testMemoryFile);
  if (originalUserAccess) writeFileSync(userAccessFile, originalUserAccess);
});

describe("workout catalog video gate", () => {
  it("fails when a workout exercise uses an unknown id", () => {
    assertCatalogError(
      () => normalizeWorkoutPlanAgainstCatalog(workoutPlan({ ...catalogExercise(), id: "invented_exercise" })),
      "INVALID_WORKOUT_EXERCISE_CATALOG_ID"
    );
  });

  it("fails when a workout exercise has an empty videoUrl", () => {
    assertCatalogError(
      () => normalizeWorkoutPlanAgainstCatalog(workoutPlan({ ...catalogExercise(), videoUrl: "" })),
      "WORKOUT_EXERCISE_VIDEO_REQUIRED"
    );
  });

  it("fails when a workout exercise tries to use an external videoUrl", () => {
    assertCatalogError(
      () => normalizeWorkoutPlanAgainstCatalog(workoutPlan({ ...catalogExercise(), videoUrl: "https://cdn.example.com/supino.mp4" })),
      "EXTERNAL_WORKOUT_VIDEO_NOT_ALLOWED"
    );
  });

  it("fails when a workout exercise videoUrl diverges from the catalog", () => {
    assertCatalogError(
      () => normalizeWorkoutPlanAgainstCatalog(workoutPlan({ ...catalogExercise(), videoUrl: "/exercise/visuals/peito/flexao.mp4" })),
      "WORKOUT_EXERCISE_VIDEO_MISMATCH"
    );
  });

  it("normalizes a valid catalog exercise and keeps the official local video", () => {
    const normalized = normalizeWorkoutPlanAgainstCatalog(workoutPlan({ ...catalogExercise(), name: "Nome editado" }));
    assert.equal((normalized.exercises as any[])[0].name, "Supino reto");
    assert.equal((normalized.exercises as any[])[0].videoUrl, getCatalogById("supino_reto")?.videoUrl);
    assert.equal((normalized.exercises as any[])[0].videoProvider, "local");
  });

  it("rejects manual admin workout saves without catalog video", async () => {
    const response = await request("/admin/students/student-video-gate/workout", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("admin", "admin-video-gate")}`,
      },
      body: JSON.stringify({
        workout: workoutPlan({ ...catalogExercise(), id: "manual-1", videoUrl: "" }),
      }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "INVALID_WORKOUT_EXERCISE_CATALOG_ID");
  });

  it("rejects validate-workout when the current plan is not backed by catalog video", async () => {
    writeFileSync(testMemoryFile, JSON.stringify({
      "student-video-gate": {
        userId: "student-video-gate",
        name: "Aluno",
        language: "pt-BR",
        totalXp: 100,
        streak: 0,
        trainedToday: false,
        completedWorkoutDates: [],
        adaptedMissionDates: [],
        missedMissionDates: [],
        xpEvents: [],
        proactiveSent: {},
        lastWorkoutPlan: workoutPlan({ ...catalogExercise(), id: "manual-ghost", videoUrl: "" }),
      },
    }, null, 2));

    const response = await request("/guto/validate-workout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("student", "student-video-gate")}`,
      },
      body: JSON.stringify({
        imageBase64: "data:image/jpeg;base64,not-a-real-image",
        workoutFocus: "chest_triceps",
        workoutLabel: "Peito e tríceps",
        locationMode: "gym",
        language: "pt-BR",
      }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "INVALID_WORKOUT_EXERCISE_CATALOG_ID");
  });
});
