import "./test-env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { V3CutoverService } from "../src/v3/cutover-service.js";
import { InMemoryOfficialStateRepository } from "../src/v3/in-memory-repository.js";
import { parseWorkoutValidationEvidence } from "../src/v3/workout-validation-evidence.js";
import { V3Error } from "../src/v3/errors.js";
import { rejectPublicSessionCompletion } from "../src/v3/router.js";
import type { ActorContext } from "../src/v3/types.js";

// ─── P0 WORKOUT VALIDATION AUTHORITY — FOUNDER GATE ───────────────────────
// ONE authority completes a session AND records XP atomically, requiring
// selfie evidence. Covers: evidence contract, exactly-once, cross-actor deny,
// stale context deny, readback persistence and rotation.

function fakeJpegBytes(size = 16384): Buffer {
  const bytes = Buffer.alloc(size);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xe0; // JPEG SOI/APP0
  return bytes;
}

function fakeDataUrl(mime: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg"): string {
  let header: Buffer;
  if (mime === "image/png") header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  else if (mime === "image/webp") header = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  else header = fakeJpegBytes(64).subarray(0, 4);
  const bytes = Buffer.alloc(Math.max(16384, header.length + 16), 0x42);
  header.copy(bytes);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function harness(externalSubject = `val-${randomUUID()}`, tenantKey = "GUTO_CORE"): Promise<{
  repository: InMemoryOfficialStateRepository;
  service: V3CutoverService;
  actor: ActorContext;
}> {
  const repository = new InMemoryOfficialStateRepository();
  const service = new V3CutoverService(repository);
  const actor = await repository.provisionActor({ externalSubject, role: "student", tenantKey, tenantName: tenantKey });
  await service.acceptConsent(actor, randomUUID());
  await repository.persistCalibration(actor, {
    requestId: randomUUID(),
    profile: { biologicalSex: "male", age: 33, weightKg: 80, heightCm: 181, trainingStatus: "returning", weeklyFrequencyDaysPerWeek: 4 },
    goal: { code: "muscle_gain" },
  });
  await service.saveMemory(actor, { requestId: randomUUID(), name: "Will", confirmedName: true, language: "pt-BR" });
  await service.saveMemory(actor, { requestId: randomUUID(), name: "Will", xpEvent: "grant_initial_xp" });
  await service.startFirstContact(actor, randomUUID());
  await service.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "food_restrictions", answer: "Sem restrições." });
  await service.respondFirstContact(actor, { requestId: randomUUID(), expectedStep: "training_limitations", answer: "Sem limitações." });
  await service.confirmFirstContact(actor, { requestId: randomUUID(), confirmed: true });
  return { repository, service, actor };
}

async function openSession(h: { repository: InMemoryOfficialStateRepository; actor: ActorContext }): Promise<string> {
  const state = await h.repository.loadOfficialSnapshot(h.actor);
  const wsid = randomUUID();
  await h.repository.recordWorkoutExerciseEvent({
    actor: h.actor,
    requestId: randomUUID(),
    event: {
      workoutSessionId: wsid,
      exerciseId: state.workout!.items[0]!.exerciseId,
      setsCompleted: state.workout!.items[0]!.sets ?? 3,
      repetitions: 10,
      completed: true,
      context: { source: "authority-test" },
    },
  });
  return wsid;
}

const evidence = (): { sha256: string; mime: "image/jpeg"; byteLength: number } => ({
  sha256: "a".repeat(64),
  mime: "image/jpeg",
  byteLength: 16384,
});

// ─── EVIDENCE CONTRACT (SELFIE PROOF) ─────────────────────────────────────

test("AUTHORITY_EVIDENCE: empty/absent evidence is rejected (V3_WORKOUT_VALIDATION_EVIDENCE_REQUIRED)", () => {
  for (const bad of ["", "   ", null, undefined]) {
    assert.throws(
      () => parseWorkoutValidationEvidence(bad),
      (error: unknown) => (error as { code?: string }).code === "V3_WORKOUT_VALIDATION_EVIDENCE_REQUIRED",
    );
  }
});

test("AUTHORITY_EVIDENCE: invalid payload is rejected (V3_WORKOUT_VALIDATION_EVIDENCE_INVALID)", () => {
  for (const bad of [
    "not-a-data-url",
    "data:image/jpeg;base64,AAAA",
    "data:image/gif;base64," + Buffer.alloc(32).toString("base64"),
    "data:image/jpeg;base64," + Buffer.alloc(4096, 0x00).toString("base64"), // no JPEG magic
    "data:image/jpeg;base64," + fakeJpegBytes(4096).toString("base64"), // too small
  ]) {
    assert.throws(
      () => parseWorkoutValidationEvidence(bad),
      (error: unknown) => (error as { code?: string }).code === "V3_WORKOUT_VALIDATION_EVIDENCE_INVALID",
      `expected invalid: ${bad.slice(0, 40)}`,
    );
  }
});

test("AUTHORITY_EVIDENCE: valid camera payload passes, returns sha256/mime/byteLength only", () => {
  for (const mime of ["image/jpeg", "image/png", "image/webp"] as const) {
    const parsed = parseWorkoutValidationEvidence(fakeDataUrl(mime));
    assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
    assert.equal(parsed.mime, mime);
    assert.ok(parsed.byteLength >= 16384);
  }
});

// ─── AUTHORITY SEMANTICS (IN-MEMORY MIRROR) ───────────────────────────────

test("TEST1+TEST2: without evidence the authority rejects; with evidence session completes, XP exactly once, rotation +1", async () => {
  const h = await harness();
  const wsid = await openSession(h);
  const before = await h.repository.loadOfficialSnapshot(h.actor);
  assert.equal(before.nextSessionIndex, 0, "new user starts at index 0");
  // evidence requirement lives in the router/parser; repository contract rejects malformed
  const outcome = await h.repository.validateAndCompleteWorkoutSession({
    actor: h.actor,
    requestId: randomUUID(),
    workoutSessionId: wsid,
    evidence: evidence(),
  });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.xpGranted, true);
  assert.equal(outcome.xpAmount, 100, "fresh validation grants the real 100 XP amount");
  assert.equal(outcome.nextSessionIndex, 1);
  const after = await h.repository.loadOfficialSnapshot(h.actor);
  assert.equal(after.nextSessionIndex, 1, "one completion = one rotation");
  const xp = (await h.repository.loadAppState(h.actor)).progression.xpEvents.filter(
    (event) => event.reasonCode === "complete_daily_mission",
  );
  assert.equal(xp.length, 1, "XP exactly once");
});

test("TEST3: same requestId replay → XP once, rotation once", async () => {
  const h = await harness();
  const wsid = await openSession(h);
  const reqId = randomUUID();
  await h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: reqId, workoutSessionId: wsid, evidence: evidence() });
  const replay = await h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: reqId, workoutSessionId: wsid, evidence: evidence() });
  assert.equal(replay.xpGranted, false);
  assert.equal(replay.xpAmount, 0, "replay exposes xpAmount 0 — never an assumed 100");
  assert.equal((await h.repository.loadOfficialSnapshot(h.actor)).nextSessionIndex, 1);
  const xp = (await h.repository.loadAppState(h.actor)).progression.xpEvents.filter((event) => event.reasonCode === "complete_daily_mission");
  assert.equal(xp.length, 1, "replay does not grant a second XP");
});

test("TEST4: different requestId same session → XP once, rotation once", async () => {
  const h = await harness();
  const wsid = await openSession(h);
  await h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() });
  const second = await h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() });
  assert.equal(second.xpGranted, false);
  assert.equal(second.xpAmount, 0, "different requestId replay exposes xpAmount 0");
  assert.equal((await h.repository.loadOfficialSnapshot(h.actor)).nextSessionIndex, 1);
  const xp = (await h.repository.loadAppState(h.actor)).progression.xpEvents.filter((event) => event.reasonCode === "complete_daily_mission");
  assert.equal(xp.length, 1, "second requestId does not grant a second XP");
});

test("TEST5+TEST6: user A cannot validate user/session of user B (foreign + tenant)", async () => {
  const a = await harness("val-a");
  const b = await harness("val-b");
  const wsidA = await openSession(a);
  const foreignCode = (error: unknown) => ["V3_WORKOUT_SESSION_NOT_FOUND", "V3_FOREIGN_WORKOUT_SESSION"].includes((error as { code?: string }).code ?? "");
  await assert.rejects(
    () => b.repository.validateAndCompleteWorkoutSession({ actor: b.actor, requestId: randomUUID(), workoutSessionId: wsidA, evidence: evidence() }),
    foreignCode,
    "cross-user validation denied",
  );
  const crossTenant = await harness("val-c", "OTHER_TENANT");
  await assert.rejects(
    () => crossTenant.repository.validateAndCompleteWorkoutSession({ actor: crossTenant.actor, requestId: randomUUID(), workoutSessionId: wsidA, evidence: evidence() }),
    foreignCode,
    "cross-tenant validation denied",
  );
  assert.equal((await a.repository.loadOfficialSnapshot(a.actor)).nextSessionIndex, 0, "A's rotation untouched");
});

test("TEST7: random session id → deny without mutation", async () => {
  const h = await harness();
  await assert.rejects(
    () => h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: randomUUID(), workoutSessionId: randomUUID(), evidence: evidence() }),
    (error: unknown) => (error as { code?: string }).code === "V3_WORKOUT_SESSION_NOT_FOUND",
  );
  assert.equal((await h.repository.loadOfficialSnapshot(h.actor)).nextSessionIndex, 0);
});

test("TEST8: stale context blocks validation (V3_CONTEXT_RECONFIRMATION_REQUIRED)", async () => {
  const h = await harness();
  const wsid = await openSession(h);
  // profile advances → confirmed context becomes stale
  await h.repository.persistCalibration(h.actor, {
    requestId: randomUUID(),
    profile: { biologicalSex: "male", age: 33, weightKg: 75, heightCm: 181, trainingStatus: "returning", weeklyFrequencyDaysPerWeek: 4 },
    goal: { code: "muscle_gain" },
  });
  await assert.rejects(
    () => h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() }),
    (error: unknown) => (error as { code?: string }).code === "V3_CONTEXT_RECONFIRMATION_REQUIRED",
  );
  assert.equal((await h.repository.loadOfficialSnapshot(h.actor)).nextSessionIndex, 0, "stale validation does not complete");
  const xp = (await h.repository.loadAppState(h.actor)).progression.xpEvents.filter((event) => event.reasonCode === "complete_daily_mission");
  assert.equal(xp.length, 0, "no XP on stale validation");
});

test("TEST9: readback persists completion, XP and rotation (reload)", async () => {
  const h = await harness();
  const wsid = await openSession(h);
  await h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() });
  // simulated reload: same actor reads fresh state
  const snapshot = await h.repository.loadOfficialSnapshot(h.actor);
  assert.equal(snapshot.nextSessionIndex, 1);
  assert.equal((await h.repository.loadAppState(h.actor)).progression.trainedToday, true);
});

test("TEST10: next session index advances exactly once per completed session", async () => {
  const h = await harness();
  const first = await openSession(h);
  await h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: randomUUID(), workoutSessionId: first, evidence: evidence() });
  assert.equal((await h.repository.loadOfficialSnapshot(h.actor)).nextSessionIndex, 1);
  const second = await openSession(h);
  await h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: randomUUID(), workoutSessionId: second, evidence: evidence() });
  assert.equal((await h.repository.loadOfficialSnapshot(h.actor)).nextSessionIndex, 2);
});

test("AUTHORITY_SERVICE: bare complete_daily_mission memory mutation is blocked in the service too", async () => {
  const h = await harness();
  await assert.rejects(
    () => h.service.saveMemory(h.actor, { requestId: randomUUID(), name: "Will", xpEvent: "complete_daily_mission" }),
    (error: unknown) => (error as { code?: string }).code === "V3_WORKOUT_VALIDATION_REQUIRED",
  );
});

// ─── PUBLIC SESSION-COMPLETE BYPASS: CLOSED (route level) ───────────────────

test("PUBLIC_BYPASS: POST /workout/sessions/complete is rejected 409 and only /workout/validate completes", async () => {
  const h = await harness();
  const wsid = await openSession(h);
  const body = { requestId: randomUUID(), workoutSessionId: wsid };
  // The route handler parses the contract and then rejects — the public HTTP
  // path never reaches completeWorkoutSession().
  assert.throws(
    () => rejectPublicSessionCompletion(body),
    (error: unknown) => error instanceof V3Error && error.status === 409 && error.code === "V3_WORKOUT_VALIDATION_REQUIRED",
  );
  // Readback: the session stays open, XP unchanged, rotation unchanged.
  const xpBefore = (await h.repository.loadAppState(h.actor)).progression.xpEvents.filter((e) => e.reasonCode === "complete_daily_mission");
  assert.equal(xpBefore.length, 0);
  assert.equal((await h.repository.loadOfficialSnapshot(h.actor)).nextSessionIndex, 0);
  // The ONLY public authority that may complete it is /workout/validate.
  const outcome = await h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.xpGranted, true);
  assert.equal(outcome.nextSessionIndex, 1);
});

test("PUBLIC_BYPASS: the sessions/complete route no longer invokes the repository completion primitive", () => {
  const router = readFileSync(new URL("../src/v3/router.ts", import.meta.url), "utf8");
  const route = router.slice(
    router.indexOf('router.post("/guto/v3/workout/sessions/complete"'),
    router.indexOf('router.post("/guto/v3/workout/validate"'),
  );
  assert.match(route, /rejectPublicSessionCompletion\(req\.body\)/);
  assert.doesNotMatch(route, /\.completeWorkoutSession\(/);
  assert.doesNotMatch(route, /getV3Runtime\(\)\.repository\.completeWorkoutSession/);
});

// ─── XP AMOUNT AUTHORITY (adapted mission day) ──────────────────────────────

test("XP_AMOUNT: adapted mission day validates at +50 (not an assumed 100)", async () => {
  const h = await harness();
  // Accept the adapted mission on the SAME official day before validating.
  await h.service.saveMemory(h.actor, { requestId: randomUUID(), xpEvent: "accept_adapted_mission" });
  const wsid = await openSession(h);
  const outcome = await h.repository.validateAndCompleteWorkoutSession({ actor: h.actor, requestId: randomUUID(), workoutSessionId: wsid, evidence: evidence() });
  assert.equal(outcome.xpGranted, true);
  assert.equal(outcome.xpAmount, 50, "adapted mission day grants 50, not 100");
  const ledger = (await h.repository.loadAppState(h.actor)).progression.xpEvents.filter((e) => e.reasonCode === "complete_daily_mission");
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.amount, 50, "ledger row holds the real 50");
});
