/**
 * Auditoria local auxiliar do bootstrap pós-pacto, com Gemini real e stores
 * temporários. Não é prova de produção porque Redis e frontend não participam.
 *
 * Segurança: o processo só inicia quando as duas variáveis Upstash foram
 * explicitamente definidas como vazias pelo chamador. O restante do estado usa
 * arquivos temporários exclusivos desta execução.
 *
 * Executar:
 *   UPSTASH_REDIS_REST_URL= UPSTASH_REDIS_REST_TOKEN= npm run audit:post-pact-local
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

type SupportedLanguage = "pt-BR" | "en-US" | "it-IT";
type JsonRecord = Record<string, unknown>;
type WorkoutPlanRecord = JsonRecord & { exercises: JsonRecord[] };

interface AuditProfile {
  language: SupportedLanguage;
  name: string;
  trainingStatus: string;
  limitation: string;
  foodRestriction: string;
}

interface GeminiCall {
  ok: boolean;
  status: number;
}

interface AuditResult {
  language: SupportedLanguage;
  ok: boolean;
  durationMs: number;
  detail: string;
}

const PROFILES: AuditProfile[] = [
  {
    language: "pt-BR",
    name: "Lucas",
    trainingStatus: "treinando",
    limitation: "lombar",
    foodRestriction: "sem lactose",
  },
  {
    language: "en-US",
    name: "Liam",
    trainingStatus: "training consistently",
    limitation: "lower back",
    foodRestriction: "lactose-free",
  },
  {
    language: "it-IT",
    name: "Luca",
    trainingStatus: "mi alleno regolarmente",
    limitation: "lombare",
    foodRestriction: "senza lattosio",
  },
];

const FORBIDDEN_ARRIVAL_PATTERNS: Record<SupportedLanguage, Array<[string, RegExp]>> = {
  "pt-BR": [
    ["compromisso ou viagem inventados", /\b(compromissos?|viagens?|viajar|viajo)\b/],
    ["período bloqueado inventado", /\bperiodo\b.{0,40}\bbloquead|\bbloquead\w*\b.{0,40}\bperiodo\b/],
    ["preferência de horário não informada", /\bde manha\b|\bde tarde\b|\bmelhor horario\b|\bpuxo o treino\b|\btreino (?:para|pra) antes\b|\bmissao curta\b/],
  ],
  "en-US": [
    ["invented commitment or trip", /\b(commitments?|trips?|travel(?:ling|ing|s|ed)?)\b/],
    ["invented blocked period", /\bblocked\b.{0,40}\bperiod\b|\bperiod\b.{0,40}\bblocked\b/],
    ["uninformed schedule preference", /\bmorning or afternoon\b|\bbest time\b|\bmove\w*\b.{0,30}\bworkout\b.{0,30}\bearlier\b|\bshort mission\b/],
  ],
  "it-IT": [
    ["impegno o viaggio inventati", /\b(impegn\w*|viagg\w*)\b/],
    ["periodo bloccato inventato", /\bperiodo\b.{0,40}\bbloccat\w*|\bbloccat\w*\b.{0,40}\bperiodo\b/],
    ["preferenza oraria non informata", /\bmattina\b|\bpomeriggio\b|\bmiglior\w* orario\b|\bspost\w*\b.{0,30}\ballenamento\b.{0,30}\bprima\b|\bmissione breve\b/],
  ],
};

function writeLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function oneLine(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function requireExplicitEmptyRedisEnvironment(): boolean {
  const keys = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;
  const unsafe = keys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(process.env, key) || process.env[key] !== "",
  );
  if (unsafe.length === 0) return true;

  writeError("SKIP — isolamento Redis não foi comprovado.");
  writeError("Execute com: UPSTASH_REDIS_REST_URL= UPSTASH_REDIS_REST_TOKEN= npm run audit:post-pact-local");
  process.exitCode = 2;
  return false;
}

function selectedProfiles(): AuditProfile[] {
  const requested = (process.env.GUTO_AUDIT_LANGUAGES || "pt-BR,en-US,it-IT")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set<SupportedLanguage>(PROFILES.map((profile) => profile.language));
  const invalid = requested.filter((value) => !allowed.has(value as SupportedLanguage));
  invariant(invalid.length === 0, `Idiomas não suportados: ${invalid.join(", ")}`);
  const selected = PROFILES.filter((profile) => requested.includes(profile.language));
  invariant(selected.length > 0, "Nenhum idioma selecionado para a auditoria.");
  return selected;
}

function resolvedField(
  field: "country" | "pathology" | "foodRestriction",
  rawValue: string,
  normalizedValue: string,
  now: string,
  bodyRegion?: string,
): JsonRecord {
  return {
    field,
    rawValue,
    rawValueHash: `audit-${field}-${fold(rawValue).replace(/\s+/g, "-")}`,
    normalizedValue,
    ...(bodyRegion ? { bodyRegion } : {}),
    riskTags: field === "pathology" ? ["lower_back_sensitive"] : field === "foodRestriction" ? ["intolerance"] : [],
    confidence: 0.99,
    status: "clear",
    resolvedAt: now,
  };
}

function buildNewUserMemory(profile: AuditProfile, userId: string, now: string): JsonRecord {
  return {
    userId,
    name: profile.name,
    language: profile.language,
    hasSeenChatOpening: false,
    initialXpGranted: false,
    initialXpRewardSeen: true,
    totalXp: 0,
    streak: 0,
    trainedToday: false,
    adaptedMissionToday: false,
    lastActiveAt: now,
    consentHealthFitness: true,
    acceptedTerms: true,
    consentAcceptedAt: now,
    trainingLocation: "gym",
    preferredTrainingLocation: "gym",
    trainingStatus: profile.trainingStatus,
    trainingLevel: "consistent",
    trainingGoal: "fat_loss",
    trainingPathology: profile.limitation,
    trainingLimitations: profile.limitation,
    biologicalSex: "male",
    userAge: 20,
    heightCm: 178,
    weightKg: 83.5,
    country: "Brasil",
    countryCode: "BR",
    city: "São Paulo",
    foodRestrictions: profile.foodRestriction,
    resolvedFields: {
      country: resolvedField("country", "Brasil", "brazil", now),
      pathology: resolvedField("pathology", profile.limitation, "lower_back", now, "lower_back"),
      foodRestriction: resolvedField("foodRestriction", profile.foodRestriction, "lactose_intolerance", now),
      acknowledged: [],
    },
    completedWorkoutDates: [],
    adaptedMissionDates: [],
    missedMissionDates: [],
    xpEvents: [],
    lastWorkoutPlan: null,
    weeklyWorkoutPlan: null,
    weeklyDietPlan: null,
    dietGenerationStatus: "idle",
    recentTrainingHistory: [],
    workoutFeedbackHistory: [],
    memoryAudit: [],
    proactiveSent: {},
    proactiveMemories: [],
    proactiveImpacts: [],
    proactivePrompt: null,
    activeExercise: null,
    substitutionContext: null,
    activeConversationContext: null,
    turnJournal: [],
  };
}

function buildContaminantMemory(now: string): JsonRecord {
  return {
    userId: "audit-contaminant-old-user",
    name: "Contaminant",
    language: "pt-BR",
    hasSeenChatOpening: true,
    initialXpGranted: true,
    initialXpRewardSeen: true,
    totalXp: 100,
    streak: 1,
    trainedToday: false,
    adaptedMissionToday: false,
    lastActiveAt: now,
    completedWorkoutDates: [],
    adaptedMissionDates: [],
    missedMissionDates: [],
    xpEvents: [],
    proactiveSent: {},
    proactiveMemories: [
      {
        id: "old-user-trip",
        userId: "audit-contaminant-old-user",
        type: "trip",
        rawText: "Viagem e compromisso com período bloqueado",
        status: "pending_confirmation",
        createdAt: now,
        updatedAt: now,
      },
    ],
    proactiveImpacts: [],
    proactivePrompt: null,
  };
}

function readJsonRecord(path: string): JsonRecord {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  invariant(isRecord(parsed), `Arquivo inválido: ${path}`);
  return parsed;
}

async function getJson(url: string, token: string): Promise<JsonRecord> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const raw = await response.text();
  invariant(response.ok, `HTTP ${response.status}: ${oneLine(raw, 400)}`);
  const parsed = JSON.parse(raw) as unknown;
  invariant(isRecord(parsed), "A rota proativa não devolveu um objeto JSON.");
  return parsed;
}

async function postJson(url: string, token: string, body: JsonRecord): Promise<JsonRecord> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  invariant(response.ok, `HTTP ${response.status}: ${oneLine(raw, 400)}`);
  const parsed = JSON.parse(raw) as unknown;
  invariant(isRecord(parsed), "A rota pós-pacto não devolveu um objeto JSON.");
  return parsed;
}

function assertNoInventedContext(language: SupportedLanguage, speech: string): void {
  const normalized = fold(speech);
  for (const [label, pattern] of FORBIDDEN_ARRIVAL_PATTERNS[language]) {
    invariant(!pattern.test(normalized), `${label}: “${oneLine(speech)}”`);
  }

  const obviousLanguageLeak: Record<SupportedLanguage, RegExp> = {
    "pt-BR": /\ballenamento\b|\btoday's workout\b/,
    "en-US": /\b(voce|treino|missao|bora)\b/,
    "it-IT": /\b(voce|treino|missao|bora)\b/,
  };
  invariant(!obviousLanguageLeak[language].test(normalized), `vazamento evidente de idioma: “${oneLine(speech)}”`);
}

function assertDietWasGenerated(dietFile: string, userId: string, persisted: JsonRecord): void {
  invariant(persisted.dietGenerationStatus === "generated", `dietGenerationStatus não é generated: ${String(persisted.dietGenerationStatus)}.`);
  invariant(existsSync(dietFile), "diet-store não foi criado no pacto.");
  const dietStore = readJsonRecord(dietFile);
  const diet = dietStore[userId];
  invariant(isRecord(diet), "O diet-store não recebeu o plano pós-pacto.");
  invariant(Array.isArray(diet.meals) && diet.meals.length > 0, "A dieta pós-pacto não possui refeições.");
}

function assertOfficialLocalExercises(plan: unknown, label: string): asserts plan is WorkoutPlanRecord {
  invariant(isRecord(plan), `${label} ausente.`);
  invariant(Array.isArray(plan.exercises) && plan.exercises.length > 0, `${label} sem exercícios.`);
  for (const [index, exercise] of plan.exercises.entries()) {
    invariant(isRecord(exercise), `${label}.exercises[${index}] inválido.`);
    invariant(
      typeof exercise.videoUrl === "string" && exercise.videoUrl.startsWith("/exercise/visuals/"),
      `${label}.exercises[${index}] não possui videoUrl oficial local.`,
    );
    invariant(
      exercise.videoProvider === "local",
      `${label}.exercises[${index}] não possui videoProvider local.`,
    );
  }
}

function assertLimitationCareIsVisible(plan: WorkoutPlanRecord, language: SupportedLanguage, label: string): void {
  const summary = fold(typeof plan.summary === "string" ? plan.summary : "");
  const expected: Record<SupportedLanguage, RegExp> = {
    "pt-BR": /\b(proteg\w*|reduz\w*)\b.{0,80}\b(lombar|coluna)\b|\b(lombar|coluna)\b.{0,80}\b(proteg\w*|reduz\w*)\b/,
    "en-US": /\b(protect\w*|reduc\w*)\b.{0,80}\b(lower back|back)\b|\b(lower back|back)\b.{0,80}\b(protect\w*|reduc\w*)\b/,
    "it-IT": /\b(protegg\w*|proteg\w*|riduc\w*)\b.{0,80}\b(lombar\w*|schiena)\b|\b(lombar\w*|schiena)\b.{0,80}\b(protegg\w*|proteg\w*|riduc\w*)\b/,
  };
  invariant(expected[language].test(summary), `${label} não evidencia o cuidado com a limitação lombar: “${oneLine(summary)}”`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  if (!requireExplicitEmptyRedisEnvironment()) return;

  const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
  process.chdir(backendDir);
  await import("dotenv/config");

  invariant(
    process.env.UPSTASH_REDIS_REST_URL === "" && process.env.UPSTASH_REDIS_REST_TOKEN === "",
    "O carregamento de ambiente tentou reativar o Redis; auditoria abortada.",
  );
  if (!process.env.GEMINI_API_KEY?.trim()) {
    writeError("SKIP — GEMINI_API_KEY não está disponível; nenhuma resposta sintética foi aceita como prova real.");
    process.exitCode = 2;
    return;
  }

  const tmpRoot = join(backendDir, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const runDir = mkdtempSync(join(tmpRoot, "new-user-arrival-"));
  const memoryFile = join(runDir, "memory.json");
  const dietFile = join(runDir, "diet.json");
  const customExerciseFile = join(runDir, "custom-exercises.json");
  const pushStoreFile = join(runDir, "push-subscriptions.json");

  process.env.NODE_ENV = "test";
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_ALLOW_DEV_ACCESS = "true";
  process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
  process.env.ENABLE_PROACTIVE_JOB = "false";
  process.env.ENABLE_DAILY_BRIEFING = "false";
  process.env.GUTO_RATE_LIMIT_MAX_REQUESTS = "10000";
  process.env.JWT_SECRET = "audit-only-jwt-secret-never-production-2026";
  process.env.GUTO_MEMORY_FILE = memoryFile;
  process.env.GUTO_DIET_FILE = dietFile;
  process.env.GUTO_CUSTOM_EXERCISE_FILE = customExerciseFile;
  process.env.PUSH_STORE_FILE = pushStoreFile;

  const profiles = selectedProfiles();
  const now = new Date().toISOString();
  const runId = randomUUID().slice(0, 8);
  const users = profiles.map((profile, index) => ({
    profile,
    userId: `audit-arrival-${runId}-${index + 1}`,
  }));
  const seededStore: JsonRecord = {
    "audit-contaminant-old-user": buildContaminantMemory(now),
  };
  for (const { profile, userId } of users) {
    const memory = buildNewUserMemory(profile, userId, now);
    invariant(!Object.prototype.hasOwnProperty.call(memory, "trainingSchedule"), "O perfil novo não pode conter horário de treino.");
    seededStore[userId] = memory;
  }
  writeFileSync(memoryFile, JSON.stringify(seededStore, null, 2));
  writeFileSync(dietFile, JSON.stringify({}, null, 2));

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const geminiCalls: GeminiCall[] = [];
  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isGemini = (() => {
      try {
        return new URL(rawUrl).hostname === "generativelanguage.googleapis.com";
      } catch {
        return false;
      }
    })();
    try {
      const response = await nativeFetch(input, init);
      if (isGemini) geminiCalls.push({ ok: response.ok, status: response.status });
      return response;
    } catch (error) {
      if (isGemini) geminiCalls.push({ ok: false, status: 0 });
      throw error;
    }
  };

  let server: Server | null = null;
  const results: AuditResult[] = [];
  try {
    const [{ app }, { flushMemoryStoreWrites }] = await Promise.all([
      import("../server.js"),
      import("../src/memory-store.js"),
    ]);
    server = await new Promise<Server>((resolve, reject) => {
      const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
      candidate.once("error", reject);
    });
    const address = server.address();
    invariant(address && typeof address !== "string", "Não foi possível abrir a porta local da auditoria.");
    const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

    writeLine("GUTO — auditoria local auxiliar do bootstrap pós-pacto");
    writeLine(`Idiomas: ${profiles.map((profile) => profile.language).join(", ")}`);
    writeLine("NÃO É PROVA DE PRODUÇÃO | Redis: desligado | stores: temporários | Gemini: real");
    writeLine();

    for (const { profile, userId } of users) {
      const startedAt = Date.now();
      const callOffset = geminiCalls.length;
      try {
        const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET);
        const payload = await postJson(
          `${baseUrl}/guto/memory`,
          token,
          { language: profile.language, xpEvent: "grant_initial_xp" },
        );
        await flushMemoryStoreWrites();

        invariant(payload.initialXpGranted === true, "pacto não foi persistido.");
        const workoutPlan = payload.lastWorkoutPlan;
        assertOfficialLocalExercises(workoutPlan, "lastWorkoutPlan da resposta pós-pacto");
        assertLimitationCareIsVisible(workoutPlan, profile.language, "lastWorkoutPlan da resposta pós-pacto");
        invariant(isRecord(payload.lastDietPlan), "lastDietPlan ausente na resposta pós-pacto.");
        invariant(Array.isArray(payload.lastDietPlan.meals) && payload.lastDietPlan.meals.length > 0, "lastDietPlan sem refeições.");

        const calls = geminiCalls.slice(callOffset);
        invariant(calls.length > 0, "nenhuma chamada Gemini ocorreu neste cenário.");
        invariant(calls[0]?.ok, `O contrato do cérebro Gemini não respondeu com sucesso (status: ${calls.map((call) => call.status).join(", ")}).`);

        const store = readJsonRecord(memoryFile);
        const persisted = store[userId];
        invariant(isRecord(persisted), "memória do novo usuário não foi persistida.");
        assertOfficialLocalExercises(persisted.lastWorkoutPlan, "lastWorkoutPlan persistido");
        assertLimitationCareIsVisible(persisted.lastWorkoutPlan, profile.language, "lastWorkoutPlan persistido");
        invariant(Array.isArray(persisted.proactiveMemories) && persisted.proactiveMemories.length === 0, "memória proativa vazou de outro usuário.");
        invariant(Array.isArray(persisted.proactiveImpacts) && persisted.proactiveImpacts.length === 0, "impacto proativo foi inventado.");
        invariant(persisted.proactivePrompt == null, "proactivePrompt foi inventado na chegada.");
        invariant(persisted.activeConversationContext == null, "activeConversationContext foi inventado na chegada.");
        assertDietWasGenerated(dietFile, userId, persisted);

        const durationMs = Date.now() - startedAt;
        results.push({ language: profile.language, ok: true, durationMs, detail: "missão, treino e dieta persistidos" });
        writeLine(`PASS ${profile.language} — ${workoutPlan.exercises.length} exercícios — ${(durationMs / 1000).toFixed(1)}s`);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const detail = error instanceof Error ? error.message : String(error);
        results.push({ language: profile.language, ok: false, durationMs, detail });
        writeLine(`FAIL ${profile.language} — ${(durationMs / 1000).toFixed(1)}s — ${oneLine(detail, 500)}`);
      }
    }
  } finally {
    if (server) await closeServer(server).catch(() => undefined);
    globalThis.fetch = nativeFetch;
    if (process.env.GUTO_AUDIT_KEEP_TMP !== "1") rmSync(runDir, { recursive: true, force: true });
  }

  const passed = results.filter((result) => result.ok).length;
  writeLine();
  writeLine(`Resultado: ${passed}/${results.length} cenários aprovados.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  writeError(`FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
