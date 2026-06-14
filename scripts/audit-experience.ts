/**
 * AUDITORIA DE EXPERIÊNCIA REAL — GUTO
 *
 * NÃO é teste. É simulação de usuário humano.
 * Avalia o que um usuário SENTE nos primeiros 2 minutos de uso.
 *
 * 6 perfis reais. Conversas multi-turn. Gemini real.
 * Detecta: linguagem errada, chat que abandona, treino aleatório,
 * dieta que ignora restrição, XP incompreensível, condutor fraco.
 *
 * Executar: cd guto-backend && ./node_modules/.bin/tsx scripts/audit-experience.ts
 */

process.env.GUTO_DISABLE_LISTEN = "1";
process.env.GUTO_ALLOW_DEV_ACCESS = "true";
process.env.JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
process.env.GUTO_DISABLE_REDIS_FOR_TESTS = "1";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const backendDir = process.cwd();
const tmpDir = join(backendDir, "tmp");
const memFile = join(tmpDir, "guto-memory.audit-experience.json");
mkdirSync(tmpDir, { recursive: true });
writeFileSync(memFile, JSON.stringify({}, null, 2));
process.env.GUTO_MEMORY_FILE = memFile;

// ─── Tipos ──────────────────────────────────────────────────────────────────

interface GutoResponse {
  fala?: string;
  acao?: string;
  workoutPlan?: any;
  dietPlan?: any;
  xpAward?: number;
  memoryPatch?: Record<string, unknown>;
  askCritical?: string;
  askSoft?: string;
  redirectedTo?: string;
}

interface UXFlag {
  severity: "BLOCKER" | "MAJOR" | "MINOR" | "INFO";
  profile: string;
  turn: string;
  issue: string;
  evidence: string;
}

const flags: UXFlag[] = [];

// ─── Perfis ─────────────────────────────────────────────────────────────────

const PROFILES = [
  {
    id: "ux-a",
    label: "PERFIL A — pt-BR / academia / fat_loss / joelho",
    language: "pt-BR",
    memory: {
      name: "Marina",
      language: "pt-BR",
      biologicalSex: "female",
      userAge: 32,
      heightCm: 165,
      weightKg: 72,
      trainingLevel: "beginner",
      trainingGoal: "fat_loss",
      preferredTrainingLocation: "gym",
      trainingLocation: "gym",
      trainingPathology: "dor no joelho direito, evitar agachamento profundo",
      trainingLimitations: "joelho direito",
      country: "Brasil",
      countryCode: "BR",
      foodRestrictions: "nenhuma",
      trainingStatus: "voltando",
      initialXpGranted: true,
      totalXp: 0,
      streak: 0,
    },
    turns: [
      "oi, bora treinar hoje?",
      "Qual treino vem depois desse?",
      "Posso trocar o supino por halter?",
    ],
    dietTurn: "quero minha dieta de hoje",
    checks: ["fat_loss_density", "joelho_ok", "pt_language"],
  },
  {
    id: "ux-b",
    label: "PERFIL B — pt-BR / academia / muscle_gain",
    language: "pt-BR",
    memory: {
      name: "Rafael",
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 26,
      heightCm: 178,
      weightKg: 80,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      preferredTrainingLocation: "gym",
      trainingLocation: "gym",
      trainingPathology: "sem dor",
      trainingLimitations: "sem limitações",
      country: "Brasil",
      countryCode: "BR",
      foodRestrictions: "nenhuma",
      trainingStatus: "treinando regularmente",
      initialXpGranted: true,
      totalXp: 500,
      streak: 5,
    },
    turns: [
      "bora treinar",
      "esse descanso de 90s é muito? posso reduzir?",
      "já fiz o treino, ficou pesado mesmo",
    ],
    dietTurn: "manda minha dieta de hoje",
    checks: ["muscle_gain_hypertrophy", "no_supersets", "pt_language"],
  },
  {
    id: "ux-c",
    label: "PERFIL C — it-IT / vegetariano / ginocchio",
    language: "it-IT",
    memory: {
      name: "Giulia",
      language: "it-IT",
      biologicalSex: "female",
      userAge: 29,
      heightCm: 162,
      weightKg: 58,
      trainingLevel: "consistent",
      trainingGoal: "fat_loss",
      preferredTrainingLocation: "gym",
      trainingLocation: "gym",
      trainingPathology: "ginocchio sinistro sensibile, evitare squat profondi",
      trainingLimitations: "ginocchio sinistro",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "vegetariana",
      trainingStatus: "mi alleno regolarmente",
      initialXpGranted: true,
      totalXp: 200,
      streak: 3,
    },
    turns: [
      "ciao, alleniamoci oggi",
      "va bene questo workout?",
      "ho fatto l'allenamento, è andato bene",
    ],
    dietTurn: "mandami la mia dieta di oggi",
    checks: ["ginocchio_ok", "no_pt_in_it", "vegetarian_diet", "it_language"],
  },
  {
    id: "ux-d",
    label: "PERFIL D — pt-BR / casa+academia+parque / fat_loss",
    language: "pt-BR",
    memory: {
      name: "Camila",
      language: "pt-BR",
      biologicalSex: "female",
      userAge: 35,
      heightCm: 168,
      weightKg: 65,
      trainingLevel: "returning",
      trainingGoal: "fat_loss",
      preferredTrainingLocation: "home",
      trainingLocation: "home",
      trainingPathology: "sem dor",
      trainingLimitations: "sem limitações",
      country: "Brasil",
      countryCode: "BR",
      foodRestrictions: "nenhuma",
      trainingStatus: "voltando depois de 3 meses parada",
      initialXpGranted: true,
      totalXp: 50,
      streak: 1,
    },
    turns: [
      "bora treinar, mas hoje só tenho casa",
      "e se eu for ao parque hoje?",
      "treino feito!",
    ],
    dietTurn: "quero minha dieta",
    checks: ["location_home", "location_switch", "pt_language"],
  },
  {
    id: "ux-e",
    label: "PERFIL E — pt-BR / múltiplas limitações / muscle_gain",
    language: "pt-BR",
    memory: {
      name: "Roberto",
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 45,
      heightCm: 175,
      weightKg: 88,
      trainingLevel: "advanced",
      trainingGoal: "muscle_gain",
      preferredTrainingLocation: "gym",
      trainingLocation: "gym",
      trainingPathology: "ombro direito operado (manguito rotador), joelho esquerdo com condromalácia, lombar sensível (hérnia L4-L5)",
      trainingLimitations: "ombro direito, joelho esquerdo, lombar",
      country: "Brasil",
      countryCode: "BR",
      foodRestrictions: "nenhuma",
      trainingStatus: "treinando com restrições",
      initialXpGranted: true,
      totalXp: 1200,
      streak: 8,
    },
    turns: [
      "quero treinar hoje",
      "esse treino não vai piorar o ombro?",
      "valei o treino, pesado mas controlado",
    ],
    dietTurn: "manda minha dieta",
    checks: ["ombro_ok", "joelho_ok", "lombar_ok", "advanced_volume", "pt_language"],
  },
  {
    id: "ux-f-student",
    label: "PERFIL F-student — pt-BR / aluno gerenciado por coach",
    language: "pt-BR",
    memory: {
      name: "Pedro",
      language: "pt-BR",
      biologicalSex: "male",
      userAge: 22,
      heightCm: 180,
      weightKg: 75,
      trainingLevel: "beginner",
      trainingGoal: "muscle_gain",
      preferredTrainingLocation: "gym",
      trainingLocation: "gym",
      trainingPathology: "sem dor",
      trainingLimitations: "sem limitações",
      country: "Brasil",
      countryCode: "BR",
      foodRestrictions: "nenhuma",
      trainingStatus: "nunca treinou de forma estruturada",
      initialXpGranted: true,
      totalXp: 0,
      streak: 0,
    },
    turns: [
      "oi GUTO, meu coach disse pra falar com você",
      "como funciona o XP aqui?",
      "bora treinar então",
    ],
    dietTurn: "quero saber minha dieta",
    checks: ["beginner_volume", "xp_explanation", "pt_language"],
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedMemory(userId: string, data: Record<string, unknown>, clearFn: () => void) {
  const store = existsSync(memFile) ? JSON.parse(readFileSync(memFile, "utf8")) : {};
  store[userId] = { userId, ...data };
  writeFileSync(memFile, JSON.stringify(store, null, 2));
  clearFn();
}

async function chat(
  baseUrl: string,
  userId: string,
  input: string,
  secret: string,
  language = "pt-BR",
  role = "student"
): Promise<GutoResponse> {
  const token = jwt.sign({ userId, role }, secret);
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language, profile: { userId, name: "Audit" }, history: [], input }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`);
  }
  return r.json();
}

async function generateDiet(
  baseUrl: string,
  userId: string,
  secret: string,
  language = "pt-BR"
): Promise<any> {
  const token = jwt.sign({ userId, role: "student" }, secret);
  const r = await fetch(`${baseUrl}/guto/diet/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language }),
  });
  const data = await r.json().catch(() => ({ error: "não parsou JSON" }));
  return { status: r.status, data };
}

function readMemory(userId: string): Record<string, unknown> {
  const store = existsSync(memFile) ? JSON.parse(readFileSync(memFile, "utf8")) : {};
  return store[userId] || {};
}

// ─── Detecção de UX Issues ───────────────────────────────────────────────────

const PT_WORDS_IN_IT = [
  /\bserie\b(?![\w])/i,  // "séries" in pt vs "serie" in it — but "serie" is also it, so check accent
  /séries/i,
  /treino\b/i,
  /\bhoje\b/i,
  /\bbora\b/i,
  /\bpeso\b/i,
  /\baqui\b/i,
  /\bnão\b/i,
  /\bvocê\b/i,
  /\btambém\b/i,
  /\bcom\b(?! (?:stamattina|sé|calma|cura|forza|attenzione))/i,  // "com" PT vs "con" IT
  /Progressao\b/i,
  /Ajuste GUTO/i,
  /Avançado:/i,
  /Nível (inicial|avançado)/i,
];

function detectPortugueseInItalian(text: string): string[] {
  const violations: string[] = [];
  for (const pattern of PT_WORDS_IN_IT) {
    const match = text.match(pattern);
    if (match) violations.push(`"${match[0]}" (regex: ${pattern.source})`);
  }
  return violations;
}

function checkExercisesForPathology(
  exercises: any[],
  pathology: string
): { violation: boolean; found: string[] } {
  const violations: string[] = [];
  const allText = (ex: any) =>
    [ex.id, ex.name, ex.canonicalNamePt, ex.note, ex.cue].filter(Boolean).join(" ").toLowerCase();

  if (pathology.includes("joelho") || pathology.includes("ginocchio")) {
    exercises.forEach((ex) => {
      if (/agach|squat|leg.press|cadeira.ext|afundo|split|lunge|jump|polichinelo|salto/i.test(allText(ex))) {
        violations.push(ex.name || ex.id);
      }
    });
  }
  if (pathology.includes("ombro")) {
    exercises.forEach((ex) => {
      if (/desenvolvimento|overhead|military press|shoulder press|elevacao.frontal|crucifixo inclinado/i.test(allText(ex))) {
        violations.push(ex.name || ex.id);
      }
    });
  }
  if (pathology.includes("lombar")) {
    exercises.forEach((ex) => {
      if (/levantamento terra|deadlift|good morning|stiff|hiperextensao/i.test(allText(ex))) {
        violations.push(ex.name || ex.id);
      }
    });
  }
  return { violation: violations.length > 0, found: violations };
}

function checkFatLossDensity(exercises: any[]): { hasSuperset: boolean; avgRest: number; avgReps: string } {
  const main = exercises.filter((e) => e.muscleGroup !== "aquecimento");
  const restValues = main.map((e) => {
    const r = String(e.rest || "0").replace(/[^0-9]/g, "");
    return parseInt(r) || 0;
  });
  const avgRest = restValues.length ? restValues.reduce((a, b) => a + b, 0) / restValues.length : 999;
  const hasSuperset = main.some((e) => {
    const note = (e.note || "").toLowerCase();
    return note.includes("superset") || (e.rest === "0s" || e.rest === "0");
  });
  const firstReps = main[0]?.reps || "?";
  return { hasSuperset, avgRest: Math.round(avgRest), avgReps: firstReps };
}

function checkMuscleDensity(exercises: any[]): { hasEccentric: boolean; avgRest: number } {
  const main = exercises.filter((e) => e.muscleGroup !== "aquecimento");
  const restValues = main.map((e) => {
    const r = String(e.rest || "0").replace(/[^0-9]/g, "");
    return parseInt(r) || 0;
  });
  const avgRest = restValues.length ? restValues.reduce((a, b) => a + b, 0) / restValues.length : 0;
  const allText = exercises.map((e) => [e.cue, e.note].filter(Boolean).join(" ")).join(" ").toLowerCase();
  const hasEccentric = /exc[eê]ntric|descida (em|de) [23]/i.test(allText);
  return { hasEccentric, avgRest: Math.round(avgRest) };
}

function checkVegetarianDiet(dietPlan: any): { violation: boolean; found: string[] } {
  const violations: string[] = [];
  if (!dietPlan) return { violation: false, found: [] };
  const allText = JSON.stringify(dietPlan).toLowerCase();
  const meats = ["frango", "carne", "peixe", "atum", "salmão", "camarão", "tilápia", "file", "bife",
    "chicken", "beef", "fish", "tuna", "salmon", "shrimp", "pollo", "manzo", "pesce", "tonno"];
  meats.forEach((meat) => {
    if (allText.includes(meat)) violations.push(meat);
  });
  return { violation: violations.length > 0, found: violations };
}

function flagIssue(
  profile: string,
  turn: string,
  severity: UXFlag["severity"],
  issue: string,
  evidence: string
) {
  flags.push({ severity, profile, turn, issue, evidence });
  const icon = severity === "BLOCKER" ? "🔴" : severity === "MAJOR" ? "🟠" : severity === "MINOR" ? "🟡" : "ℹ️";
  console.log(`  ${icon} [${severity}] ${issue}`);
  console.log(`     Evidência: ${evidence.slice(0, 200)}`);
}

function printResponse(label: string, res: GutoResponse, language: string) {
  console.log(`\n  ── ${label} ───────────────────────────────────`);
  console.log(`  Ação   : ${res.acao || "(não definida)"}`);
  console.log(`  Fala   : ${res.fala || "(sem fala)"}`);
  if (res.xpAward) console.log(`  XP     : +${res.xpAward}`);
  if (res.askCritical) console.log(`  Pergunta crítica: ${res.askCritical}`);
  if (res.askSoft) console.log(`  Pergunta soft: ${res.askSoft}`);
  if (res.redirectedTo) console.log(`  Redirecionado para: ${res.redirectedTo}`);

  if (language === "it-IT" && res.fala) {
    const ptFound = detectPortugueseInItalian(res.fala);
    if (ptFound.length > 0) {
      console.log(`  ⚠ MISTURA DE IDIOMA na fala: ${ptFound.join(", ")}`);
    }
  }
}

function printWorkout(plan: any, language: string) {
  if (!plan) {
    console.log("  ⚠ lastWorkoutPlan = null");
    return;
  }
  const exercises: any[] = plan.exercises || [];
  const warmup = exercises.filter((e) => e.muscleGroup === "aquecimento");
  const main = exercises.filter((e) => e.muscleGroup !== "aquecimento");

  console.log(`\n  ── TREINO ─────────────────────────────────────────────`);
  console.log(`  Focus  : ${plan.focus}`);
  console.log(`  Local  : ${plan.locationMode || "(não definido)"}`);
  console.log(`  Nível  : ${plan.difficulty || "(não definido)"}`);
  console.log(`  Resumo : ${plan.summary}`);
  console.log(`  Exercícios: ${exercises.length} (${warmup.length} aquec. + ${main.length} principais)`);

  for (const ex of exercises) {
    const name = ex.name || ex.canonicalNamePt || ex.id;
    console.log(`    • ${name} [${ex.muscleGroup}] — ${ex.sets}×${ex.reps} desc:${ex.rest || "—"}`);
    if (ex.note) console.log(`      nota: ${ex.note}`);
  }

  if (language === "it-IT") {
    const allExText = exercises.map((e) => [e.note, e.cue, e.name].filter(Boolean).join(" ")).join("\n");
    const ptFound = detectPortugueseInItalian(allExText);
    if (ptFound.length > 0) {
      console.log(`\n  ⚠ MISTURA DE IDIOMA nos exercícios: ${ptFound.join(", ")}`);
    }
  }
}

function printDiet(dietData: { status: number; data: any }, language: string) {
  console.log(`\n  ── DIETA ──────────────────────────────────────────────`);
  console.log(`  Status HTTP: ${dietData.status}`);
  if (dietData.status !== 200) {
    console.log(`  Erro: ${JSON.stringify(dietData.data).slice(0, 300)}`);
    return;
  }
  const plan = dietData.data;
  const meals: any[] = plan?.meals || plan?.plan?.meals || [];
  console.log(`  Refeições: ${meals.length}`);
  if (meals.length > 0) {
    console.log(`  Calorias totais: ${plan?.totalCalories || plan?.plan?.totalCalories || "?"}`);
    meals.slice(0, 3).forEach((m: any) => {
      console.log(`    • ${m.name || m.meal}: ${(m.items || m.foods || []).map((i: any) => i.name || i.food).slice(0, 3).join(", ")}`);
    });
    if (meals.length > 3) console.log(`    ... +${meals.length - 3} refeições`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     GUTO — AUDITORIA DE EXPERIÊNCIA REAL                ║");
  console.log("║     Gemini: " + (process.env.GEMINI_API_KEY ? "✅ REAL                                  ║" : "⚠  AUSENTE (mockado)                    ║"));
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const { app } = await import(pathToFileURL(join(backendDir, "server.ts")).href) as any;
  const { clearMemoryStoreCache: clear } = await import(
    pathToFileURL(join(backendDir, "src/memory-store.ts")).href
  ) as any;

  const server: Server = await new Promise((resolve, reject) => {
    const s = (app as any).listen(0, "127.0.0.1", () => resolve(s as unknown as Server));
    (s as any).once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const secret = process.env.JWT_SECRET!;

  // ─── Testar cada perfil ──────────────────────────────────────────────────

  for (const profile of PROFILES) {
    console.log(`\n${"═".repeat(66)}`);
    console.log(`▶ ${profile.label}`);
    console.log(`${"═".repeat(66)}`);

    seedMemory(profile.id, profile.memory, clear);

    // Turn 1 — primeira mensagem
    let firstResponse: GutoResponse;
    try {
      firstResponse = await chat(baseUrl, profile.id, profile.turns[0], secret, profile.language);
      printResponse("TURN 1 — primeiro contato", firstResponse, profile.language);

      // Verificar se GUTO usa nome do usuário
      const name = (profile.memory as any).name;
      if (firstResponse.fala && !firstResponse.fala.includes(name) && profile.language !== "it-IT") {
        // Nota: nem sempre usa o nome, não é necessariamente bug
      }

      // Verificar se GUTO conduz ou abandona
      if (firstResponse.acao === "idle" && !firstResponse.fala) {
        flagIssue(profile.label, "Turn 1", "BLOCKER", "GUTO retornou ação 'idle' sem fala", `acao=${firstResponse.acao}`);
      }

      // Verificar linguagem da resposta
      if (profile.language === "it-IT" && firstResponse.fala) {
        const ptViolations = detectPortugueseInItalian(firstResponse.fala);
        if (ptViolations.length > 0) {
          flagIssue(profile.label, "Turn 1 fala", "MAJOR", "Português detectado em resposta italiana",
            `Palavras: ${ptViolations.join(", ")} | Texto: "${firstResponse.fala.slice(0, 100)}"`);
        }
      }

      // Se gerou treino logo no turn 1, avaliar
      if (firstResponse.workoutPlan) {
        printWorkout(firstResponse.workoutPlan, profile.language);
        const exercises: any[] = firstResponse.workoutPlan.exercises || [];
        const pathology = (profile.memory as any).trainingPathology || "";
        const { violation, found } = checkExercisesForPathology(exercises, pathology);
        if (violation) {
          flagIssue(profile.label, "Turn 1 treino", "BLOCKER",
            "Exercícios violam limitação física", `Exercícios: ${found.join(", ")}`);
        }

        // Verificar locationMode
        if (!firstResponse.workoutPlan.locationMode) {
          flagIssue(profile.label, "Turn 1 treino", "MAJOR",
            "locationMode ausente no lastWorkoutPlan", "workoutPlan.locationMode = undefined");
        }

        // Fat loss density check
        if (profile.checks.includes("fat_loss_density")) {
          const { hasSuperset, avgRest } = checkFatLossDensity(exercises);
          if (!hasSuperset && avgRest > 75) {
            flagIssue(profile.label, "Turn 1 treino", "MAJOR",
              "Fat loss sem densidade metabólica — sem supersets e descanso alto",
              `avgRest=${avgRest}s, hasSuperset=${hasSuperset}`);
          } else {
            console.log(`  ✅ Fat loss density: supersets=${hasSuperset}, avgRest=${avgRest}s`);
          }
        }

        // Muscle gain check
        if (profile.checks.includes("muscle_gain_hypertrophy")) {
          const { hasEccentric, avgRest } = checkMuscleDensity(exercises);
          if (avgRest < 60) {
            flagIssue(profile.label, "Turn 1 treino", "MAJOR",
              "Muscle gain com descanso insuficiente para hipertrofia",
              `avgRest=${avgRest}s (esperado ≥75s)`);
          } else {
            console.log(`  ✅ Muscle gain: eccentric=${hasEccentric}, avgRest=${avgRest}s`);
          }
          if (profile.checks.includes("no_supersets")) {
            const main = exercises.filter((e) => e.muscleGroup !== "aquecimento");
            const hasSuperset = main.some((e) => e.rest === "0s" || e.rest === "0" || (e.note || "").toLowerCase().includes("superset"));
            if (hasSuperset) {
              flagIssue(profile.label, "Turn 1 treino", "MINOR",
                "Muscle gain com superset — pode comprometer progressão de carga",
                "Superset detectado em treino de hipertrofia");
            }
          }
        }

        // Avançado: volume
        if (profile.checks.includes("advanced_volume")) {
          const main = exercises.filter((e) => e.muscleGroup !== "aquecimento");
          const hasHighSets = main.some((e) => Number(e.sets) >= 4);
          if (!hasHighSets) {
            flagIssue(profile.label, "Turn 1 treino", "MINOR",
              "Perfil avançado sem ≥4 séries em algum exercício",
              `Max sets: ${Math.max(...main.map((e) => Number(e.sets) || 0))}`);
          } else {
            console.log(`  ✅ Advanced volume: alta série detectada`);
          }
        }

        // Iniciante: não sobrecarregar
        if (profile.checks.includes("beginner_volume")) {
          const main = exercises.filter((e) => e.muscleGroup !== "aquecimento");
          const hasOverload = main.some((e) => Number(e.sets) > 4);
          if (hasOverload) {
            flagIssue(profile.label, "Turn 1 treino", "MINOR",
              "Iniciante com >4 séries — pode ser sobrecarga",
              `Max sets: ${Math.max(...main.map((e) => Number(e.sets) || 0))}`);
          }
        }

        // Verificar exercícios no idioma errado (it-IT deve ter nomes em italiano ou português neutro)
        if (profile.language === "it-IT") {
          const allNotes = exercises.map((e) => [e.note, e.cue].filter(Boolean).join(" ")).join(" ");
          const ptViolations = detectPortugueseInItalian(allNotes);
          if (ptViolations.length > 0) {
            flagIssue(profile.label, "Turn 1 exercícios", "MAJOR",
              "Texto em português nas notas/cues dos exercícios",
              `Encontrado: ${ptViolations.join(", ")}`);
          } else {
            console.log(`  ✅ Idioma it-IT: sem português nas notas de exercícios`);
          }
        }
      }
    } catch (e: any) {
      flagIssue(profile.label, "Turn 1", "BLOCKER", "Erro HTTP no primeiro turn", e.message);
      console.error(`  ❌ Erro Turn 1: ${e.message}`);
      continue;
    }

    // Turn 2 — follow-up
    if (profile.turns[1]) {
      console.log(`\n  → Enviando Turn 2: "${profile.turns[1]}"`);
      try {
        const res2 = await chat(baseUrl, profile.id, profile.turns[1], secret, profile.language);
        printResponse("TURN 2 — follow-up", res2, profile.language);

        if (!res2.fala || res2.fala.length < 10) {
          flagIssue(profile.label, "Turn 2", "MAJOR", "GUTO respondeu com fala vazia ou muito curta",
            `fala="${res2.fala || ""}"`);
        }

        // Verificar se o chat conduz para próxima ação
        const condutores = ["missão", "treino", "dieta", "próximo", "hoje", "vamos", "meta", "hoje",
          "allenamento", "missione", "domani", "prossimo"];
        const conduzeParaFrente = condutores.some((c) => (res2.fala || "").toLowerCase().includes(c));
        if (!conduzeParaFrente && res2.acao !== "updateWorkout" && res2.acao !== "updateDiet") {
          flagIssue(profile.label, "Turn 2", "MINOR",
            "Chat responde mas não conduz para próxima ação",
            `acao=${res2.acao}, fala="${(res2.fala || "").slice(0, 100)}"`);
        }

        if (profile.language === "it-IT" && res2.fala) {
          const ptViolations = detectPortugueseInItalian(res2.fala);
          if (ptViolations.length > 0) {
            flagIssue(profile.label, "Turn 2 it-IT", "MAJOR",
              "Português detectado em resposta italiana (Turn 2)",
              `Palavras: ${ptViolations.join(", ")}`);
          }
        }
      } catch (e: any) {
        flagIssue(profile.label, "Turn 2", "MAJOR", "Erro HTTP no Turn 2", e.message);
      }
    }

    // Turn 3 — validação de treino / follow-up
    if (profile.turns[2]) {
      console.log(`\n  → Enviando Turn 3: "${profile.turns[2]}"`);
      try {
        const res3 = await chat(baseUrl, profile.id, profile.turns[2], secret, profile.language);
        printResponse("TURN 3 — validação/follow-up", res3, profile.language);

        if (res3.xpAward) {
          console.log(`  ✅ XP concedido: +${res3.xpAward}`);
        } else if (profile.turns[2].includes("feito") || profile.turns[2].includes("valei") ||
                   profile.turns[2].includes("andato") || profile.turns[2].includes("fatto")) {
          // Treino foi validado — deveria ter XP
          // Não é necessariamente um bug (pode precisar de confirmação)
          console.log(`  ℹ XP não concedido automaticamente (pode precisar de validação por câmera)`);
        }
      } catch (e: any) {
        flagIssue(profile.label, "Turn 3", "MINOR", "Erro HTTP no Turn 3", e.message);
      }
    }

    // Dieta
    console.log(`\n  → Testando dieta: "${profile.dietTurn}"`);
    try {
      const dietResp = await generateDiet(baseUrl, profile.id, secret, profile.language);
      printDiet(dietResp, profile.language);

      if (dietResp.status !== 200) {
        flagIssue(profile.label, "Dieta", "MAJOR",
          `Diet generate retornou ${dietResp.status}`,
          JSON.stringify(dietResp.data).slice(0, 200));
      } else {
        const plan = dietResp.data;
        const meals: any[] = plan?.meals || plan?.plan?.meals || [];

        // Verificar restrição vegetariana
        if (profile.checks.includes("vegetarian_diet")) {
          const { violation, found } = checkVegetarianDiet(plan);
          if (violation) {
            flagIssue(profile.label, "Dieta", "BLOCKER",
              "Dieta vegetariana contém carne/peixe",
              `Itens encontrados: ${found.join(", ")}`);
          } else {
            console.log(`  ✅ Restrição vegetariana respeitada na dieta`);
          }
        }

        // Verificar idioma na dieta (it-IT)
        if (profile.language === "it-IT") {
          const dietText = JSON.stringify(plan);
          const ptViolations = detectPortugueseInItalian(dietText);
          if (ptViolations.length > 0) {
            flagIssue(profile.label, "Dieta it-IT", "MINOR",
              "Possível texto em português na dieta italiana",
              `Encontrado: ${ptViolations.join(", ")}`);
          } else {
            console.log(`  ✅ Dieta it-IT: sem português detectado`);
          }
        }

        if (meals.length === 0) {
          flagIssue(profile.label, "Dieta", "MAJOR", "Dieta gerada sem refeições", "meals = []");
        } else {
          console.log(`  ✅ Dieta gerada com ${meals.length} refeições`);
        }
      }
    } catch (e: any) {
      flagIssue(profile.label, "Dieta", "MAJOR", "Erro na geração de dieta", e.message);
    }

    // Verificar memória final
    const finalMem = readMemory(profile.id);
    console.log(`\n  ── Estado da memória pós-sessão ───────────────────────`);
    console.log(`  totalXp    : ${finalMem.totalXp ?? "(não definido)"}`);
    console.log(`  streak     : ${finalMem.streak ?? "(não definido)"}`);
    console.log(`  lastWorkout: ${finalMem.lastWorkoutPlan ? "✅ presente" : "⚠ ausente"}`);

    if (!(finalMem as any).lastWorkoutPlan) {
      flagIssue(profile.label, "Memória", "MAJOR",
        "lastWorkoutPlan ausente da memória após sessão",
        "Usuário não veria treino salvo no app");
    }

    console.log(`\n  ── Flags registradas para este perfil ─────────────────`);
    const profileFlags = flags.filter((f) => f.profile === profile.label);
    if (profileFlags.length === 0) {
      console.log("  ✅ Nenhum problema detectado");
    } else {
      profileFlags.forEach((f) => {
        const icon = f.severity === "BLOCKER" ? "🔴" : f.severity === "MAJOR" ? "🟠" : "🟡";
        console.log(`  ${icon} [${f.severity}] ${f.issue}`);
      });
    }
  }

  // ─── Resumo Final ──────────────────────────────────────────────────────────

  server.close();

  console.log("\n\n╔══════════════════════════════════════════════════════════╗");
  console.log("║              RELATÓRIO DE EXPERIÊNCIA                   ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const blockers = flags.filter((f) => f.severity === "BLOCKER");
  const majors = flags.filter((f) => f.severity === "MAJOR");
  const minors = flags.filter((f) => f.severity === "MINOR");

  console.log(`  🔴 BLOCKERs : ${blockers.length}`);
  console.log(`  🟠 MAJORs   : ${majors.length}`);
  console.log(`  🟡 MINORs   : ${minors.length}`);
  console.log(`  Total       : ${flags.length} issues`);

  if (flags.length > 0) {
    console.log("\n  ── Todos os problemas encontrados ─────────────────────");
    for (const f of flags) {
      const icon = f.severity === "BLOCKER" ? "🔴" : f.severity === "MAJOR" ? "🟠" : "🟡";
      console.log(`\n  ${icon} [${f.severity}] ${f.profile}`);
      console.log(`     Momento: ${f.turn}`);
      console.log(`     Problema: ${f.issue}`);
      console.log(`     Evidência: ${f.evidence.slice(0, 150)}`);
    }
  }

  // Veredicto
  console.log("\n\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    VEREDICTO                            ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (blockers.length > 0) {
    console.log("  D — NÃO UTILIZÁVEL");
    console.log(`  Motivo: ${blockers.length} BLOCKER(s) impedem uso básico.`);
    blockers.forEach((b) => console.log(`  → ${b.issue} (${b.profile})`));
  } else if (majors.length > 3) {
    console.log("  C — TESTE INTERNO APENAS");
    console.log(`  Motivo: ${majors.length} issues MAJOR — produto funciona mas experiência é inconsistente.`);
  } else if (majors.length > 0 || minors.length > 3) {
    console.log("  C — TESTE INTERNO APENAS");
    console.log(`  Motivo: ${majors.length} MAJOR + ${minors.length} MINOR — precisa de polish antes de beta fechado.`);
  } else if (minors.length > 0) {
    console.log("  B — PRÉ-PILOTO CONTROLADO");
    console.log(`  Motivo: ${minors.length} MINOR — experiência boa, polish ainda necessário.`);
  } else {
    console.log("  A — BETA FECHADO");
    console.log("  Motivo: zero issues detectados na auditoria de experiência.");
  }

  console.log("\n");
  process.exit(blockers.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
