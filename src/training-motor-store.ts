import { randomUUID } from "node:crypto";

import {
  readPersistedUserMemorySnapshot,
  updateUserMemoryAtomically,
} from "./memory-store.js";

export type OfficialSessionOrigin = "prescribed" | "adapted";
export type TrainingEnvironmentMode = "gym" | "home" | "park" | "other";
export type ResistanceGuidance = "autoregulated" | "bodyweight" | "not_applicable";
export type ExecutionFinalState = "completed" | "partial" | "interrupted" | "abandoned";
export type SessionFeedbackValue = "easy" | "normal" | "heavy" | "observation";

export interface OfficialSessionExercise {
  id: string;
  name: string;
  sets: number;
  repetitions: string;
  resistanceGuidance: ResistanceGuidance;
  restSeconds: number;
}

export interface OfficialSession {
  sessionId: string;
  userId: string;
  date: string;
  plannedWorkout: {
    planId?: string;
    title: string;
    purpose: string;
    expectedDurationMinutes: number;
  };
  environment: {
    mode: TrainingEnvironmentMode;
    description?: string;
    equipment: string[];
  };
  exercises: OfficialSessionExercise[];
  appliedRestrictions: string[];
  origin: OfficialSessionOrigin;
  previousVersion?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastOperationId: string;
}

export interface PerformedExercise {
  exerciseId: string;
  completedSets: number;
}

export interface ExerciseSubstitution {
  originalExerciseId: string;
  replacementExerciseId: string;
  reason: string;
  occurredAt: string;
}

export interface ExecutionLog {
  executionLogId: string;
  userId: string;
  sessionId: string;
  officialSessionVersion: number;
  startedAt: string;
  endedAt?: string;
  performedExercises: PerformedExercise[];
  skippedExerciseIds: string[];
  substitutions: ExerciseSubstitution[];
  durationSeconds: number;
  finalState: ExecutionFinalState | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastOperationId: string;
}

export interface SessionFeedbackCorrection {
  correctionId: string;
  previousValue: SessionFeedbackValue;
  newValue: SessionFeedbackValue;
  rawStatement: string;
  createdAt: string;
  operationId: string;
}

export interface SessionFeedback {
  feedbackId: string;
  userId: string;
  sessionId: string;
  selectedValue: SessionFeedbackValue;
  effectiveValue: SessionFeedbackValue;
  observation?: string;
  submittedAt: string;
  source: "card" | "chat_correction";
  corrections: SessionFeedbackCorrection[];
  version: number;
  createdAt: string;
  updatedAt: string;
  lastOperationId: string;
}

export type TrainingHistoryEventType =
  | "official_session_created"
  | "official_session_adapted"
  | "execution_log_saved"
  | "session_feedback_saved"
  | "session_feedback_corrected"
  | "correction";

export interface TrainingHistoryCorrection {
  targetEventId: string;
  reason: string;
  correctedData: Record<string, unknown>;
}

export interface TrainingHistoryEvent {
  eventId: string;
  sequence: number;
  userId: string;
  sessionId: string;
  eventType: TrainingHistoryEventType;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  operationId: string;
  snapshot: OfficialSession | ExecutionLog | SessionFeedback | TrainingHistoryCorrection;
}

export interface TrainingHistory {
  userId: string;
  version: number;
  events: TrainingHistoryEvent[];
  createdAt?: string;
  updatedAt?: string;
  lastOperationId?: string;
}

export interface TrainingMotorState {
  officialSessions: OfficialSession[];
  executionLogs: ExecutionLog[];
  sessionFeedbacks: SessionFeedback[];
  trainingHistory: TrainingHistory;
}

export class TrainingMotorStoreError extends Error {
  constructor(
    public readonly code:
      | "USER_NOT_FOUND"
      | "INVALID_INPUT"
      | "VERSION_CONFLICT"
      | "OPERATION_ID_REUSED"
      | "OFFICIAL_SESSION_NOT_FOUND"
      | "EXECUTION_LOG_NOT_FOUND"
      | "HISTORY_EVENT_NOT_FOUND"
      | "CORRUPT_TRAINING_STATE"
      | "COMMIT_NOT_CONFIRMED",
    message: string
  ) {
    super(message);
    this.name = "TrainingMotorStoreError";
  }
}

type OfficialSessionDraft = Omit<
  OfficialSession,
  "userId" | "version" | "previousVersion" | "createdAt" | "updatedAt" | "lastOperationId"
>;

type ExecutionLogDraft = Omit<
  ExecutionLog,
  "userId" | "version" | "createdAt" | "updatedAt" | "lastOperationId"
>;

type SessionFeedbackDraft = {
  feedbackId: string;
  sessionId: string;
  value: SessionFeedbackValue;
  observation?: string;
  submittedAt: string;
  source: "card" | "chat_correction";
};

export interface VersionedCommand {
  userId: string;
  expectedVersion: number;
  operationId: string;
}

export interface SaveOfficialSessionCommand extends VersionedCommand {
  session: OfficialSessionDraft;
}

export interface SaveExecutionLogCommand extends VersionedCommand {
  executionLog: ExecutionLogDraft;
}

export interface SaveSessionFeedbackCommand extends VersionedCommand {
  feedback: SessionFeedbackDraft;
  correction?: {
    rawStatement: string;
  };
}

export interface AppendTrainingHistoryCorrectionCommand extends VersionedCommand {
  sessionId: string;
  targetEventId: string;
  reason: string;
  correctedData: Record<string, unknown>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new TrainingMotorStoreError("INVALID_INPUT", `${field} is required.`);
  }
  return text;
}

function requireIsoDate(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new TrainingMotorStoreError("INVALID_INPUT", `${field} must be an ISO date.`);
  }
  return text;
}

function requireDay(value: unknown): string {
  const text = requireText(value, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "date must use YYYY-MM-DD.");
  }
  return text;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new TrainingMotorStoreError("INVALID_INPUT", `${field} must be a non-negative integer.`);
  }
  return Number(value);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new TrainingMotorStoreError("INVALID_INPUT", `${field} must be a positive integer.`);
  }
  return Number(value);
}

function requireVersion(value: unknown): number {
  return requireNonNegativeInteger(value, "expectedVersion");
}

function requireStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new TrainingMotorStoreError("INVALID_INPUT", `${field} must be an array.`);
  }
  return value.map((item, index) => requireText(item, `${field}[${index}]`));
}

function emptyState(userId: string): TrainingMotorState {
  return {
    officialSessions: [],
    executionLogs: [],
    sessionFeedbacks: [],
    trainingHistory: {
      userId,
      version: 0,
      events: [],
    },
  };
}

function readArrayField<T>(
  memory: Record<string, unknown>,
  field: "officialSessions" | "executionLogs" | "sessionFeedbacks"
): T[] {
  const value = memory[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TrainingMotorStoreError("CORRUPT_TRAINING_STATE", `${field} is not an array.`);
  }
  return clone(value as T[]);
}

function readTrainingHistory(memory: Record<string, unknown>, userId: string): TrainingHistory {
  const value = memory.trainingHistory;
  if (value === undefined) return emptyState(userId).trainingHistory;
  if (!isRecord(value) || !Array.isArray(value.events) || !Number.isInteger(value.version)) {
    throw new TrainingMotorStoreError("CORRUPT_TRAINING_STATE", "trainingHistory is invalid.");
  }
  if (value.userId !== userId || value.version !== value.events.length) {
    throw new TrainingMotorStoreError("CORRUPT_TRAINING_STATE", "trainingHistory sequence is inconsistent.");
  }
  return clone(value as unknown as TrainingHistory);
}

function stateFromMemory(memory: Record<string, unknown>, userId: string): TrainingMotorState {
  return {
    officialSessions: readArrayField<OfficialSession>(memory, "officialSessions"),
    executionLogs: readArrayField<ExecutionLog>(memory, "executionLogs"),
    sessionFeedbacks: readArrayField<SessionFeedback>(memory, "sessionFeedbacks"),
    trainingHistory: readTrainingHistory(memory, userId),
  };
}

function statePatch(state: TrainingMotorState): Record<string, unknown> {
  return {
    officialSessions: clone(state.officialSessions),
    executionLogs: clone(state.executionLogs),
    sessionFeedbacks: clone(state.sessionFeedbacks),
    trainingHistory: clone(state.trainingHistory),
  };
}

function assertUserMemory(value: unknown, userId: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TrainingMotorStoreError("USER_NOT_FOUND", `GUTO user ${userId} does not exist.`);
  }
  return value;
}

function existingOperation(
  history: TrainingHistory,
  operationId: string,
  eventTypes: TrainingHistoryEventType[],
  aggregateId: string
): TrainingHistoryEvent | null {
  const event = history.events.find((item) => item.operationId === operationId);
  if (!event) return null;
  if (!eventTypes.includes(event.eventType) || event.aggregateId !== aggregateId) {
    throw new TrainingMotorStoreError(
      "OPERATION_ID_REUSED",
      `operationId ${operationId} was already used by another mutation.`
    );
  }
  return event;
}

function appendHistoryEvent(
  state: TrainingMotorState,
  input: Omit<TrainingHistoryEvent, "eventId" | "sequence">
): TrainingHistoryEvent {
  const event: TrainingHistoryEvent = {
    ...clone(input),
    eventId: randomUUID(),
    sequence: state.trainingHistory.version + 1,
  };
  const createdAt = state.trainingHistory.createdAt || event.occurredAt;
  state.trainingHistory = {
    userId: input.userId,
    version: event.sequence,
    events: [...state.trainingHistory.events, event],
    createdAt,
    updatedAt: event.occurredAt,
    lastOperationId: input.operationId,
  };
  return event;
}

function assertNoDuplicateIds(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new TrainingMotorStoreError("INVALID_INPUT", `${field} contains duplicate IDs.`);
  }
}

function sanitizeOfficialSessionDraft(draft: OfficialSessionDraft): OfficialSessionDraft {
  const origin = draft.origin;
  if (origin !== "prescribed" && origin !== "adapted") {
    throw new TrainingMotorStoreError("INVALID_INPUT", "origin must be prescribed or adapted.");
  }
  const mode = draft.environment?.mode;
  if (!["gym", "home", "park", "other"].includes(mode)) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "environment.mode is invalid.");
  }
  if (!Array.isArray(draft.exercises) || draft.exercises.length === 0) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "exercises must contain at least one exercise.");
  }

  const exercises = draft.exercises.map((exercise, index): OfficialSessionExercise => {
    const resistanceGuidance = exercise.resistanceGuidance;
    if (!["autoregulated", "bodyweight", "not_applicable"].includes(resistanceGuidance)) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        `exercises[${index}].resistanceGuidance is invalid.`
      );
    }
    return {
      id: requireText(exercise.id, `exercises[${index}].id`),
      name: requireText(exercise.name, `exercises[${index}].name`),
      sets: requirePositiveInteger(exercise.sets, `exercises[${index}].sets`),
      repetitions: requireText(exercise.repetitions, `exercises[${index}].repetitions`),
      resistanceGuidance,
      restSeconds: requireNonNegativeInteger(
        exercise.restSeconds,
        `exercises[${index}].restSeconds`
      ),
    };
  });
  assertNoDuplicateIds(exercises.map((exercise) => exercise.id), "exercises");

  return {
    sessionId: requireText(draft.sessionId, "sessionId"),
    date: requireDay(draft.date),
    plannedWorkout: {
      planId: draft.plannedWorkout?.planId
        ? requireText(draft.plannedWorkout.planId, "plannedWorkout.planId")
        : undefined,
      title: requireText(draft.plannedWorkout?.title, "plannedWorkout.title"),
      purpose: requireText(draft.plannedWorkout?.purpose, "plannedWorkout.purpose"),
      expectedDurationMinutes: requirePositiveInteger(
        draft.plannedWorkout?.expectedDurationMinutes,
        "plannedWorkout.expectedDurationMinutes"
      ),
    },
    environment: {
      mode,
      description: draft.environment?.description
        ? requireText(draft.environment.description, "environment.description")
        : undefined,
      equipment: requireStringList(draft.environment?.equipment, "environment.equipment"),
    },
    exercises,
    appliedRestrictions: requireStringList(draft.appliedRestrictions, "appliedRestrictions"),
    origin,
  };
}

function sanitizeExecutionLogDraft(
  draft: ExecutionLogDraft,
  officialSession: OfficialSession
): ExecutionLogDraft {
  const finalState = draft.finalState;
  if (
    finalState !== null &&
    !["completed", "partial", "interrupted", "abandoned"].includes(finalState)
  ) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "finalState is invalid.");
  }
  const endedAt = draft.endedAt ? requireIsoDate(draft.endedAt, "endedAt") : undefined;
  const startedAt = requireIsoDate(draft.startedAt, "startedAt");
  if (finalState !== null && !endedAt) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "endedAt is required for a finalized execution.");
  }
  if (finalState === null && endedAt) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "endedAt requires a finalState.");
  }
  if (endedAt && Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "endedAt cannot precede startedAt.");
  }
  if (draft.officialSessionVersion !== officialSession.version) {
    throw new TrainingMotorStoreError(
      "VERSION_CONFLICT",
      `Official session is at version ${officialSession.version}, not ${draft.officialSessionVersion}.`
    );
  }
  if (!Array.isArray(draft.performedExercises) || !Array.isArray(draft.substitutions)) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "Execution collections must be arrays.");
  }

  const substitutions = draft.substitutions.map((substitution, index): ExerciseSubstitution => ({
    originalExerciseId: requireText(
      substitution.originalExerciseId,
      `substitutions[${index}].originalExerciseId`
    ),
    replacementExerciseId: requireText(
      substitution.replacementExerciseId,
      `substitutions[${index}].replacementExerciseId`
    ),
    reason: requireText(substitution.reason, `substitutions[${index}].reason`),
    occurredAt: requireIsoDate(substitution.occurredAt, `substitutions[${index}].occurredAt`),
  }));
  const officialIds = new Set(officialSession.exercises.map((exercise) => exercise.id));
  for (const substitution of substitutions) {
    if (!officialIds.has(substitution.originalExerciseId)) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        `Substitution original ${substitution.originalExerciseId} is not in the official session.`
      );
    }
    if (substitution.originalExerciseId === substitution.replacementExerciseId) {
      throw new TrainingMotorStoreError("INVALID_INPUT", "A substitution must change the exercise.");
    }
  }
  const executableIds = new Set([
    ...officialIds,
    ...substitutions.map((substitution) => substitution.replacementExerciseId),
  ]);
  const performedExercises = draft.performedExercises.map((exercise, index): PerformedExercise => {
    const exerciseId = requireText(exercise.exerciseId, `performedExercises[${index}].exerciseId`);
    if (!executableIds.has(exerciseId)) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        `Performed exercise ${exerciseId} does not belong to this execution.`
      );
    }
    return {
      exerciseId,
      completedSets: requireNonNegativeInteger(
        exercise.completedSets,
        `performedExercises[${index}].completedSets`
      ),
    };
  });
  assertNoDuplicateIds(
    performedExercises.map((exercise) => exercise.exerciseId),
    "performedExercises"
  );
  const skippedExerciseIds = requireStringList(
    draft.skippedExerciseIds,
    "skippedExerciseIds"
  );
  assertNoDuplicateIds(skippedExerciseIds, "skippedExerciseIds");
  for (const exerciseId of skippedExerciseIds) {
    if (!officialIds.has(exerciseId)) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        `Skipped exercise ${exerciseId} is not in the official session.`
      );
    }
  }

  return {
    executionLogId: requireText(draft.executionLogId, "executionLogId"),
    sessionId: officialSession.sessionId,
    officialSessionVersion: draft.officialSessionVersion,
    startedAt,
    endedAt,
    performedExercises,
    skippedExerciseIds,
    substitutions,
    durationSeconds: requireNonNegativeInteger(draft.durationSeconds, "durationSeconds"),
    finalState,
  };
}

function sanitizeFeedbackDraft(draft: SessionFeedbackDraft): SessionFeedbackDraft {
  if (!["easy", "normal", "heavy", "observation"].includes(draft.value)) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "Feedback value is invalid.");
  }
  const observation = draft.observation?.trim();
  if (draft.value === "observation" && !observation) {
    throw new TrainingMotorStoreError(
      "INVALID_INPUT",
      "An observation feedback requires observation text."
    );
  }
  if (draft.value !== "observation" && observation) {
    throw new TrainingMotorStoreError(
      "INVALID_INPUT",
      "Observation text is only allowed for observation feedback."
    );
  }
  if (!["card", "chat_correction"].includes(draft.source)) {
    throw new TrainingMotorStoreError("INVALID_INPUT", "Feedback source is invalid.");
  }
  return {
    feedbackId: requireText(draft.feedbackId, "feedbackId"),
    sessionId: requireText(draft.sessionId, "sessionId"),
    value: draft.value,
    observation,
    submittedAt: requireIsoDate(draft.submittedAt, "submittedAt"),
    source: draft.source,
  };
}

async function confirmEvent<T>(
  userId: string,
  operationId: string,
  eventTypes: TrainingHistoryEventType[],
  select: (event: TrainingHistoryEvent) => T | null
): Promise<T> {
  const confirmed = await readTrainingMotorState(userId);
  const event = confirmed.trainingHistory.events.find(
    (item) => item.operationId === operationId && eventTypes.includes(item.eventType)
  );
  const value = event ? select(event) : null;
  if (!value) {
    throw new TrainingMotorStoreError(
      "COMMIT_NOT_CONFIRMED",
      `Training mutation ${operationId} was not confirmed after persistence.`
    );
  }
  return clone(value);
}

export async function readTrainingMotorState(userId: string): Promise<TrainingMotorState> {
  const normalizedUserId = requireText(userId, "userId");
  const snapshot = await readPersistedUserMemorySnapshot(normalizedUserId);
  const memory = assertUserMemory(snapshot, normalizedUserId);
  return stateFromMemory(memory, normalizedUserId);
}

export async function saveOfficialSession(
  command: SaveOfficialSessionCommand
): Promise<OfficialSession> {
  const userId = requireText(command.userId, "userId");
  const operationId = requireText(command.operationId, "operationId");
  const expectedVersion = requireVersion(command.expectedVersion);
  const draft = sanitizeOfficialSessionDraft(command.session);

  await updateUserMemoryAtomically<Record<string, unknown>>(userId, (snapshot) => {
    const memory = assertUserMemory(snapshot, userId);
    const state = stateFromMemory(memory, userId);
    const duplicate = existingOperation(
      state.trainingHistory,
      operationId,
      ["official_session_created", "official_session_adapted"],
      draft.sessionId
    );
    if (duplicate) return memory;

    const index = state.officialSessions.findIndex(
      (session) => session.sessionId === draft.sessionId
    );
    const current = index >= 0 ? state.officialSessions[index] : null;
    const currentVersion = current?.version || 0;
    if (currentVersion !== expectedVersion) {
      throw new TrainingMotorStoreError(
        "VERSION_CONFLICT",
        `Official session is at version ${currentVersion}, not ${expectedVersion}.`
      );
    }
    if (current && draft.origin !== "adapted") {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "An existing official session can only receive an adapted version."
      );
    }

    const now = new Date().toISOString();
    const officialSession: OfficialSession = {
      ...draft,
      userId,
      previousVersion: current?.version,
      version: currentVersion + 1,
      createdAt: current?.createdAt || now,
      updatedAt: now,
      lastOperationId: operationId,
    };
    if (index >= 0) state.officialSessions[index] = officialSession;
    else state.officialSessions.push(officialSession);
    appendHistoryEvent(state, {
      userId,
      sessionId: officialSession.sessionId,
      eventType: current ? "official_session_adapted" : "official_session_created",
      aggregateId: officialSession.sessionId,
      aggregateVersion: officialSession.version,
      occurredAt: now,
      operationId,
      snapshot: officialSession,
    });
    return { ...memory, ...statePatch(state) };
  });

  return confirmEvent(userId, operationId, [
    "official_session_created",
    "official_session_adapted",
  ], (event) => event.snapshot as OfficialSession);
}

export async function saveExecutionLog(
  command: SaveExecutionLogCommand
): Promise<ExecutionLog> {
  const userId = requireText(command.userId, "userId");
  const operationId = requireText(command.operationId, "operationId");
  const expectedVersion = requireVersion(command.expectedVersion);

  await updateUserMemoryAtomically<Record<string, unknown>>(userId, (snapshot) => {
    const memory = assertUserMemory(snapshot, userId);
    const state = stateFromMemory(memory, userId);
    const executionLogId = requireText(
      command.executionLog.executionLogId,
      "executionLogId"
    );
    const duplicate = existingOperation(
      state.trainingHistory,
      operationId,
      ["execution_log_saved"],
      executionLogId
    );
    if (duplicate) return memory;

    const officialSession = state.officialSessions.find(
      (session) => session.sessionId === command.executionLog.sessionId
    );
    if (!officialSession) {
      throw new TrainingMotorStoreError(
        "OFFICIAL_SESSION_NOT_FOUND",
        `Official session ${command.executionLog.sessionId} does not exist.`
      );
    }
    const draft = sanitizeExecutionLogDraft(command.executionLog, officialSession);
    const index = state.executionLogs.findIndex(
      (executionLog) => executionLog.executionLogId === executionLogId
    );
    const current = index >= 0 ? state.executionLogs[index] : null;
    const currentVersion = current?.version || 0;
    if (currentVersion !== expectedVersion) {
      throw new TrainingMotorStoreError(
        "VERSION_CONFLICT",
        `Execution log is at version ${currentVersion}, not ${expectedVersion}.`
      );
    }
    if (current && current.sessionId !== draft.sessionId) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "An execution log cannot move to another session."
      );
    }
    if (
      state.executionLogs.some(
        (executionLog) =>
          executionLog.sessionId === draft.sessionId &&
          executionLog.executionLogId !== executionLogId
      )
    ) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "A session can have only one official execution log."
      );
    }
    if (current?.finalState !== null && current?.finalState !== undefined) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "A finalized execution log can only be corrected through a history event."
      );
    }

    const now = new Date().toISOString();
    const executionLog: ExecutionLog = {
      ...draft,
      userId,
      version: currentVersion + 1,
      createdAt: current?.createdAt || now,
      updatedAt: now,
      lastOperationId: operationId,
    };
    if (index >= 0) state.executionLogs[index] = executionLog;
    else state.executionLogs.push(executionLog);
    appendHistoryEvent(state, {
      userId,
      sessionId: executionLog.sessionId,
      eventType: "execution_log_saved",
      aggregateId: executionLog.executionLogId,
      aggregateVersion: executionLog.version,
      occurredAt: now,
      operationId,
      snapshot: executionLog,
    });
    return { ...memory, ...statePatch(state) };
  });

  return confirmEvent(userId, operationId, ["execution_log_saved"], (event) =>
    event.snapshot as ExecutionLog
  );
}

export async function saveSessionFeedback(
  command: SaveSessionFeedbackCommand
): Promise<SessionFeedback> {
  const userId = requireText(command.userId, "userId");
  const operationId = requireText(command.operationId, "operationId");
  const expectedVersion = requireVersion(command.expectedVersion);
  const draft = sanitizeFeedbackDraft(command.feedback);

  await updateUserMemoryAtomically<Record<string, unknown>>(userId, (snapshot) => {
    const memory = assertUserMemory(snapshot, userId);
    const state = stateFromMemory(memory, userId);
    const duplicate = existingOperation(
      state.trainingHistory,
      operationId,
      ["session_feedback_saved", "session_feedback_corrected"],
      draft.feedbackId
    );
    if (duplicate) return memory;

    const officialSession = state.officialSessions.find(
      (session) => session.sessionId === draft.sessionId
    );
    if (!officialSession) {
      throw new TrainingMotorStoreError(
        "OFFICIAL_SESSION_NOT_FOUND",
        `Official session ${draft.sessionId} does not exist.`
      );
    }
    const executionLog = state.executionLogs.find(
      (log) => log.sessionId === draft.sessionId && log.finalState !== null
    );
    if (!executionLog) {
      throw new TrainingMotorStoreError(
        "EXECUTION_LOG_NOT_FOUND",
        `Session ${draft.sessionId} has no finalized execution log.`
      );
    }

    const index = state.sessionFeedbacks.findIndex(
      (feedback) => feedback.feedbackId === draft.feedbackId
    );
    const current = index >= 0 ? state.sessionFeedbacks[index] : null;
    const currentVersion = current?.version || 0;
    if (currentVersion !== expectedVersion) {
      throw new TrainingMotorStoreError(
        "VERSION_CONFLICT",
        `Session feedback is at version ${currentVersion}, not ${expectedVersion}.`
      );
    }
    if (current && current.sessionId !== draft.sessionId) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "Session feedback cannot move to another session."
      );
    }
    if (
      state.sessionFeedbacks.some(
        (feedback) =>
          feedback.sessionId === draft.sessionId &&
          feedback.feedbackId !== draft.feedbackId
      )
    ) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "A session can have only one official feedback aggregate."
      );
    }
    if (current && !command.correction) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "Updating session feedback requires correction metadata."
      );
    }
    if (!current && command.correction) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "Initial session feedback cannot be marked as a correction."
      );
    }
    if (current && draft.source !== "chat_correction") {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "A feedback correction must use chat_correction as its source."
      );
    }

    const now = new Date().toISOString();
    const correction: SessionFeedbackCorrection | null = current
      ? {
          correctionId: randomUUID(),
          previousValue: current.effectiveValue,
          newValue: draft.value,
          rawStatement: requireText(
            command.correction?.rawStatement,
            "correction.rawStatement"
          ),
          createdAt: now,
          operationId,
        }
      : null;
    const feedback: SessionFeedback = {
      feedbackId: draft.feedbackId,
      userId,
      sessionId: draft.sessionId,
      selectedValue: current?.selectedValue || draft.value,
      effectiveValue: draft.value,
      observation: draft.observation,
      submittedAt: current?.submittedAt || draft.submittedAt,
      source: draft.source,
      corrections: correction
        ? [...current!.corrections, correction]
        : [],
      version: currentVersion + 1,
      createdAt: current?.createdAt || now,
      updatedAt: now,
      lastOperationId: operationId,
    };
    if (index >= 0) state.sessionFeedbacks[index] = feedback;
    else state.sessionFeedbacks.push(feedback);
    appendHistoryEvent(state, {
      userId,
      sessionId: feedback.sessionId,
      eventType: current ? "session_feedback_corrected" : "session_feedback_saved",
      aggregateId: feedback.feedbackId,
      aggregateVersion: feedback.version,
      occurredAt: now,
      operationId,
      snapshot: feedback,
    });
    return { ...memory, ...statePatch(state) };
  });

  return confirmEvent(
    userId,
    operationId,
    ["session_feedback_saved", "session_feedback_corrected"],
    (event) => event.snapshot as SessionFeedback
  );
}

export async function appendTrainingHistoryCorrection(
  command: AppendTrainingHistoryCorrectionCommand
): Promise<TrainingHistoryEvent> {
  const userId = requireText(command.userId, "userId");
  const operationId = requireText(command.operationId, "operationId");
  const expectedVersion = requireVersion(command.expectedVersion);
  const sessionId = requireText(command.sessionId, "sessionId");
  const targetEventId = requireText(command.targetEventId, "targetEventId");
  const reason = requireText(command.reason, "reason");
  if (!isRecord(command.correctedData) || Object.keys(command.correctedData).length === 0) {
    throw new TrainingMotorStoreError(
      "INVALID_INPUT",
      "correctedData must contain at least one field."
    );
  }

  await updateUserMemoryAtomically<Record<string, unknown>>(userId, (snapshot) => {
    const memory = assertUserMemory(snapshot, userId);
    const state = stateFromMemory(memory, userId);
    const duplicate = existingOperation(
      state.trainingHistory,
      operationId,
      ["correction"],
      targetEventId
    );
    if (duplicate) return memory;
    if (state.trainingHistory.version !== expectedVersion) {
      throw new TrainingMotorStoreError(
        "VERSION_CONFLICT",
        `Training history is at version ${state.trainingHistory.version}, not ${expectedVersion}.`
      );
    }
    const target = state.trainingHistory.events.find(
      (event) => event.eventId === targetEventId
    );
    if (!target) {
      throw new TrainingMotorStoreError(
        "HISTORY_EVENT_NOT_FOUND",
        `Training history event ${targetEventId} does not exist.`
      );
    }
    if (target.sessionId !== sessionId) {
      throw new TrainingMotorStoreError(
        "INVALID_INPUT",
        "A correction must target an event from the same session."
      );
    }

    const now = new Date().toISOString();
    appendHistoryEvent(state, {
      userId,
      sessionId,
      eventType: "correction",
      aggregateId: targetEventId,
      aggregateVersion: state.trainingHistory.version + 1,
      occurredAt: now,
      operationId,
      snapshot: {
        targetEventId,
        reason,
        correctedData: clone(command.correctedData),
      },
    });
    return { ...memory, ...statePatch(state) };
  });

  return confirmEvent(userId, operationId, ["correction"], (event) => event);
}
