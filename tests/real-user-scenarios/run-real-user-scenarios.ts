import "../test-env.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";

// Auxiliary deterministic coverage only. This suite deliberately disables
// Gemini and Redis and therefore MUST NOT be cited as real-user/production
// evidence for a release gate.
process.env.GEMINI_API_KEY = "";
process.env.VOICE_API_KEY = process.env.VOICE_API_KEY || "real-user-scenarios-voice-key";
process.env.GUTO_GEMINI_MODEL = process.env.GUTO_GEMINI_MODEL || "gemini-3.1-flash-lite";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
process.env.CLOUDINARY_URL = "";
process.env.CLOUDINARY_CLOUD_NAME = "";
process.env.CLOUDINARY_API_KEY = "";
process.env.CLOUDINARY_API_SECRET = "";

type GutoLanguage = "pt-BR" | "it-IT";
type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";
type TrainingGoal = "fat_loss" | "muscle_gain" | "conditioning" | "mobility_health" | "consistency";
type TrainingLocation = "gym" | "home" | "mixed";

type ExpectedResponse = {
  type?: string;
  context?: string;
  instruction?: string;
} | null;

type WorkoutExercise = {
  id: string;
  name?: string;
  canonicalNamePt?: string;
  muscleGroup?: string;
  sets?: number;
  reps?: string;
  rest?: string;
  cue?: string;
  note?: string;
  videoUrl?: string;
};

type WorkoutPlan = {
  focus?: string;
  focusKey?: string;
  goal?: string;
  summary?: string;
  dateLabel?: string;
  scheduledFor?: string;
  location?: string;
  exercises: WorkoutExercise[];
};

type DietMeal = {
  id?: string;
  name?: string;
  time?: string;
  totalKcal?: number;
  gutoNote?: string;
  foods: Array<{ name?: string; quantity?: string; kcal?: number }>;
};

type DietPlan = {
  userId?: string;
  language?: string;
  foodRestrictions?: string;
  macros?: { targetKcal?: number; goal?: string };
  meals?: DietMeal[];
};

type GutoResponse = {
  fala?: string;
  acao?: string;
  expectedResponse?: ExpectedResponse;
  workoutPlan?: WorkoutPlan | null;
  audioContent?: string;
  languageCode?: string;
  mimeType?: string;
  voiceUsed?: string;
  turnDecision?: { relatedMemoryId?: string; stage?: string; cards?: Array<{ memoryId?: string }> };
};

type MemoryRecord = Record<string, unknown> & {
  language?: string;
  name?: string;
  biologicalSex?: string;
  userAge?: number;
  heightCm?: number;
  weightKg?: number;
  trainingLevel?: string;
  trainingStatus?: string;
  trainingGoal?: string;
  preferredTrainingLocation?: string;
  trainingLocation?: string;
  trainingPathology?: string;
  trainingLimitations?: string;
  foodRestrictions?: string;
  initialXpGranted?: boolean;
  totalXp?: number;
  xpEvents?: Array<{ type?: string; xp?: number; amount?: number; date?: string; createdAt?: string }>;
  completedWorkoutDates?: string[];
  validationHistory?: Array<{ status?: string; xp?: number; createdAt?: string }>;
  lastWorkoutPlan?: WorkoutPlan | null;
  dietGenerationStatus?: string;
  proactiveMemories?: Array<{ id?: string; type?: string; status?: string; stage?: string; confirmationStage?: string }>;
  proactiveImpacts?: Array<{ workoutEffect?: string; missionEffect?: string; pathEffect?: string; status?: string }>;
  activeConversationContext?: { kind?: string; relatedMemoryId?: string } | null;
};

type ScenarioProfile = {
  id: string;
  name: string;
  language: GutoLanguage;
  biologicalSex: "female" | "male";
  userAge: number;
  heightCm: number;
  weightKg: number;
  trainingLevel: "beginner" | "returning" | "consistent" | "advanced";
  trainingStatus: string;
  trainingGoal: TrainingGoal;
  limitation: string;
  foodRestrictions: string;
  country: string;
  countryCode: string;
  city: string;
  preferredTrainingLocation: TrainingLocation;
  prompts: {
    start: string;
    travel: string;
    travelCannotTrain: string;
    shortTime: string;
    newPain: string;
    negativeFeedback: string;
    workoutDone: string;
    exerciseDoubt: string;
    dietDoubt: string;
    initialChat: string;
    voiceText: string;
  };
  expected: {
    limitationTerms: string[];
    newPainTerms: string[];
    forbiddenFoods: string[];
  };
};

type CheckResult = {
  id: string;
  area: string;
  status: CheckStatus;
  message: string;
  details?: unknown;
};

type ProfileReport = {
  id: string;
  name: string;
  language: GutoLanguage;
  checks: CheckResult[];
};

type ScenarioState = {
  initialResponse?: GutoResponse & { due?: boolean; slot?: string };
  memoryBeforeDone?: MemoryRecord;
  memoryAfterDone?: MemoryRecord;
  memoryAfterValidation?: MemoryRecord;
  workoutResponse?: GutoResponse;
  workoutPlan?: WorkoutPlan;
  dietPlan?: DietPlan;
  travelMemoryId?: string;
  validationResponse?: unknown;
  voiceResponse?: GutoResponse;
};

type ScenarioContext = {
  baseUrl: string;
  chat: (profile: ScenarioProfile, input: string, history?: Array<{ role: string; parts: Array<{ text: string }> }>) => Promise<GutoResponse>;
  getMemory: (profile: ScenarioProfile) => Promise<MemoryRecord>;
  postMemory: (profile: ScenarioProfile, body: Record<string, unknown>) => Promise<{ status: number; body: MemoryRecord }>;
  postJson: <T>(profile: ScenarioProfile, path: string, body: Record<string, unknown>) => Promise<{ status: number; body: T }>;
  getJson: <T>(profile: ScenarioProfile, path: string) => Promise<{ status: number; body: T }>;
  resetTtsRequests: () => void;
  getTtsRequestCount: () => number;
  getExpectedEvolutionStage: (xp: number) => string;
};

type FileSnapshot = {
  path: string;
  existed: boolean;
  content?: string;
};

const tmpDir = join(process.cwd(), "tmp", "real-user-scenarios");
const reportJsonFile = join(tmpDir, "report.json");
const reportMdFile = join(tmpDir, "report.md");
const memoryFile = join(tmpDir, "guto-memory.real-user-scenarios.json");
const dietFile = join(tmpDir, "guto-diet.real-user-scenarios.json");
const arenaFile = join(process.cwd(), "tmp", "arena-store.json");
const validationImagesDir = join(process.cwd(), "tmp", "validation-images");
const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server | null = null;
let baseUrl = "";
let clearMemoryStoreCache: () => void = () => {};
let getGutoEvolutionStage: (xp: number) => string = () => "baby";

const originalFetch = globalThis.fetch.bind(globalThis);
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const ttsRequests: Array<{ model: string; text: string }> = [];

const profiles: ScenarioProfile[] = [
  {
    id: "real-maria",
    name: "Maria",
    language: "pt-BR",
    biologicalSex: "female",
    userAge: 29,
    heightCm: 164,
    weightKg: 78,
    trainingLevel: "beginner",
    trainingStatus: "parada, iniciante",
    trainingGoal: "fat_loss",
    limitation: "ombro",
    foodRestrictions: "sem lactose",
    country: "Brasil",
    countryCode: "BR",
    city: "São Paulo",
    preferredTrainingLocation: "gym",
    prompts: {
      start: "monta meu treino de hoje para emagrecer na academia",
      travel: "viajo quarta",
      travelCannotTrain: "não consigo treinar nesse dia",
      shortTime: "só tenho 10 minutos",
      newPain: "meu joelho dói",
      negativeFeedback: "não gostei do treino",
      workoutDone: "fiz o treino",
      exerciseDoubt: "como faço flexão?",
      dietDoubt: "e minha dieta sem lactose?",
      initialChat: "oi GUTO, conduz o começo",
      voiceText: "Maria, treino validado. Próximo passo: água e comida.",
    },
    expected: {
      limitationTerms: ["ombro"],
      newPainTerms: ["joelho"],
      forbiddenFoods: ["leite", "iogurte", "queijo", "ricotta", "mozzarella", "parmigiano", "latte", "yogurt"],
    },
  },
  {
    id: "real-joao",
    name: "João",
    language: "pt-BR",
    biologicalSex: "male",
    userAge: 34,
    heightCm: 178,
    weightKg: 94,
    trainingLevel: "beginner",
    trainingStatus: "parado",
    trainingGoal: "fat_loss",
    limitation: "joelho",
    foodRestrictions: "sem restrição alimentar",
    country: "Brasil",
    countryCode: "BR",
    city: "Rio de Janeiro",
    preferredTrainingLocation: "gym",
    prompts: {
      start: "monta meu treino de hoje para emagrecer na academia",
      travel: "viajo quarta",
      travelCannotTrain: "não consigo treinar nesse dia",
      shortTime: "só tenho 10 minutos",
      newPain: "meu joelho dói mais hoje",
      negativeFeedback: "não gostei do treino",
      workoutDone: "fiz o treino",
      exerciseDoubt: "como faço flexão?",
      dietDoubt: "e minha dieta?",
      initialChat: "oi GUTO, conduz o começo",
      voiceText: "João, treino validado. Próximo passo: água e comida.",
    },
    expected: { limitationTerms: ["joelho"], newPainTerms: ["joelho"], forbiddenFoods: [] },
  },
  {
    id: "real-leandro",
    name: "Leandro",
    language: "it-IT",
    biologicalSex: "male",
    userAge: 32,
    heightCm: 180,
    weightKg: 86,
    trainingLevel: "consistent",
    trainingStatus: "già allenando",
    trainingGoal: "fat_loss",
    limitation: "ginocchio",
    foodRestrictions: "vegetariano",
    country: "Italia",
    countryCode: "IT",
    city: "Milano",
    preferredTrainingLocation: "gym",
    prompts: {
      start: "prepara il mio allenamento di oggi per dimagrire in palestra",
      travel: "viaggio mercoledì",
      travelCannotTrain: "non riesco ad allenarmi quel giorno",
      shortTime: "ho solo 10 minuti",
      newPain: "mi fa male il ginocchio",
      negativeFeedback: "non mi è piaciuto l'allenamento",
      workoutDone: "ho fatto l'allenamento",
      exerciseDoubt: "come si fa la flessione?",
      dietDoubt: "e la mia dieta vegetariana?",
      initialChat: "ciao GUTO, guidami adesso",
      voiceText: "Leandro, allenamento validato. Prossimo passo: acqua e cibo.",
    },
    expected: { limitationTerms: ["ginocchio"], newPainTerms: ["ginocchio"], forbiddenFoods: ["pollo", "carne", "pesce", "tonno", "frango", "peixe", "chicken", "beef"] },
  },
  {
    id: "real-giulia",
    name: "Giulia",
    language: "it-IT",
    biologicalSex: "female",
    userAge: 27,
    heightCm: 168,
    weightKg: 64,
    trainingLevel: "beginner",
    trainingStatus: "principiante",
    trainingGoal: "conditioning",
    limitation: "senza dolore",
    foodRestrictions: "senza lattosio",
    country: "Italia",
    countryCode: "IT",
    city: "Roma",
    preferredTrainingLocation: "home",
    prompts: {
      start: "prepara il mio allenamento di oggi a casa per salute e condizionamento",
      travel: "viaggio mercoledì",
      travelCannotTrain: "non riesco ad allenarmi quel giorno",
      shortTime: "ho solo 10 minuti",
      newPain: "mi fa male il ginocchio",
      negativeFeedback: "non mi è piaciuto l'allenamento",
      workoutDone: "ho fatto l'allenamento",
      exerciseDoubt: "come si fa la flessione?",
      dietDoubt: "e la mia dieta senza lattosio?",
      initialChat: "ciao GUTO, guidami adesso",
      voiceText: "Giulia, allenamento validato. Prossimo passo: acqua e cibo.",
    },
    expected: { limitationTerms: ["senza dolore"], newPainTerms: ["ginocchio"], forbiddenFoods: ["latte", "yogurt", "formaggio", "ricotta", "mozzarella", "parmigiano"] },
  },
  {
    id: "real-anna",
    name: "Anna",
    language: "it-IT",
    biologicalSex: "female",
    userAge: 31,
    heightCm: 170,
    weightKg: 68,
    trainingLevel: "consistent",
    trainingStatus: "già allenando",
    trainingGoal: "muscle_gain",
    limitation: "spalla",
    foodRestrictions: "vegana",
    country: "Italia",
    countryCode: "IT",
    city: "Torino",
    preferredTrainingLocation: "gym",
    prompts: {
      start: "prepara il mio allenamento di oggi per ipertrofia in palestra",
      travel: "viaggio mercoledì",
      travelCannotTrain: "non riesco ad allenarmi quel giorno",
      shortTime: "ho solo 10 minuti",
      newPain: "mi fa male il ginocchio",
      negativeFeedback: "non mi è piaciuto l'allenamento",
      workoutDone: "ho fatto l'allenamento",
      exerciseDoubt: "come si fa la flessione?",
      dietDoubt: "e la mia dieta vegana?",
      initialChat: "ciao GUTO, guidami adesso",
      voiceText: "Anna, allenamento validato. Prossimo passo: acqua e cibo.",
    },
    expected: { limitationTerms: ["spalla"], newPainTerms: ["ginocchio"], forbiddenFoods: ["pollo", "carne", "pesce", "tonno", "uovo", "uova", "latte", "yogurt", "formaggio", "cheese", "egg", "milk"] },
  },
  {
    id: "real-carlos",
    name: "Carlos",
    language: "pt-BR",
    biologicalSex: "male",
    userAge: 36,
    heightCm: 181,
    weightKg: 88,
    trainingLevel: "consistent",
    trainingStatus: "treinando",
    trainingGoal: "muscle_gain",
    limitation: "sem dor",
    foodRestrictions: "como de tudo",
    country: "Brasil",
    countryCode: "BR",
    city: "Curitiba",
    preferredTrainingLocation: "gym",
    prompts: {
      start: "monta meu treino de hoje para hipertrofia na academia",
      travel: "viajo quarta",
      travelCannotTrain: "não consigo treinar nesse dia",
      shortTime: "só tenho 10 minutos",
      newPain: "meu joelho dói",
      negativeFeedback: "não gostei do treino",
      workoutDone: "fiz o treino",
      exerciseDoubt: "como faço flexão?",
      dietDoubt: "e minha dieta?",
      initialChat: "oi GUTO, conduz o começo",
      voiceText: "Carlos, treino validado. Próximo passo: água e comida.",
    },
    expected: { limitationTerms: ["sem dor"], newPainTerms: ["joelho"], forbiddenFoods: [] },
  },
  {
    id: "real-sofia",
    name: "Sofia",
    language: "pt-BR",
    biologicalSex: "female",
    userAge: 38,
    heightCm: 160,
    weightKg: 62,
    trainingLevel: "returning",
    trainingStatus: "rotina apertada, voltando",
    trainingGoal: "consistency",
    limitation: "dor leve no joelho",
    foodRestrictions: "vegetariana",
    country: "Brasil",
    countryCode: "BR",
    city: "Belo Horizonte",
    preferredTrainingLocation: "home",
    prompts: {
      start: "monta meu treino de hoje em casa para consistência e saúde",
      travel: "viajo quarta",
      travelCannotTrain: "não consigo treinar nesse dia",
      shortTime: "só tenho 10 minutos",
      newPain: "meu joelho dói",
      negativeFeedback: "não gostei do treino",
      workoutDone: "fiz o treino",
      exerciseDoubt: "como faço flexão?",
      dietDoubt: "e minha dieta vegetariana?",
      initialChat: "oi GUTO, conduz o começo",
      voiceText: "Sofia, treino validado. Próximo passo: água e comida.",
    },
    expected: { limitationTerms: ["joelho"], newPainTerms: ["joelho"], forbiddenFoods: ["frango", "carne", "peixe", "atum", "pollo", "pesce", "chicken", "beef"] },
  },
  {
    id: "real-marco",
    name: "Marco",
    language: "it-IT",
    biologicalSex: "male",
    userAge: 40,
    heightCm: 176,
    weightKg: 84,
    trainingLevel: "returning",
    trainingStatus: "viaggio questa settimana, in ripresa",
    trainingGoal: "fat_loss",
    limitation: "senza dolore",
    foodRestrictions: "mangio tutto",
    country: "Italia",
    countryCode: "IT",
    city: "Bologna",
    preferredTrainingLocation: "mixed",
    prompts: {
      start: "prepara il mio allenamento di oggi per dimagrire, posto misto",
      travel: "viaggio mercoledì",
      travelCannotTrain: "non riesco ad allenarmi quel giorno",
      shortTime: "ho solo 10 minuti",
      newPain: "mi fa male il ginocchio",
      negativeFeedback: "non mi è piaciuto l'allenamento",
      workoutDone: "ho fatto l'allenamento",
      exerciseDoubt: "come si fa la flessione?",
      dietDoubt: "e la mia dieta?",
      initialChat: "ciao GUTO, guidami adesso",
      voiceText: "Marco, allenamento validato. Prossimo passo: acqua e cibo.",
    },
    expected: { limitationTerms: ["senza dolore"], newPainTerms: ["ginocchio"], forbiddenFoods: [] },
  },
];

function writeLine(line = "") {
  process.stdout.write(`${line}\n`);
}

function normalize(text: unknown): string {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.GUTO_TIME_ZONE || "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function authHeaders(profile: ScenarioProfile): Record<string, string> {
  const token = jwt.sign({ userId: profile.id, role: "student" }, process.env.JWT_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function snapshotFile(path: string): FileSnapshot {
  return {
    path,
    existed: existsSync(path),
    content: existsSync(path) ? readFileSync(path, "utf8") : undefined,
  };
}

function restoreFile(snapshot: FileSnapshot): void {
  if (snapshot.existed) {
    mkdirSync(dirname(snapshot.path), { recursive: true });
    writeFileSync(snapshot.path, snapshot.content || "");
    return;
  }
  rmSync(snapshot.path, { force: true });
}

function readVisibleWorkoutText(plan?: WorkoutPlan | null): string {
  if (!plan) return "";
  const parts = [plan.focus, plan.summary, plan.dateLabel];
  for (const exercise of plan.exercises || []) {
    parts.push(exercise.name, exercise.reps, exercise.rest, exercise.cue, exercise.note);
  }
  return parts.filter(Boolean).join(" ");
}

function readDietText(plan?: DietPlan): string {
  if (!plan) return "";
  return JSON.stringify(plan);
}

function questionCount(text: string): number {
  return (text.match(/\?/g) || []).length;
}

function hasAny(text: string, terms: string[]): boolean {
  const normalized = normalize(text);
  return terms.some((term) => normalized.includes(normalize(term)));
}

function hasLanguageLeak(text: string, language: GutoLanguage): boolean {
  const normalized = normalize(text);
  if (!normalized.trim()) return false;
  if (language === "pt-BR") {
    return /\b(allenamento|ginocchio|spalla|palestra|dimagrire|riscaldamento|scheda|parti adesso|workout|warm up|full body strength)\b/i.test(normalized);
  }
  return /\b(treino|academia|joelho|ombro|emagrecer|hipertrofia|aquecimento|prancha|agachamento|peito|costas|biceps|triceps|começa|bora)\b/i.test(normalized);
}

function hasCalibrationReask(text: string, language: GutoLanguage): boolean {
  const normalized = normalize(text);
  const shared = /\b(idade|quantos anos|altura|peso|tem dor|dor ou limitacao|local|onde vai treinar|ritmo atual|body weight|height|how old)\b/i.test(normalized);
  const italian = /\b(eta|altezza|peso|dolore o limite|dolore o limitazione|dove ti alleni|ritmo attuale|mandami eta)\b/i.test(normalized);
  return shared || (language === "it-IT" && italian);
}

function hasLanguageReask(text: string): boolean {
  return /\b(idioma|lingua|language|portugues|italiano|english|espanol)\b/i.test(normalize(text));
}

function looksGenericChatbot(text: string): boolean {
  return /\b(como posso ajudar|assistente virtual|sou uma ia|sou um modelo|desculpe, nao|i am an ai|as an ai|how can i help|assistente neutro)\b/i.test(normalize(text));
}

function hasDirectionalGutoTone(text: string, language: GutoLanguage): boolean {
  const terms = language === "it-IT"
    ? ["andiamo", "parti", "allenamento", "missione", "adesso", "blocco", "guto"]
    : ["bora", "começa", "missão", "treino", "agora", "bloco", "guto"];
  return hasAny(text, terms);
}

function assertNoForbiddenFoods(plan: DietPlan | undefined, forbiddenFoods: string[]): void {
  if (forbiddenFoods.length === 0) return;
  const text = normalize(readDietText(plan));
  const found = forbiddenFoods.filter((food) => text.includes(normalize(food)));
  expect(found.length === 0, `dieta contém alimento proibido: ${found.join(", ")}`);
}

function hasDietRestrictionSummary(plan: DietPlan | undefined, profile: ScenarioProfile): boolean {
  const text = readDietText(plan);
  if (!profile.foodRestrictions || hasAny(profile.foodRestrictions, ["sem restrição", "como de tudo", "mangio tutto"])) {
    return Boolean(plan?.macros?.targetKcal && Array.isArray(plan.meals) && plan.meals.length >= 3);
  }
  return hasAny(text, [profile.foodRestrictions, ...profile.expected.forbiddenFoods.map((food) => `sem ${food}`)])
    || hasAny(String(plan?.foodRestrictions || ""), [profile.foodRestrictions]);
}

function isWorkoutGoalCoherent(plan: WorkoutPlan | undefined, profile: ScenarioProfile): boolean {
  if (!plan) return false;
  const visible = readVisibleWorkoutText(plan);
  const ids = plan.exercises.map((exercise) => exercise.id);
  if (profile.trainingGoal === "fat_loss" || profile.trainingGoal === "conditioning" || profile.trainingGoal === "consistency" || profile.trainingGoal === "mobility_health") {
    if (/\b(forca total|forza totale|full-body strength)\b/i.test(normalize(visible))) return false;
    return plan.exercises.length >= 4;
  }
  const conditioningIds = new Set(["burpee", "polichinelo", "perdigueiro"]);
  const conditioningCount = ids.filter((id) => conditioningIds.has(id)).length;
  return conditioningCount <= Math.floor(plan.exercises.length / 2);
}

function isWorkoutLocationCoherent(plan: WorkoutPlan | undefined, profile: ScenarioProfile): boolean {
  if (!plan) return false;
  const ids = plan.exercises.map((exercise) => exercise.id);
  const gymSignals = ids.some((id) => /maquina|polia|supino|legpress|cadeira|posterior|puxada|desenvolvimento/i.test(id));
  const homeHostileSignals = ids.some((id) => /maquina|polia|legpress|cadeira|posterior_deitado_maquina/i.test(id));
  if (profile.preferredTrainingLocation === "gym") return gymSignals;
  if (profile.preferredTrainingLocation === "home") return !homeHostileSignals;
  return plan.exercises.length >= 4;
}

function isWorkoutLimitationCoherent(plan: WorkoutPlan | undefined, responseText: string, profile: ScenarioProfile): boolean {
  if (!plan) return false;
  if (hasAny(profile.limitation, ["sem dor", "senza dolore"])) return true;
  const visible = `${responseText} ${readVisibleWorkoutText(plan)}`;
  const mentionsLimitation = hasAny(visible, profile.expected.limitationTerms);
  const mentionsCare = hasAny(visible, ["protege", "proteger", "cuidado", "sem irritar", "reduz", "adapta", "protetto", "proteggo", "riduc", "niente irritazione", "controll"]);
  return mentionsLimitation && mentionsCare;
}

function compactWorkoutLoaded(plan: WorkoutPlan | undefined): boolean {
  if (!plan) return false;
  return plan.exercises.length >= 4 && plan.exercises.length <= 10 && plan.exercises.every((exercise) => Boolean(exercise.videoUrl));
}

function locationMode(profile: ScenarioProfile): string {
  if (profile.preferredTrainingLocation === "home") return "home";
  return "gym";
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function getPromptText(init?: RequestInit): string {
  const body = parseJsonBody(init?.body);
  const contents = Array.isArray(body.contents) ? body.contents : [];
  const first = contents[0] as { parts?: Array<{ text?: string }> } | undefined;
  return first?.parts?.[0]?.text || "";
}

function makeDietModelResponse(prompt: string): Record<string, unknown> {
  const normalizedPrompt = normalize(prompt);
  const italian = /\b(italia|italiano|it-it|colazione|pranzo|cena|lattosio|vegana|vegetariano)\b/i.test(normalizedPrompt);
  const vegan = /\b(vegana|vegano|vegan)\b/i.test(normalizedPrompt);
  const vegetarian = vegan || /\b(vegetariana|vegetariano|vegetarian)\b/i.test(normalizedPrompt);
  const lactoseFree = /\b(lactose|lattosio|sem lactose|senza lattosio)\b/i.test(normalizedPrompt);

  const meal = (id: string, name: string, foods: Array<{ name: string; quantity: string; kcal: number }>): DietMeal => ({
    id,
    name,
    time: id === "breakfast" ? "08:00" : id === "lunch" ? "13:00" : id === "snack" ? "17:00" : "20:30",
    foods,
    totalKcal: foods.reduce((sum, food) => sum + food.kcal, 0),
    gutoNote: italian ? "Base semplice e coerente con il profilo." : "Base simples e coerente com o perfil.",
  });

  const meals = italian
    ? vegan
      ? [
          meal("breakfast", "Colazione", [{ name: "Avena", quantity: "70g", kcal: 270 }, { name: "Banana", quantity: "1 unit", kcal: 110 }, { name: "Tofu", quantity: "150g", kcal: 180 }]),
          meal("lunch", "Pranzo", [{ name: "Riso", quantity: "150g", kcal: 210 }, { name: "Lenticchie", quantity: "160g", kcal: 210 }, { name: "Verdure", quantity: "250g", kcal: 90 }, { name: "Olio di oliva", quantity: "15g", kcal: 135 }]),
          meal("snack", "Spuntino", [{ name: "Pane integrale", quantity: "90g", kcal: 220 }, { name: "Hummus", quantity: "80g", kcal: 210 }, { name: "Frutta", quantity: "1 unit", kcal: 80 }]),
          meal("dinner", "Cena", [{ name: "Tofu", quantity: "200g", kcal: 240 }, { name: "Patate", quantity: "250g", kcal: 210 }, { name: "Verdure", quantity: "250g", kcal: 90 }]),
        ]
      : vegetarian
        ? [
            meal("breakfast", "Colazione", [{ name: "Avena", quantity: "70g", kcal: 270 }, { name: "Banana", quantity: "1 unit", kcal: 110 }, { name: lactoseFree ? "Tofu" : "Uova", quantity: lactoseFree ? "150g" : "3 units", kcal: lactoseFree ? 180 : 220 }]),
            meal("lunch", "Pranzo", [{ name: "Riso", quantity: "150g", kcal: 210 }, { name: "Lenticchie", quantity: "160g", kcal: 210 }, { name: "Verdure", quantity: "250g", kcal: 90 }, { name: "Olio di oliva", quantity: "15g", kcal: 135 }]),
            meal("snack", "Spuntino", [{ name: "Pane integrale", quantity: "90g", kcal: 220 }, { name: "Hummus", quantity: "80g", kcal: 210 }]),
            meal("dinner", "Cena", [{ name: "Uova", quantity: "3 units", kcal: 220 }, { name: "Patate", quantity: "250g", kcal: 210 }, { name: "Verdure", quantity: "250g", kcal: 90 }]),
          ]
        : [
            meal("breakfast", "Colazione", [{ name: "Avena", quantity: "70g", kcal: 270 }, { name: "Banana", quantity: "1 unit", kcal: 110 }, { name: lactoseFree ? "Uova" : "Yogurt greco", quantity: lactoseFree ? "3 units" : "200g", kcal: lactoseFree ? 220 : 220 }]),
            meal("lunch", "Pranzo", [{ name: "Pollo", quantity: "180g", kcal: 300 }, { name: "Riso", quantity: "150g", kcal: 210 }, { name: "Verdure", quantity: "250g", kcal: 90 }, { name: "Olio di oliva", quantity: "15g", kcal: 135 }]),
            meal("snack", "Spuntino", [{ name: "Tonno", quantity: "140g", kcal: 220 }, { name: "Pane integrale", quantity: "90g", kcal: 220 }]),
            meal("dinner", "Cena", [{ name: "Uova", quantity: "3 units", kcal: 220 }, { name: "Patate", quantity: "250g", kcal: 210 }, { name: "Verdure", quantity: "250g", kcal: 90 }]),
          ]
    : vegetarian
      ? [
          meal("breakfast", "Café da manhã", [{ name: "Aveia", quantity: "70g", kcal: 270 }, { name: "Banana", quantity: "1 unidade", kcal: 110 }, { name: vegan ? "Tofu" : "Ovos", quantity: vegan ? "150g" : "3 unidades", kcal: vegan ? 180 : 220 }]),
          meal("lunch", "Almoço", [{ name: "Arroz", quantity: "150g", kcal: 210 }, { name: "Lentilha", quantity: "160g", kcal: 210 }, { name: "Legumes", quantity: "250g", kcal: 90 }, { name: "Azeite", quantity: "15g", kcal: 135 }]),
          meal("snack", "Lanche", [{ name: "Pão integral", quantity: "90g", kcal: 220 }, { name: "Hommus", quantity: "80g", kcal: 210 }]),
          meal("dinner", "Jantar", [{ name: vegan ? "Tofu" : "Ovos", quantity: vegan ? "200g" : "3 unidades", kcal: vegan ? 240 : 220 }, { name: "Batata", quantity: "250g", kcal: 210 }, { name: "Legumes", quantity: "250g", kcal: 90 }]),
        ]
      : [
          meal("breakfast", "Café da manhã", [{ name: "Aveia", quantity: "70g", kcal: 270 }, { name: "Banana", quantity: "1 unidade", kcal: 110 }, { name: lactoseFree ? "Ovos" : "Iogurte natural", quantity: lactoseFree ? "3 unidades" : "200g", kcal: lactoseFree ? 220 : 220 }]),
          meal("lunch", "Almoço", [{ name: "Frango", quantity: "180g", kcal: 300 }, { name: "Arroz", quantity: "150g", kcal: 210 }, { name: "Legumes", quantity: "250g", kcal: 90 }, { name: "Azeite", quantity: "15g", kcal: 135 }]),
          meal("snack", "Lanche", [{ name: "Atum", quantity: "140g", kcal: 220 }, { name: "Pão integral", quantity: "90g", kcal: 220 }]),
          meal("dinner", "Jantar", [{ name: "Ovos", quantity: "3 unidades", kcal: 220 }, { name: "Batata", quantity: "250g", kcal: 210 }, { name: "Legumes", quantity: "250g", kcal: 90 }]),
        ];

  return { candidates: [{ content: { parts: [{ text: JSON.stringify({ meals }) }] } }] };
}

function installFetchMock(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) {
      return originalFetch(input as Parameters<typeof fetch>[0], init);
    }

    const body = parseJsonBody(init?.body);
    const prompt = getPromptText(init);
    const generationConfig = body.generationConfig as { responseModalities?: string[]; responseMimeType?: string } | undefined;
    const isAudio = Array.isArray(generationConfig?.responseModalities) && generationConfig.responseModalities.includes("AUDIO");
    if (isAudio) {
      const model = url.match(/models\/([^:]+):generateContent/)?.[1] || "unknown";
      ttsRequests.push({ model, text: prompt });
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                mimeType: "audio/pcm;rate=24000",
                data: Buffer.alloc(960).toString("base64"),
              },
            }],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify(makeDietModelResponse(prompt)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function buildReportSummary(profileReport: ProfileReport) {
  const pass = profileReport.checks.filter((check) => check.status === "PASS").length;
  const fail = profileReport.checks.filter((check) => check.status === "FAIL").length;
  const warn = profileReport.checks.filter((check) => check.status === "WARN").length;
  const skip = profileReport.checks.filter((check) => check.status === "SKIP").length;
  return { pass, fail, warn, skip, total: pass + fail };
}

function markdownReport(reports: ProfileReport[]): string {
  const lines: string[] = ["# AUXILIARY MOCKED USER SCENARIOS", "", "> NOT PRODUCTION EVIDENCE: Gemini and Redis are disabled.", ""];
  let totalPass = 0;
  let totalFail = 0;
  let totalWarn = 0;
  let totalSkip = 0;

  for (const report of reports) {
    const summary = buildReportSummary(report);
    totalPass += summary.pass;
    totalFail += summary.fail;
    totalWarn += summary.warn;
    totalSkip += summary.skip;
    lines.push(`## ${report.name} ${report.language}: PASS ${summary.pass}/${summary.total} WARN ${summary.warn} SKIP ${summary.skip}`);
    const failed = report.checks.filter((check) => check.status === "FAIL");
    if (failed.length > 0) {
      lines.push("FAIL:");
      for (const failure of failed) lines.push(`- ${failure.area}: ${failure.message}`);
    }
    const warnings = report.checks.filter((check) => check.status === "WARN");
    if (warnings.length > 0) {
      lines.push("WARN:");
      for (const warning of warnings) lines.push(`- ${warning.area}: ${warning.message}`);
    }
    const skipped = report.checks.filter((check) => check.status === "SKIP");
    if (skipped.length > 0) {
      lines.push("SKIP:");
      for (const skip of skipped) lines.push(`- ${skip.area}: ${skip.message}`);
    }
    lines.push("");
  }

  lines.push("## TOTAL");
  lines.push(`PASS ${totalPass}/${totalPass + totalFail}`);
  lines.push(`FAIL ${totalFail}`);
  lines.push(`WARN ${totalWarn}`);
  lines.push(`SKIP ${totalSkip}`);
  lines.push("");
  return lines.join("\n");
}

async function recordCheck(
  report: ProfileReport,
  area: string,
  id: string,
  run: () => Promise<void> | void
): Promise<void> {
  try {
    await run();
    report.checks.push({ id, area, status: "PASS", message: id });
  } catch (error) {
    report.checks.push({
      id,
      area,
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function silenceServerConsole(): void {
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
}

function restoreConsole(): void {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
}

async function setup(): Promise<ScenarioContext> {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(memoryFile, JSON.stringify({}, null, 2));
  writeFileSync(dietFile, JSON.stringify({}, null, 2));
  mkdirSync(dirname(arenaFile), { recursive: true });
  writeFileSync(arenaFile, JSON.stringify({ profiles: {}, events: [] }, null, 2));

  process.env.GUTO_MEMORY_FILE = memoryFile;
  process.env.GUTO_DIET_FILE = dietFile;
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GUTO_ALLOW_DEV_ACCESS = "true";

  installFetchMock();
  silenceServerConsole();

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  const memoryStoreModule = (await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
    clearMemoryStoreCache: () => void;
  };
  const evolutionModule = (await import(pathToFileURL(join(process.cwd(), "src/guto-evolution.ts")).href)) as {
    getGutoEvolutionStage: (xp: number) => string;
  };

  app = serverModule.app;
  clearMemoryStoreCache = memoryStoreModule.clearMemoryStoreCache;
  getGutoEvolutionStage = evolutionModule.getGutoEvolutionStage;

  await new Promise<void>((resolve, reject) => {
    const localServer = app.listen(0, "127.0.0.1", () => resolve());
    server = localServer;
    localServer.once("error", reject);
  });
  if (!server) throw new Error("Failed to start real user scenarios server.");
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Failed to bind real user scenarios server.");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const postJson = async <T>(profile: ScenarioProfile, path: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: authHeaders(profile),
      body: JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({})) as T;
    return { status: response.status, body: parsed };
  };

  const getJson = async <T>(profile: ScenarioProfile, path: string): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: authHeaders(profile),
    });
    const parsed = await response.json().catch(() => ({})) as T;
    return { status: response.status, body: parsed };
  };

  return {
    baseUrl,
    chat: async (profile, input, history = []) => {
      const response = await fetch(`${baseUrl}/guto`, {
        method: "POST",
        headers: authHeaders(profile),
        body: JSON.stringify({
          language: profile.language,
          profile: { userId: profile.id, name: profile.name },
          history,
          input,
        }),
      });
      expect(response.status === 200, `POST /guto respondeu ${response.status}`);
      return await response.json() as GutoResponse;
    },
    getMemory: async (profile) => {
      const response = await getJson<MemoryRecord>(profile, "/guto/memory");
      expect(response.status === 200, `GET /guto/memory respondeu ${response.status}`);
      return response.body;
    },
    postMemory: async (profile, body) => postJson<MemoryRecord>(profile, "/guto/memory", body),
    postJson,
    getJson,
    resetTtsRequests: () => {
      ttsRequests.length = 0;
    },
    getTtsRequestCount: () => ttsRequests.length,
    getExpectedEvolutionStage: (xp: number) => getGutoEvolutionStage(xp),
  };
}

async function teardown(arenaSnapshot: FileSnapshot, existingValidationImages: Set<string>): Promise<void> {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  }
  restoreFile(arenaSnapshot);
  if (existsSync(validationImagesDir)) {
    for (const file of readdirSync(validationImagesDir)) {
      if (!existingValidationImages.has(file)) {
        rmSync(join(validationImagesDir, file), { force: true });
      }
    }
  }
  globalThis.fetch = originalFetch;
  clearMemoryStoreCache();
  restoreConsole();
}

async function runProfile(ctx: ScenarioContext, profile: ScenarioProfile): Promise<ProfileReport> {
  const report: ProfileReport = { id: profile.id, name: profile.name, language: profile.language, checks: [] };
  const state: ScenarioState = {};
  const getInitialResponse = async (): Promise<GutoResponse & { due?: boolean; slot?: string }> => {
    if (!state.initialResponse) {
      const response = await ctx.getJson<GutoResponse & { due?: boolean; slot?: string }>(profile, "/guto/proactive?force=1");
      expect(response.status === 200, `GET /guto/proactive?force=1 respondeu ${response.status}`);
      state.initialResponse = response.body;
    }
    return state.initialResponse;
  };

  await recordCheck(report, "onboarding", "language_persists", async () => {
    const response = await ctx.postMemory(profile, { language: profile.language });
    expect(response.status === 200, `POST /guto/memory idioma respondeu ${response.status}`);
    const memory = await ctx.getMemory(profile);
    expect(memory.language === profile.language, `idioma salvo=${memory.language}, esperado=${profile.language}`);
  });

  await recordCheck(report, "onboarding", "calibration_data_saved", async () => {
    const response = await ctx.postMemory(profile, {
      name: profile.name,
      confirmedName: true,
      language: profile.language,
      biologicalSex: profile.biologicalSex,
      userAge: profile.userAge,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      trainingLevel: profile.trainingLevel,
      trainingStatus: profile.trainingStatus,
      trainingGoal: profile.trainingGoal,
      preferredTrainingLocation: profile.preferredTrainingLocation,
      trainingLocation: profile.preferredTrainingLocation,
      trainingPathology: profile.limitation,
      trainingLimitations: profile.limitation,
      foodRestrictions: profile.foodRestrictions,
      country: profile.country,
      countryCode: profile.countryCode,
      city: profile.city,
      xpEvent: "grant_initial_xp",
      initialXpRewardSeen: true,
    });
    expect(response.status === 200, `POST /guto/memory calibragem respondeu ${response.status}`);
    const memory = await ctx.getMemory(profile);
    expect(memory.name === profile.name, `nome salvo=${memory.name}`);
    expect(memory.biologicalSex === profile.biologicalSex, `sexo salvo=${memory.biologicalSex}`);
    expect(memory.userAge === profile.userAge, `idade salva=${memory.userAge}`);
    expect(memory.heightCm === profile.heightCm, `altura salva=${memory.heightCm}`);
    expect(memory.weightKg === profile.weightKg, `peso salvo=${memory.weightKg}`);
    expect(memory.trainingGoal === profile.trainingGoal, `objetivo salvo=${memory.trainingGoal}`);
    expect(memory.preferredTrainingLocation === profile.preferredTrainingLocation, `local salvo=${memory.preferredTrainingLocation}`);
    expect(hasAny(String(memory.trainingLimitations || ""), profile.expected.limitationTerms), `limitação salva=${memory.trainingLimitations}`);
  });

  await recordCheck(report, "onboarding", "initial_xp_idempotent", async () => {
    const before = await ctx.getMemory(profile);
    const response = await ctx.postMemory(profile, { language: profile.language, xpEvent: "grant_initial_xp" });
    expect(response.status === 200, `POST xp pacto respondeu ${response.status}`);
    const after = await ctx.getMemory(profile);
    expect(after.initialXpGranted === true, "pacto não ficou marcado como concedido");
    expect(after.totalXp === before.totalXp, `XP do pacto duplicou: antes=${before.totalXp}, depois=${after.totalXp}`);
  });

  await recordCheck(report, "chat", "does_not_ask_language_again", async () => {
    const response = await getInitialResponse();
    expect(!hasLanguageReask(response.fala || ""), `reperguntou idioma: ${response.fala}`);
  });

  await recordCheck(report, "chat", "does_not_reask_calibrated_data", async () => {
    const response = await getInitialResponse();
    expect(!hasCalibrationReask(response.fala || "", profile.language), `reperguntou dado calibrado: ${response.fala}`);
  });

  await recordCheck(report, "chat", "guto_conducts_next_action", async () => {
    const response = await getInitialResponse();
    expect(hasDirectionalGutoTone(response.fala || "", profile.language), `não conduziu em persona: ${response.fala}`);
  });

  await recordCheck(report, "chat", "not_generic_chatbot", async () => {
    const response = await getInitialResponse();
    expect(!looksGenericChatbot(response.fala || ""), `virou chatbot genérico: ${response.fala}`);
  });

  await recordCheck(report, "chat", "no_question_flood_or_repetition", async () => {
    const response = await getInitialResponse();
    const fala = response.fala || "";
    expect(questionCount(fala) <= 1, `perguntas demais na mesma resposta: ${fala}`);
    const sentences = fala.split(/[.!?]+/).map((part) => normalize(part).trim()).filter(Boolean);
    expect(new Set(sentences).size === sentences.length, `repetiu frase na mesma resposta: ${fala}`);
  });

  await recordCheck(report, "chat", "respects_language_and_gender", async () => {
    const response = await getInitialResponse();
    expect(!hasLanguageLeak(response.fala || "", profile.language), `mistura de idioma na fala: ${response.fala}`);
    const memory = await ctx.getMemory(profile);
    expect(memory.biologicalSex === profile.biologicalSex, `sexo em memória mudou: ${memory.biologicalSex}`);
  });

  await recordCheck(report, "treino", "workout_generated", async () => {
    const response = await ctx.chat(profile, profile.prompts.start);
    state.workoutResponse = response;
    state.workoutPlan = response.workoutPlan || undefined;
    expect(response.acao === "updateWorkout", `ação esperada updateWorkout, veio ${response.acao}; fala=${response.fala}`);
    expect(Boolean(response.workoutPlan), `resposta não trouxe treino oficial; fala=${response.fala}`);
    expect((response.workoutPlan?.exercises || []).length >= 4, `treino com poucos exercícios: ${response.workoutPlan?.exercises?.length || 0}`);
  });

  await recordCheck(report, "treino", "goal_location_limitation_coherent", () => {
    expect(isWorkoutGoalCoherent(state.workoutPlan, profile), `treino incoerente com objetivo ${profile.trainingGoal}: ${readVisibleWorkoutText(state.workoutPlan)}`);
    expect(isWorkoutLocationCoherent(state.workoutPlan, profile), `treino incoerente com local ${profile.preferredTrainingLocation}: ${readVisibleWorkoutText(state.workoutPlan)}`);
    expect(isWorkoutLimitationCoherent(state.workoutPlan, state.workoutResponse?.fala || "", profile), `treino não evidencia respeito à limitação ${profile.limitation}: ${readVisibleWorkoutText(state.workoutPlan)}`);
  });

  await recordCheck(report, "treino", "workout_language_pure", () => {
    expect(!hasLanguageLeak(readVisibleWorkoutText(state.workoutPlan), profile.language), `treino mistura idioma: ${readVisibleWorkoutText(state.workoutPlan)}`);
  });

  await recordCheck(report, "treino", "compact_list_loaded_with_videos", () => {
    expect(compactWorkoutLoaded(state.workoutPlan), `lista compacta inválida ou sem vídeo: ${JSON.stringify(state.workoutPlan?.exercises || [])}`);
  });

  await recordCheck(report, "treino", "exercise_doubt_single_response", async () => {
    const response = await ctx.chat(profile, profile.prompts.exerciseDoubt);
    expect(response.acao !== "updateWorkout", `dúvida de exercício gerou treino novo: ${JSON.stringify(response)}`);
    expect(Boolean(response.fala && response.fala.length > 20), `dúvida sem resposta útil: ${response.fala}`);
    expect(questionCount(response.fala || "") <= 1, `dúvida gerou perguntas demais: ${response.fala}`);
    expect(!hasLanguageLeak(response.fala || "", profile.language), `dúvida misturou idioma: ${response.fala}`);
  });

  await recordCheck(report, "dieta", "diet_generated", async () => {
    const response = await ctx.postJson<DietPlan | { error?: string; message?: string }>(profile, "/guto/diet/generate", {
      language: profile.language,
      force: true,
    });
    expect(response.status === 200, `POST /guto/diet/generate respondeu ${response.status}: ${JSON.stringify(response.body)}`);
    state.dietPlan = response.body as DietPlan;
    expect(Array.isArray(state.dietPlan.meals) && state.dietPlan.meals.length >= 3, `dieta sem refeições suficientes: ${JSON.stringify(state.dietPlan)}`);
  });

  await recordCheck(report, "dieta", "diet_restriction_respected", () => {
    assertNoForbiddenFoods(state.dietPlan, profile.expected.forbiddenFoods);
  });

  await recordCheck(report, "dieta", "diet_language_and_summary", () => {
    expect(!hasLanguageLeak(readDietText(state.dietPlan), profile.language), `dieta mistura idioma: ${readDietText(state.dietPlan)}`);
    expect(hasDietRestrictionSummary(state.dietPlan, profile), `dieta não expõe resumo/tags de restrição/macros: ${readDietText(state.dietPlan)}`);
  });

  await recordCheck(report, "dieta", "diet_doubt_single_response", async () => {
    const response = await ctx.chat(profile, profile.prompts.dietDoubt);
    expect(response.acao !== "updateWorkout", `dúvida de dieta gerou treino novo: ${JSON.stringify(response)}`);
    expect(hasAny(response.fala || "", profile.language === "it-IT" ? ["dieta", "piano", "pasti", "colazione", "pranzo"] : ["dieta", "refei", "café", "almoço", "macros"]), `resposta não tratou dieta: ${response.fala}`);
    expect(questionCount(response.fala || "") <= 1, `dúvida de dieta gerou perguntas demais: ${response.fala}`);
    expect(!hasLanguageLeak(response.fala || "", profile.language), `dúvida de dieta misturou idioma: ${response.fala}`);
  });

  await recordCheck(report, "viagem", "travel_creates_one_event_and_asks_continuity_without_card", async () => {
    const response = await ctx.chat(profile, profile.prompts.travel);
    expect(hasAny(response.fala || "", profile.language === "it-IT" ? ["20 minuti", "adattato", "allenamento"] : ["20 minutos", "adaptado", "treino"]), `viagem não perguntou continuidade do treino: ${response.fala}`);
    expect(!hasCalibrationReask(response.fala || "", profile.language), `viagem reperguntou calibragem: ${response.fala}`);

    const memory = await ctx.getMemory(profile);
    const trip = memory.proactiveMemories?.find((item) => item.type === "trip" && item.status === "pending_confirmation");
    expect(Boolean(trip?.id), `viagem não criou memória pendente: ${JSON.stringify(memory.proactiveMemories)}`);
    expect(trip?.stage === "continuity_question", `viagem não ficou no estágio de continuidade: ${JSON.stringify(trip)}`);
    expect(response.expectedResponse?.context === "travel_training", `viagem não abriu contexto travel_training: ${JSON.stringify(response)}`);
    expect(memory.activeConversationContext?.kind === "travel_impact_confirmation", `viagem não persistiu contexto ativo: ${JSON.stringify(memory.activeConversationContext)}`);
    expect((response.turnDecision?.cards || []).length === 0, `viagem abriu card paralelo antes do impacto: ${JSON.stringify(response.turnDecision)}`);
    state.travelMemoryId = trip?.id;
  });

  await recordCheck(report, "viagem", "travel_unavailable_asks_final_confirmation_without_protecting_directly", async () => {
    const before = await ctx.getMemory(profile);
    const response = await ctx.chat(profile, profile.prompts.travelCannotTrain);
    const after = await ctx.getMemory(profile);
    expect(hasAny(response.fala || "", profile.language === "it-IT" ? ["conferma", "card", "giorno", "allenamento"] : ["confirma", "card", "dia", "sem treino"]), `indisponibilidade não pediu confirmação final: ${response.fala}`);
    expect(!hasCalibrationReask(response.fala || "", profile.language), `indisponibilidade reperguntou calibragem: ${response.fala}`);
    expect(after.totalXp === before.totalXp, `viagem alterou XP: antes=${before.totalXp}, depois=${after.totalXp}`);
    expect(!after.proactiveImpacts?.some((impact) => impact.status === "active" && impact.workoutEffect === "protected"), "viagem criou dia protegido antes da confirmação final");

    const pendingImpact = after.proactiveMemories?.find(
      (item) => item.type === "trip" && item.status === "pending_confirmation" && item.confirmationStage === "impact"
    );
    if (pendingImpact?.id) {
      const discard = await ctx.postJson<Record<string, unknown>>(profile, "/guto/proactivity/discard", { memoryId: pendingImpact.id });
      expect(discard.status === 200, `limpeza do card de impacto respondeu ${discard.status}: ${JSON.stringify(discard.body)}`);
    }
  });

  await recordCheck(report, "tempo_curto", "short_time_adapts_not_cancel", async () => {
    const response = await ctx.chat(profile, profile.prompts.shortTime);
    expect(hasAny(response.fala || "", profile.language === "it-IT" ? ["minuti", "blocco", "ridotto", "parti"] : ["minutos", "bloco", "curto", "reduz", "começa"]), `tempo curto não virou missão curta: ${response.fala}`);
    expect(!hasAny(response.fala || "", profile.language === "it-IT" ? ["annullo", "cancell", "domani"] : ["cancelo", "encerr", "amanhã a gente volta"]), `tempo curto cancelou automaticamente: ${response.fala}`);
  });

  await recordCheck(report, "dor_nova", "new_pain_updates_memory_and_adapts", async () => {
    const response = await ctx.chat(profile, profile.prompts.newPain);
    const memory = await ctx.getMemory(profile);
    expect(hasAny(String(memory.trainingLimitations || ""), profile.expected.newPainTerms), `nova dor não foi registrada: ${memory.trainingLimitations}`);
    expect(hasAny(response.fala || "", profile.language === "it-IT" ? ["dolore", "ginocchio", "riduc", "proteg", "legger", "impatto", "irritazione", "carico"] : ["dor", "joelho", "reduz", "protege", "leve"]), `nova dor não adaptou/protegeu: ${response.fala}`);
    expect(!hasCalibrationReask(response.fala || "", profile.language), `nova dor reperguntou "tem dor?": ${response.fala}`);
  });

  await recordCheck(report, "feedback", "negative_workout_feedback_opens_adjustment", async () => {
    const response = await ctx.chat(profile, profile.prompts.negativeFeedback);
    expect(hasAny(response.fala || "", profile.language === "it-IT" ? ["aggiust", "cambio", "cosa", "intensita", "esercizi"] : ["ajust", "troco", "mudo", "qual parte", "intensidade", "exercícios"]), `feedback não abriu ajuste: ${response.fala}`);
    expect(!hasAny(response.fala || "", ["deu um curto", "manda de novo", "mi si e inceppato", "rimandamelo"]), `feedback virou erro técnico: ${response.fala}`);
  });

  await recordCheck(report, "execucao", "workout_done_requires_validation_no_direct_xp", async () => {
    state.memoryBeforeDone = await ctx.getMemory(profile);
    const response = await ctx.chat(profile, profile.prompts.workoutDone);
    state.memoryAfterDone = await ctx.getMemory(profile);
    expect(hasAny(response.fala || "", profile.language === "it-IT" ? ["fatto", "valida", "xp", "come"] : ["feito", "valida", "xp", "como foi"]), `execução não conduziu validação: ${response.fala}`);
    expect(state.memoryAfterDone.totalXp === state.memoryBeforeDone.totalXp, `chat deu XP direto: antes=${state.memoryBeforeDone.totalXp}, depois=${state.memoryAfterDone.totalXp}`);
  });

  await recordCheck(report, "execucao", "validation_rejects_without_selfie", async () => {
    const plan = state.workoutPlan || (await ctx.getMemory(profile)).lastWorkoutPlan || undefined;
    const response = await ctx.postJson<Record<string, unknown>>(profile, "/guto/validate-workout", {
      workoutFocus: plan?.focusKey || "full_body",
      workoutLabel: plan?.focus || "Treino",
      locationMode: locationMode(profile),
      language: profile.language,
      workoutPlan: plan,
    });
    expect(response.status === 400, `validação sem selfie deveria ser 400, veio ${response.status}`);
    expect(String(response.body.error || "").includes("SELFIE_REQUIRED"), `erro sem selfie inesperado: ${JSON.stringify(response.body)}`);
  });

  await recordCheck(report, "xp_arena_percurso", "validated_workout_awards_xp_once", async () => {
    const before = await ctx.getMemory(profile);
    const plan = state.workoutPlan || before.lastWorkoutPlan || undefined;
    expect(Boolean(plan), "sem treino oficial para validar");
    const response = await ctx.postJson<Record<string, unknown>>(profile, "/guto/validate-workout", {
      imageBase64: ONE_PIXEL_PNG,
      workoutFocus: plan?.focusKey || "full_body",
      workoutLabel: plan?.focus || "Treino",
      locationMode: locationMode(profile),
      language: profile.language,
      workoutPlan: plan,
      feedback: { difficulty: "ok", energy: "ok" },
    });
    state.validationResponse = response.body;
    expect(response.status === 200, `validação com selfie respondeu ${response.status}: ${JSON.stringify(response.body)}`);
    const after = await ctx.getMemory(profile);
    state.memoryAfterValidation = after;
    expect(Number(after.totalXp || 0) === Number(before.totalXp || 0) + 100, `XP pós-validação incorreto: antes=${before.totalXp}, depois=${after.totalXp}`);
    const xpEvents = after.xpEvents || [];
    const workoutEvents = xpEvents.filter((event) => event.type === "complete_daily_mission");
    expect(workoutEvents.length === 1, `evento de treino deve aparecer uma vez, veio ${workoutEvents.length}`);
  });

  await recordCheck(report, "xp_arena_percurso", "duplicate_validation_does_not_duplicate_xp", async () => {
    const before = await ctx.getMemory(profile);
    const plan = state.workoutPlan || before.lastWorkoutPlan || undefined;
    const response = await ctx.postJson<Record<string, unknown>>(profile, "/guto/validate-workout", {
      imageBase64: ONE_PIXEL_PNG,
      workoutFocus: plan?.focusKey || "full_body",
      workoutLabel: plan?.focus || "Treino",
      locationMode: locationMode(profile),
      language: profile.language,
      workoutPlan: plan,
    });
    const after = await ctx.getMemory(profile);
    expect(response.status === 409, `segunda validação deveria ser 409, veio ${response.status}`);
    expect(after.totalXp === before.totalXp, `segunda validação duplicou XP: antes=${before.totalXp}, depois=${after.totalXp}`);
  });

  await recordCheck(report, "xp_arena_percurso", "arena_weekly_monthly_individual_consistent", async () => {
    const weekly = await ctx.getJson<{ items?: Array<{ userId?: string; xp?: number }> }>(profile, "/guto/arena/weekly");
    const monthly = await ctx.getJson<{ items?: Array<{ userId?: string; xp?: number }> }>(profile, "/guto/arena/monthly");
    const individual = await ctx.getJson<{ items?: Array<{ userId?: string; xp?: number }> }>(profile, "/guto/arena/individual");
    expect(weekly.status === 200 && monthly.status === 200 && individual.status === 200, `arena status semanal/mensal/individual = ${weekly.status}/${monthly.status}/${individual.status}`);
    const weeklyItem = weekly.body.items?.find((item) => item.userId === profile.id);
    const monthlyItem = monthly.body.items?.find((item) => item.userId === profile.id);
    const individualItem = individual.body.items?.find((item) => item.userId === profile.id);
    expect(Number(weeklyItem?.xp || 0) >= 100, `arena semanal não contou treino validado: ${JSON.stringify(weekly.body)}`);
    expect(Number(monthlyItem?.xp || 0) >= 100, `arena mensal não contou treino validado: ${JSON.stringify(monthly.body)}`);
    expect(Number(individualItem?.xp || 0) >= 200, `arena individual não contém pacto+treino: ${JSON.stringify(individual.body)}`);
  });

  await recordCheck(report, "xp_arena_percurso", "daily_path_and_evolution_consistent", async () => {
    const memory = await ctx.getMemory(profile);
    const day = todayKey();
    const dayXp = (memory.xpEvents || [])
      .filter((event) =>
        event.type !== "grant_initial_xp" &&
        (event.date === day || String(event.createdAt || "").startsWith(day))
      )
      .reduce((sum, event) => sum + Number(event.xp ?? event.amount ?? 0), 0);
    expect(dayXp === 100, `percurso do dia deve refletir só o treino, sem o buffer do pacto: dayXp=${dayXp}, eventos=${JSON.stringify(memory.xpEvents)}`);
    const me = await ctx.getJson<{ totalXp?: number; avatarStage?: string }>(profile, "/guto/arena/me");
    expect(me.status === 200, `arena/me respondeu ${me.status}`);
    const expectedStage = ctx.getExpectedEvolutionStage(Number(me.body.totalXp || 0));
    expect(me.body.avatarStage === expectedStage, `evolução inconsistente: arena=${me.body.avatarStage}, esperado=${expectedStage}, xp=${me.body.totalXp}`);
  });

  await recordCheck(report, "voz_audio", "voice_one_click_one_audio_correct_language", async () => {
    ctx.resetTtsRequests();
    const response = await ctx.postJson<GutoResponse>(profile, "/voz", {
      text: profile.prompts.voiceText,
      language: profile.language === "it-IT" ? "pt-BR" : "it-IT",
    });
    state.voiceResponse = response.body;
    expect(response.status === 200, `POST /voz respondeu ${response.status}: ${JSON.stringify(response.body)}`);
    expect(Boolean(response.body.audioContent), "voz não retornou audioContent");
    expect(response.body.mimeType === "audio/wav", `mimeType inesperado: ${response.body.mimeType}`);
    expect(response.body.languageCode === profile.language, `TTS não respeitou idioma da memória: ${response.body.languageCode} vs ${profile.language}`);
    expect(ctx.getTtsRequestCount() === 1, `um clique disparou ${ctx.getTtsRequestCount()} sínteses`);
  });

  return report;
}

async function main(): Promise<void> {
  const arenaSnapshot = snapshotFile(arenaFile);
  const existingValidationImages = existsSync(validationImagesDir)
    ? new Set(readdirSync(validationImagesDir))
    : new Set<string>();

  let reports: ProfileReport[] = [];
  try {
    const ctx = await setup();
    reports = [];
    for (const profile of profiles) {
      reports.push(await runProfile(ctx, profile));
    }
  } finally {
    await teardown(arenaSnapshot, existingValidationImages).catch((error) => {
      restoreConsole();
      writeLine(`WARN teardown: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  const totals = reports.reduce(
    (acc, report) => {
      const summary = buildReportSummary(report);
      acc.pass += summary.pass;
      acc.fail += summary.fail;
      acc.warn += summary.warn;
      acc.skip += summary.skip;
      acc.total += summary.total;
      return acc;
    },
    { pass: 0, fail: 0, warn: 0, skip: 0, total: 0 }
  );

  const jsonReport = {
    title: "AUXILIARY MOCKED USER SCENARIOS",
    productionEvidenceEligible: false,
    limitations: ["Gemini disabled", "Redis disabled", "local file stores", "mocked model responses"],
    generatedAt: new Date().toISOString(),
    profiles: reports.map((report) => ({ ...report, summary: buildReportSummary(report) })),
    totals,
    reportFiles: {
      json: reportJsonFile,
      markdown: reportMdFile,
    },
  };

  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(reportJsonFile, JSON.stringify(jsonReport, null, 2));
  writeFileSync(reportMdFile, markdownReport(reports));

  writeLine("AUXILIARY MOCKED USER SCENARIOS");
  writeLine("NOT PRODUCTION EVIDENCE — Gemini and Redis are disabled.");
  writeLine("");
  for (const report of reports) {
    const summary = buildReportSummary(report);
    writeLine(`${report.name} ${report.language}: PASS ${summary.pass}/${summary.total} WARN ${summary.warn} SKIP ${summary.skip}`);
    const failures = report.checks.filter((check) => check.status === "FAIL");
    if (failures.length > 0) {
      writeLine("FAIL:");
      for (const failure of failures) writeLine(`- ${failure.area}: ${failure.message}`);
    }
    writeLine("");
  }
  writeLine("TOTAL:");
  writeLine(`PASS ${totals.pass}/${totals.total}`);
  writeLine(`FAIL ${totals.fail}`);
  writeLine(`WARN ${totals.warn}`);
  writeLine(`SKIP ${totals.skip}`);
  writeLine("");
  writeLine(`report.json: ${reportJsonFile}`);
  writeLine(`report.md: ${reportMdFile}`);

  if (totals.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  restoreConsole();
  writeLine("AUXILIARY MOCKED USER SCENARIOS");
  writeLine("FAIL:");
  writeLine(`- infraestrutura: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
