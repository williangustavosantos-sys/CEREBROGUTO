import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { getCatalogById, suggestExerciseSubstitutes, validateExerciseSubstitute } from "../exercise-catalog";

// Fase 3 — BUG 3: "Troca" em contexto de exercício nunca pode virar dica de
// execução. Tem que ser pedido de substituição OU pergunta objetiva de validação.
// O contexto chega embutido no input: "[WORKOUT EXERCISE CONTEXT ...] User message: <texto>".

const CTX = '[WORKOUT EXERCISE CONTEXT — language: pt-BR] Exercise: "Cadeira abdutora". Muscle group: gluteos.';
const wrap = (msg: string) => `${CTX} User message: ${msg}`;

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.exercise-swap-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearMemoryStoreCache: () => void = () => {};
let originalFetch: typeof globalThis.fetch;
let classifyExerciseDoubtMessage: (input: string) => string;

function writeUserMemory(userId: string, data: Record<string, any>) {
  const store = existsSync(testMemoryFile)
    ? (JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>)
    : {};
  store[userId] = { userId, name: "Will", language: "pt-BR", ...data };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
}

function readUserMemory(userId: string): Record<string, any> {
  const store = existsSync(testMemoryFile)
    ? (JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>)
    : {};
  return store[userId] || {};
}

async function postGuto(userId: string, input: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  const res = await originalFetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", profile: { userId, name: "Will" }, history: [], input }),
  });
  assert.equal(res.status, 200, `POST /guto deveria responder 200, veio ${res.status}`);
  return (await res.json()) as { fala?: string; acao?: string; expectedResponse?: { context?: string } | null };
}

// Frases típicas de DICA DE EXECUÇÃO que jamais podem aparecer numa resposta de troca.
const EXECUTION_CUE_RE = /foca no|aperta o|contrai|mantenha a postura|controle a descida|amplitude|glúteo médio|gluteo medio/i;

function writeSingleExerciseWorkout(userId: string, exerciseId = "cadeira_abdutora", extra: Record<string, any> = {}) {
  const ex = getCatalogById(exerciseId);
  assert.ok(ex, `exercício ${exerciseId} precisa existir no catálogo`);
  writeUserMemory(userId, {
    trainingGoal: "muscle_gain",
    trainingLevel: "consistent",
    preferredTrainingLocation: "gym",
    lastWorkoutPlan: {
      focus: "Treino",
      focusKey: "legs_core",
      dateLabel: "Hoje",
      scheduledFor: new Date().toISOString(),
      summary: "",
      location: "academia",
      exercises: [{
        id: ex.id,
        name: ex.canonicalNamePt,
        canonicalNamePt: ex.canonicalNamePt,
        muscleGroup: ex.muscleGroup,
        sets: 3,
        reps: "12",
        rest: "60s",
        cue: "",
        note: "",
        videoUrl: ex.videoUrl,
        videoProvider: "local",
        sourceFileName: ex.sourceFileName,
      }],
    },
    ...extra,
  });
}

function exerciseContextFor(exerciseId = "cadeira_abdutora") {
  const ex = getCatalogById(exerciseId);
  assert.ok(ex, `exercício ${exerciseId} precisa existir no catálogo`);
  return `[WORKOUT EXERCISE CONTEXT — language: pt-BR] Exercise: "${ex.canonicalNamePt}". Muscle group: ${ex.muscleGroup}.`;
}

function suggestedExerciseId(userId: string): string {
  const id = readUserMemory(userId).substitutionContext?.lastSuggestedId;
  assert.equal(typeof id, "string", "precisa persistir lastSuggestedId");
  return id;
}

function rejectedExerciseIds(userId: string): string[] {
  const ids = readUserMemory(userId).substitutionContext?.rejectedIds;
  assert.ok(Array.isArray(ids), "precisa persistir rejectedIds");
  return ids;
}

function assertSafeAbductorSubstitute(substituteId: string) {
  const original = getCatalogById("cadeira_abdutora");
  const substitute = getCatalogById(substituteId);
  assert.ok(original, "cadeira_abdutora precisa existir");
  assert.ok(substitute, `substituto ${substituteId} precisa existir`);
  assert.notEqual(substitute.id, "cadeira_abdutora");
  assert.notEqual(substitute.id, "cadeira_adutora", "abdutora nunca pode virar adutora");
  assert.notEqual(substitute.movementPattern, "aducao", "abdutora nunca pode virar padrão de adução puro");
  assert.equal(validateExerciseSubstitute(original, substitute).valid, true);
}

describe("Fase 3 — BUG 3: classificador determinístico de troca/dúvida", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(tmpDir, { recursive: true });
    originalFetch = globalThis.fetch.bind(globalThis);
    // Mock do modelo: se for chamado (só nos casos NÃO interceptados), responde algo neutro.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("generativelanguage.googleapis.com")) return originalFetch(input as any, init);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ fala: "Foca no glúteo médio e controle a descida.", acao: "none", expectedResponse: null }) }] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch;

    const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: typeof app;
      classifyExerciseDoubtMessage: (input: string) => string;
    };
    app = serverModule.app;
    classifyExerciseDoubtMessage = serverModule.classifyExerciseDoubtMessage;

    const memStore = (await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as {
      clearMemoryStoreCache: () => void;
    };
    clearMemoryStoreCache = memStore.clearMemoryStoreCache;

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind exercise-swap test server.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    clearMemoryStoreCache();
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(testMemoryFile, { force: true });
  });

  // ── Unit: classificador puro ───────────────────────────────────────────────
  it("contexto + 'troca' (e variações) → swap_needs_reason", () => {
    for (const msg of ["Troca", "trocar", "substituir", "muda esse", "não quero esse", "não consigo fazer esse"]) {
      assert.equal(classifyExerciseDoubtMessage(wrap(msg)), "swap_needs_reason", msg);
    }
  });

  it("contexto + dor → swap_pain (segurança tem prioridade)", () => {
    assert.equal(classifyExerciseDoubtMessage(wrap("tá doendo o joelho")), "swap_pain");
    assert.equal(classifyExerciseDoubtMessage(wrap("troca, sinto dor")), "swap_pain");
  });

  it("contexto + 'como faz' → execution_help (segue no modelo)", () => {
    assert.equal(classifyExerciseDoubtMessage(wrap("como faço esse?")), "execution_help");
    assert.equal(classifyExerciseDoubtMessage(wrap("qual a técnica?")), "execution_help");
  });

  it("contexto + pergunta neutra → none", () => {
    assert.equal(classifyExerciseDoubtMessage(wrap("quantas séries?")), "none");
  });

  it("SEM contexto + 'troca' curto → swap_no_context", () => {
    assert.equal(classifyExerciseDoubtMessage("troca"), "swap_no_context");
    assert.equal(classifyExerciseDoubtMessage("quero trocar"), "swap_no_context");
    assert.equal(classifyExerciseDoubtMessage("oi tudo bem"), "none");
  });

  it("SEM contexto: frases legítimas com 'muda/troca' + objeto NÃO viram troca de exercício", () => {
    // Regressão: não pode sequestrar mudança de idioma/peso/etc.
    assert.equal(classifyExerciseDoubtMessage("muda meu idioma pra ingles"), "none");
    assert.equal(classifyExerciseDoubtMessage("troca meu peso pra 80"), "none");
    assert.equal(classifyExerciseDoubtMessage("muda meu nome"), "none");
  });

  // ── Integração: o turno responde de forma determinística (pré-modelo) ───────
  it("HTTP contexto + 'Troca' → pergunta objetiva o motivo, sem dica de execução", async () => {
    const userId = "swap-troca";
    writeUserMemory(userId, { trainingGoal: "fat_loss", trainingLevel: "beginner" });
    clearMemoryStoreCache();

    const res = await postGuto(userId, wrap("Troca"));
    assert.equal(res.acao, "none");
    assert.equal(res.expectedResponse?.context, "exercise_swap");
    assert.match(res.fala || "", /dor/i);
    assert.match(res.fala || "", /equipamento|ocupad/i);
    assert.match(res.fala || "", /execu/i);
    assert.doesNotMatch(res.fala || "", EXECUTION_CUE_RE);
  });

  it("HTTP contexto + 'dor' → segurança (não dá cue de execução)", async () => {
    const userId = "swap-dor";
    writeUserMemory(userId, { trainingGoal: "fat_loss", trainingLevel: "beginner" });
    clearMemoryStoreCache();

    const res = await postGuto(userId, wrap("tá doendo quando faço"));
    assert.equal(res.acao, "none");
    assert.equal(res.expectedResponse?.context, "training_limitations");
    assert.match(res.fala || "", /dor|para|protege/i);
    assert.doesNotMatch(res.fala || "", EXECUTION_CUE_RE);
  });

  it("HTTP sem contexto + 'troca' → pede qual exercício", async () => {
    const userId = "swap-nocontext";
    writeUserMemory(userId, { trainingGoal: "fat_loss", trainingLevel: "beginner" });
    clearMemoryStoreCache();

    const res = await postGuto(userId, "troca");
    assert.equal(res.acao, "none");
    assert.match(res.fala || "", /trocar o que|qual exerc/i);
  });

  it("HTTP contexto + 'equipamento ocupado' → substitui o exercício resolvido do contexto", async () => {
    // Escolhe um exercício do catálogo que tenha substituto na academia.
    const candidateId = ["supino_reto", "agachamento_livre", "puxada_frente", "desenvolvimento_sentado"]
      .find((id) => getCatalogById(id) && suggestExerciseSubstitutes(id, { location: "gym" }).length > 0);
    assert.ok(candidateId, "precisa de um exercício do catálogo com substituto na academia");
    const ex = getCatalogById(candidateId!)!;

    const userId = "swap-equip-context";
    writeUserMemory(userId, {
      trainingGoal: "muscle_gain",
      trainingLevel: "consistent",
      preferredTrainingLocation: "gym",
      lastWorkoutPlan: {
        focus: "Treino", focusKey: "chest_triceps", dateLabel: "Hoje",
        scheduledFor: new Date().toISOString(), summary: "", location: "academia",
        exercises: [{
          id: ex.id, name: ex.canonicalNamePt, canonicalNamePt: ex.canonicalNamePt,
          muscleGroup: ex.muscleGroup, sets: 3, reps: "10", rest: "60s", cue: "", note: "",
          videoUrl: ex.videoUrl, videoProvider: "local", sourceFileName: ex.sourceFileName,
        }],
      },
    });
    clearMemoryStoreCache();

    // O front entra pelo "?" (gatilho "Tenho uma dúvida sobre X", que NÃO casa o
    // formato "Dúvida:") e depois manda "equipamento ocupado" com o marcador.
    const ctx = `[WORKOUT EXERCISE CONTEXT — language: pt-BR] Exercise: "${ex.canonicalNamePt}". Muscle group: ${ex.muscleGroup}.`;
    const res = await postGuto(userId, `${ctx} User message: equipamento ocupado`);

    assert.equal(res.acao, "none");
    // Tem que SUBSTITUIR (não cair na resposta genérica "me diz qual aparelho").
    assert.match(res.fala || "", /troca por|swap to|cambia con/i);
    assert.doesNotMatch(res.fala || "", /qual aparelho|qual m[áa]quina|which machine|quale attrezzo/i);
  });

  it("HTTP contexto de exercício + 'não tenho' → troca equipamento/exercício, sem cair no modelo", async () => {
    const candidateId = ["supino_reto", "agachamento_livre", "puxada_frente", "desenvolvimento_sentado"]
      .find((id) => getCatalogById(id) && suggestExerciseSubstitutes(id, { location: "gym" }).length > 0);
    assert.ok(candidateId, "precisa de um exercício do catálogo com substituto na academia");
    const ex = getCatalogById(candidateId!)!;

    const userId = "swap-nao-tenho-context";
    writeUserMemory(userId, {
      trainingGoal: "muscle_gain",
      trainingLevel: "consistent",
      preferredTrainingLocation: "gym",
      lastWorkoutPlan: {
        focus: "Treino", focusKey: "chest_triceps", dateLabel: "Hoje",
        scheduledFor: new Date().toISOString(), summary: "", location: "academia",
        exercises: [{
          id: ex.id, name: ex.canonicalNamePt, canonicalNamePt: ex.canonicalNamePt,
          muscleGroup: ex.muscleGroup, sets: 3, reps: "10", rest: "60s", cue: "", note: "",
          videoUrl: ex.videoUrl, videoProvider: "local", sourceFileName: ex.sourceFileName,
        }],
      },
    });
    clearMemoryStoreCache();

    const ctx = `[WORKOUT EXERCISE CONTEXT — language: pt-BR] Exercise: "${ex.canonicalNamePt}". Muscle group: ${ex.muscleGroup}.`;
    const res = await postGuto(userId, `${ctx} User message: não tenho`);

    assert.equal(res.acao, "none");
    assert.match(res.fala || "", /troca por|swap to|cambia con/i);
    assert.doesNotMatch(res.fala || "", EXECUTION_CUE_RE);
  });

  it("HTTP abdutora ocupada + recusas curtas avança A→B→C, não repete e depois coleta equipamentos", async () => {
    const userId = "swap-abdutora-recusa-curta";
    writeSingleExerciseWorkout(userId, "cadeira_abdutora");
    clearMemoryStoreCache();

    const ctx = exerciseContextFor("cadeira_abdutora");
    const first = await postGuto(userId, `${ctx} User message: Cadeira abdutora está ocupada`);
    assert.equal(first.acao, "none");
    assert.match(first.fala || "", /troca por/i);
    assert.doesNotMatch(first.fala || "", EXECUTION_CUE_RE);
    const firstId = suggestedExerciseId(userId);
    assertSafeAbductorSubstitute(firstId);

    // Simula refresh/reload: o próximo turno vem sem marcador visual, mas a memória
    // precisa manter a cadeia de substituição viva.
    clearMemoryStoreCache();
    const second = await postGuto(userId, "tbm esta ocupado");
    assert.equal(second.acao, "none");
    assert.match(second.fala || "", /troca por/i);
    assert.doesNotMatch(second.fala || "", EXECUTION_CUE_RE);
    const secondId = suggestedExerciseId(userId);
    assertSafeAbductorSubstitute(secondId);
    assert.notEqual(secondId, firstId, "não pode repetir substituto recusado");
    assert.deepEqual(rejectedExerciseIds(userId), [firstId]);

    clearMemoryStoreCache();
    const third = await postGuto(userId, "esse também");
    assert.equal(third.acao, "none");
    assert.match(third.fala || "", /troca por/i);
    assert.doesNotMatch(third.fala || "", EXECUTION_CUE_RE);
    const thirdId = suggestedExerciseId(userId);
    assertSafeAbductorSubstitute(thirdId);
    assert.equal(new Set([firstId, secondId, thirdId]).size, 3, "A, B e C precisam ser distintos");
    assert.deepEqual(rejectedExerciseIds(userId), [firstId, secondId]);

    clearMemoryStoreCache();
    const fourth = await postGuto(userId, "nao tem");
    assert.equal(fourth.acao, "none");
    assert.match(fourth.fala || "", /o que est[aá] livre|polia|halteres|banco|colchonete/i);
    assert.doesNotMatch(fourth.fala || "", /troca por/i);
    assert.deepEqual(rejectedExerciseIds(userId), [firstId, secondId, thirdId]);
  });

  it("HTTP activeExercise mantém fallback sem marcador do frontend", async () => {
    const userId = "swap-active-exercise-fallback";
    writeSingleExerciseWorkout(userId, "cadeira_abdutora", {
      activeExercise: {
        source: "chat",
        name: "Cadeira abdutora",
        muscleGroup: "pernas",
        reps: "12",
        rest: "60s",
        totalSets: 3,
        updatedAt: new Date().toISOString(),
      },
    });
    clearMemoryStoreCache();

    const res = await postGuto(userId, "esta ocupado");
    assert.equal(res.acao, "none");
    assert.match(res.fala || "", /troca por/i);
    assert.doesNotMatch(res.fala || "", /qual aparelho|qual m[áa]quina/i);
    assert.doesNotMatch(res.fala || "", EXECUTION_CUE_RE);
    assertSafeAbductorSubstitute(suggestedExerciseId(userId));
  });

  it("HTTP contexto de alimento + 'não tenho' → falta/substituição alimentar, nunca patologia", async () => {
    const userId = "food-nao-tenho-context";
    writeUserMemory(userId, {
      trainingGoal: "fat_loss",
      trainingLevel: "beginner",
      trainingPathology: "ombro direito",
      foodRestrictions: "sem lactose",
    });
    clearMemoryStoreCache();

    const input = [
      "[DIET CONTEXT — language: pt-BR — nutrition only]",
      'Food in question: "Azeite de oliva" (1 colher, 90 kcal).',
      'Meal: "Almoço" (13:00).',
      "Limitations/pathology: ombro direito.",
      "User question: não tenho",
    ].join(" ");
    const res = await postGuto(userId, input);

    assert.equal(res.acao, "none");
    assert.match(res.fala || "", /troca|substitu/i);
    assert.doesNotMatch(res.fala || "", /posso substituir|posso trocar/i);
    assert.doesNotMatch(res.fala || "", /ombro entendido|joelho entendido/i);
    assert.doesNotMatch(res.fala || "", EXECUTION_CUE_RE);
  });

  it("HTTP sem contexto + 'não tenho' → pede esclarecimento curto", async () => {
    const userId = "nao-tenho-sem-contexto";
    writeUserMemory(userId, { trainingGoal: "fat_loss", trainingLevel: "beginner" });
    clearMemoryStoreCache();

    const res = await postGuto(userId, "não tenho");

    assert.equal(res.acao, "none");
    assert.match(res.fala || "", /alimento|aparelho/i);
    assert.doesNotMatch(res.fala || "", /ombro entendido|joelho entendido/i);
    assert.doesNotMatch(res.fala || "", EXECUTION_CUE_RE);
  });
});
