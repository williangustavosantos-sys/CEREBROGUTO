import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import { getCatalogById } from "../exercise-catalog";
import {
  normalizeWorkoutPlanAgainstCatalog,
  WorkoutCatalogValidationError,
} from "../src/workout-catalog-validation";
import {
  validateExerciseVideoMetadata,
  type ExerciseVideoMetadata,
} from "../src/exercise-video-validation";
import {
  saveCustomExerciseRequest,
  type CustomExerciseRequest,
} from "../src/custom-exercise-store";

const testMemoryFile = join(process.cwd(), "tmp", "guto-memory.video-gate-test.json");
const userAccessFile = join(process.cwd(), "tmp", "user-access.json");
const customExerciseFile = join(process.cwd(), "tmp", "custom-exercises.video-gate-test.json");
const validImageBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
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

function workoutPlan(exercise: Record<string, unknown> = catalogExercise()) {
  return {
    focus: "Peito e tríceps",
    focusKey: "chest_triceps",
    dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(),
    summary: "Treino oficial.",
    exercises: [exercise],
  };
}

function validCustomVideo(overrides: Partial<ExerciseVideoMetadata> = {}): ExerciseVideoMetadata {
  return {
    sourceFileName: "supino-inclinado-halter.mp4",
    videoUrl: "/exercise/visuals/custom/supino-inclinado-halter.mp4",
    fileSizeBytes: 8 * 1024 * 1024,
    durationSeconds: 20,
    width: 1280,
    height: 720,
    fps: 30,
    mimeType: "video/mp4",
    hasAudio: false,
    ...overrides,
  };
}

function validCustomBody(id: string, sourceFileName: string) {
  return {
    id,
    canonicalNamePt: "Supino customizado",
    muscleGroup: "peito",
    sourceFileName,
    videoUrl: `/exercise/visuals/custom/${sourceFileName}`,
    fileSizeBytes: 8 * 1024 * 1024,
    durationSeconds: 20,
    width: 1280,
    height: 720,
    fps: 30,
    mimeType: "video/mp4",
    hasAudio: false,
  };
}

function customExerciseRecord(overrides: Partial<CustomExerciseRequest> = {}): CustomExerciseRequest {
  return {
    id: "custom_invalid_approval",
    canonicalNamePt: "Custom inválido",
    namesByLanguage: {
      "pt-BR": "Custom inválido",
      "it-IT": "Custom inválido",
      "en-US": "Custom inválido",
    },
    aliasesByLanguage: {
      "pt-BR": [],
      "it-IT": [],
      "en-US": [],
    },
    muscleGroup: "peito",
    videoUrl: "/exercise/visuals/custom/custom-invalido.mp4",
    sourceFileName: "custom-invalido.mp4",
    videoProvider: "local",
    status: "pending",
    requestedBy: "coach-video-gate",
    requestedByRole: "coach",
    requestedAt: new Date().toISOString(),
    videoValidated: false,
    videoMetadata: {
      fileSizeBytes: 8 * 1024 * 1024,
      durationSeconds: 31,
      width: 1280,
      height: 720,
      fps: 30,
      mimeType: "video/mp4",
      hasAudio: false,
    },
    custom: true,
    ...overrides,
  };
}

function assertCatalogError(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error) => error instanceof WorkoutCatalogValidationError && error.code === code
  );
}

function signToken(role: "student" | "admin" | "coach", userId: string) {
  return jwt.sign(
    { userId, role, coachId: role === "coach" ? userId : undefined },
    process.env.JWT_SECRET!
  );
}

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

before(async () => {
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  process.env.GUTO_CUSTOM_EXERCISE_FILE = customExerciseFile;
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_ALLOW_DEV_ACCESS = "true";

  originalUserAccess = existsSync(userAccessFile) ? readFileSync(userAccessFile, "utf8") : "";
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  writeFileSync(customExerciseFile, JSON.stringify({ exercises: {} }, null, 2));

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  const userAccessModule = await import(pathToFileURL(join(process.cwd(), "src", "user-access-store.ts")).href);
  upsertUserAccess = userAccessModule.upsertUserAccess;
  app = serverModule.app;

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  writeFileSync(customExerciseFile, JSON.stringify({ exercises: {} }, null, 2));
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
  if (existsSync(customExerciseFile)) unlinkSync(customExerciseFile);
  if (originalUserAccess) writeFileSync(userAccessFile, originalUserAccess);
});

describe("workout catalog video gate", () => {
  it("accepts a valid MP4 exercise video under the mobile standard", () => {
    const result = validateExerciseVideoMetadata(validCustomVideo(), { customOnly: true });

    assert.equal(result.valid, true);
    assert.equal(result.normalized?.durationSeconds, 20);
    assert.equal(result.normalized?.fileSizeBytes, 8 * 1024 * 1024);
  });

  it("fails when an exercise video has 31 seconds", () => {
    const result = validateExerciseVideoMetadata(validCustomVideo({ durationSeconds: 31 }), { customOnly: true });

    assert.equal(result.valid, false);
    assert.equal(result.errors[0]?.code, "EXERCISE_VIDEO_TOO_LONG");
  });

  it("fails when an exercise video is above 12MB", () => {
    const result = validateExerciseVideoMetadata(validCustomVideo({ fileSizeBytes: 13 * 1024 * 1024 }), { customOnly: true });

    assert.equal(result.valid, false);
    assert.equal(result.errors[0]?.code, "EXERCISE_VIDEO_TOO_LARGE");
  });

  it("fails when an exercise video is 1920x1080", () => {
    const result = validateExerciseVideoMetadata(validCustomVideo({ width: 1920, height: 1080 }), { customOnly: true });

    assert.equal(result.valid, false);
    assert.equal(result.errors[0]?.code, "EXERCISE_VIDEO_RESOLUTION_TOO_HIGH");
  });

  it("fails when an exercise video uses an external URL", () => {
    const result = validateExerciseVideoMetadata(validCustomVideo({ videoUrl: "https://cdn.example.com/supino.mp4" }), { customOnly: true });

    assert.equal(result.valid, false);
    assert.equal(result.errors[0]?.code, "EXERCISE_VIDEO_EXTERNAL_URL_NOT_ALLOWED");
  });

  it("fails when an exercise video has no videoUrl", () => {
    const result = validateExerciseVideoMetadata(validCustomVideo({ videoUrl: "" }), { customOnly: true });

    assert.equal(result.valid, false);
    assert.equal(result.errors[0]?.code, "EXERCISE_VIDEO_REQUIRED");
  });

  it("fails when exercise video metadata is missing", () => {
    const result = validateExerciseVideoMetadata({ sourceFileName: "supino.mp4", videoUrl: "/exercise/visuals/custom/supino.mp4" }, { customOnly: true });

    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.code === "EXERCISE_VIDEO_METADATA_REQUIRED"), true);
  });

  it("fails when an exercise video is .mov", () => {
    const result = validateExerciseVideoMetadata(validCustomVideo({
      sourceFileName: "supino.mov",
      videoUrl: "/exercise/visuals/custom/supino.mov",
      mimeType: "video/quicktime",
    }), { customOnly: true });

    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.code === "EXERCISE_VIDEO_INVALID_FORMAT"), true);
  });

  it("fails when an exercise video is .gif", () => {
    const result = validateExerciseVideoMetadata(validCustomVideo({
      sourceFileName: "supino.gif",
      videoUrl: "/exercise/visuals/custom/supino.gif",
      mimeType: "image/gif",
    }), { customOnly: true });

    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.code === "EXERCISE_VIDEO_INVALID_FORMAT"), true);
  });

  it("blocks admin approval when the custom exercise video is invalid", async () => {
    saveCustomExerciseRequest(customExerciseRecord());

    const response = await request("/admin/exercises/custom/custom_invalid_approval/approve", {
      method: "POST",
      headers: { Authorization: `Bearer ${signToken("admin", "admin-video-gate")}` },
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "EXERCISE_VIDEO_TOO_LONG");
  });

  it("blocks coach custom exercise requests with invalid video metadata", async () => {
    const response = await request("/admin/exercises/custom", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("coach", "coach-video-gate")}`,
      },
      body: JSON.stringify({
        ...validCustomBody("custom_video_longo", "custom-video-longo.mp4"),
        durationSeconds: 31,
      }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "EXERCISE_VIDEO_TOO_LONG");
  });

  it("shows an approved custom exercise with valid video in the official catalog", async () => {
    const createResponse = await request("/admin/exercises/custom", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("coach", "coach-video-gate")}`,
      },
      body: JSON.stringify(validCustomBody("custom_catalog_valid", "custom-catalog-valid.mp4")),
    });

    assert.equal(createResponse.status, 201);

    const approveResponse = await request("/admin/exercises/custom/custom_catalog_valid/approve", {
      method: "POST",
      headers: { Authorization: `Bearer ${signToken("admin", "admin-video-gate")}` },
    });

    assert.equal(approveResponse.status, 200);

    const catalogResponse = await request("/admin/exercises/catalog", {
      headers: { Authorization: `Bearer ${signToken("admin", "admin-video-gate")}` },
    });
    const body = (await catalogResponse.json()) as { exercises?: Array<Record<string, unknown>> };

    assert.equal(catalogResponse.status, 200);
    assert.ok(body.exercises?.some((exercise) => exercise.id === "custom_catalog_valid"));
  });

  it("keeps a pending custom exercise out of the official catalog until approval", async () => {
    const createResponse = await request("/admin/exercises/custom", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("coach", "coach-video-gate")}`,
      },
      body: JSON.stringify(validCustomBody("custom_catalog_pending", "custom-catalog-pending.mp4")),
    });

    assert.equal(createResponse.status, 201);

    const catalogResponse = await request("/admin/exercises/catalog", {
      headers: { Authorization: `Bearer ${signToken("admin", "admin-video-gate")}` },
    });
    const body = (await catalogResponse.json()) as { exercises?: Array<Record<string, unknown>> };

    assert.equal(catalogResponse.status, 200);
    assert.equal(body.exercises?.some((exercise) => exercise.id === "custom_catalog_pending"), false);
  });

  it("lists the official exercise catalog for admin users", async () => {
    const response = await request("/admin/exercises/catalog", {
      headers: { Authorization: `Bearer ${signToken("admin", "admin-video-gate")}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { exercises?: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.exercises));
    assert.ok(body.exercises.length > 0);
    assert.equal(body.exercises[0]?.videoProvider, "local");
    assert.ok(String(body.exercises[0]?.videoUrl || "").startsWith("/exercise/visuals/"));
  });

  it("lists the official exercise catalog for coach users", async () => {
    const response = await request("/admin/exercises/catalog", {
      headers: { Authorization: `Bearer ${signToken("coach", "coach-video-gate")}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { exercises?: Array<Record<string, unknown>> };
    assert.ok(body.exercises?.some((exercise) => exercise.id === "supino_reto"));
  });

  it("blocks catalog listing without auth", async () => {
    const response = await request("/admin/exercises/catalog");

    assert.equal(response.status, 401);
  });

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

  it("accepts manual admin workout saves with a selected catalog id and normalizes media", async () => {
    const response = await request("/admin/students/student-video-gate/workout", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("admin", "admin-video-gate")}`,
      },
      body: JSON.stringify({
        workout: workoutPlan({
          id: "supino_reto",
          name: "Nome livre ignorado",
          sets: 4,
          reps: "8-10",
          rest: "90s",
          cue: "Controle.",
          note: "Sem pressa.",
        }),
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { workout?: { exercises?: Array<Record<string, unknown>> } };
    assert.equal(body.workout?.exercises?.[0]?.id, "supino_reto");
    assert.equal(body.workout?.exercises?.[0]?.name, "Supino reto");
    assert.equal(body.workout?.exercises?.[0]?.videoUrl, getCatalogById("supino_reto")?.videoUrl);
    assert.equal(body.workout?.exercises?.[0]?.videoProvider, "local");
  });

  it("rejects manual admin workout saves with free name and no catalog id", async () => {
    const response = await request("/admin/students/student-video-gate/workout", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("admin", "admin-video-gate")}`,
      },
      body: JSON.stringify({
        workout: workoutPlan({
          name: "Supino inventado pelo texto",
          sets: 3,
          reps: "10",
          rest: "60s",
          cue: "",
          note: "",
        }),
      }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "WORKOUT_EXERCISE_CATALOG_SELECTION_REQUIRED");
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
        imageBase64: validImageBase64,
        workoutFocus: "chest_triceps",
        workoutLabel: "Peito e tríceps",
        locationMode: "gym",
        language: "pt-BR",
        workoutPlan: workoutPlan({ ...catalogExercise(), id: "manual-ghost", videoUrl: "" }),
      }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "INVALID_WORKOUT_EXERCISE_CATALOG_ID");
  });

  it("keeps workout validation XP idempotent for the same GUTO day", async () => {
    writeFileSync(testMemoryFile, JSON.stringify({
      "student-video-gate": {
        userId: "student-video-gate",
        name: "Aluno",
        language: "pt-BR",
        totalXp: 0,
        streak: 0,
        trainedToday: false,
        completedWorkoutDates: [],
        adaptedMissionDates: [],
        missedMissionDates: [],
        xpEvents: [],
        proactiveSent: {},
        lastWorkoutPlan: workoutPlan(),
      },
    }, null, 2));

    const payload = {
      imageBase64: validImageBase64,
      workoutFocus: "chest_triceps",
      workoutLabel: "Peito e tríceps",
      locationMode: "gym",
      language: "pt-BR",
    };

    const first = await request("/guto/validate-workout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("student", "student-video-gate")}`,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(first.status, 200);

    const second = await request("/guto/validate-workout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("student", "student-video-gate")}`,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(second.status, 409);

    const store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
    const memory = store["student-video-gate"];
    assert.equal(memory.validationHistory.length, 1);
    assert.equal(memory.xpEvents.filter((event: any) => event.type === "complete_daily_mission").length, 1);
    assert.ok(memory.memoryAudit.some((entry: any) => entry.source === "workout_validation"));
  });

  it("rejects validate-workout without selfie (SELFIE_REQUIRED) and then accepts the selfie version", async () => {
    // Decisão do fundador (GUTO_EVOLUCAO_XP_E_MORTE_DETALHADA.md X-7 + GUTO_ONLINE_SESSAO_ASSISTIDA_DETALHADA.md O-7):
    // sem prova, sem mérito. Validação SEM imageBase64 retorna 400 SELFIE_REQUIRED e não cria registro.
    writeFileSync(testMemoryFile, JSON.stringify({
      "student-video-gate": {
        userId: "student-video-gate",
        name: "Aluno",
        language: "pt-BR",
        totalXp: 0,
        streak: 0,
        trainedToday: false,
        completedWorkoutDates: [],
        adaptedMissionDates: [],
        missedMissionDates: [],
        xpEvents: [],
        proactiveSent: {},
        lastWorkoutPlan: workoutPlan(),
      },
    }, null, 2));

    const basePayload = {
      workoutFocus: "chest_triceps",
      workoutLabel: "Peito e tríceps",
      locationMode: "gym",
      language: "pt-BR",
    };

    const rejected = await request("/guto/validate-workout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("student", "student-video-gate")}`,
      },
      body: JSON.stringify(basePayload),
    });
    assert.equal(rejected.status, 400);
    const rejectedBody = await rejected.json() as { error: string };
    assert.equal(rejectedBody.error, "SELFIE_REQUIRED");

    // Garantia: nada foi gravado (memória intacta).
    let store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
    let memory = store["student-video-gate"];
    assert.equal(memory.trainedToday, false);
    assert.deepEqual(memory.completedWorkoutDates, []);
    assert.equal((memory.validationHistory ?? []).length, 0);
    assert.equal(memory.xpEvents.filter((event: any) => event.type === "complete_daily_mission").length, 0);

    // Agora com a selfie: deve aceitar e creditar XP normalmente.
    const validated = await request("/guto/validate-workout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("student", "student-video-gate")}`,
      },
      body: JSON.stringify({ ...basePayload, imageBase64: validImageBase64 }),
    });
    assert.equal(validated.status, 200);
    const validatedBody = await validated.json() as { validation: { status: string; xp: number; gutoMessage: string } };
    assert.equal(validatedBody.validation.status, "validated");
    assert.equal(validatedBody.validation.xp, 100);

    // P0 — pós-validação fecha o ciclo de condução (doc: "nunca deixe o usuário
    // em decisão aberta; defina a próxima ação"). A mensagem deve (1) reconhecer
    // a conquista, (2) orientar recuperação e (3) apontar a próxima ação.
    const postMsg = validatedBody.validation.gutoMessage;
    assert.match(postMsg, /fechad|validad|conta/i, `pós-validação deve reconhecer a conquista: ${postMsg}`);
    assert.match(postMsg, /hidrat|água|prote[íi]na|recupera/i, `pós-validação deve orientar recuperação: ${postMsg}`);
    assert.match(postMsg, /amanh[ãa]|pr[óo]xim|te puxo/i, `pós-validação deve definir a próxima ação: ${postMsg}`);

    store = JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
    memory = store["student-video-gate"];
    assert.equal(memory.trainedToday, true);
    assert.equal(memory.validationHistory.length, 1);
    assert.equal(memory.xpEvents.filter((event: any) => event.type === "complete_daily_mission").length, 1);
  });
});
