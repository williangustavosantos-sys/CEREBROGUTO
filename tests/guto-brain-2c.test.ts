// Fatia 2C — testes ARQUITETURAIS (determinísticos, stub do modelo).
// O cérebro possui ADAPTAÇÃO/DOR/CONTINUIDADE. O L3 (enforceDecisiveSwap/
// repairInvalidExerciseSubstitutionResponse) NÃO pode reescrever a fala do cérebro.
// A validação de catálogo é TRILHO: substituição inválida → DEFER honesto (sem
// template substituindo a voz do cérebro).
import "./test-env.js";
process.env.GEMINI_API_KEY = "test-key-2c";
process.env.GUTO_CURATOR_MAX_ATTEMPTS = "1";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { getCatalogById, suggestExerciseSubstitutes, validateExerciseSubstitute } from "../exercise-catalog";

const dir = join(process.cwd(), "tmp");
const file = join(dir, "guto-memory.brain-2c-test.json");
const MARKER = "FALA_2C_DO_CEREBRO";
const C_MARKER = "ADAPTAÇÃO, DOR E CONTINUIDADE";   // diretriz 2C (brain-only)
const KNOWN_MARKER = "Limitação JÁ conhecida";       // diretriz 2C: limitação na memória
const CTX_ABDUTORA = '[WORKOUT EXERCISE CONTEXT — language: pt-BR] Exercise: "Cadeira abdutora". Muscle group: gluteos.';

const consoleErrors: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { consoleErrors.push(a.map(String).join(" ")); };

const originalFetch = globalThis.fetch;
let callsByKind: Record<string, number> = {};
let lastBrainBody = "";
let stubPayload: Record<string, unknown> = { flag: null, confidence: 0, fala: MARKER, acao: "none", expectedResponse: null };

function installFetchStub() {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes("generativelanguage")) {
      const body = String(init?.body ?? "");
      let kind = "other";
      if (body.includes("strict semantic safety classifier")) kind = "risk";
      else if (body.includes("semantic contract classifier")) kind = "contractIntent";
      else if (body.includes("VOCÊ É GUTO")) { kind = "brain"; lastBrainBody = body; }
      else kind = "curator";
      callsByKind[kind] = (callsByKind[kind] || 0) + 1;
      return {
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(stubPayload) }] } }] }),
      } as unknown as Response;
    }
    return originalFetch(url as RequestInfo, init as RequestInit);
  }) as typeof fetch;
}

let app: { listen: (p: number, h: string, cb?: () => void) => Server };
let server: Server;
let baseUrl = "";
let clearCache: () => void = () => {};
let setBrainSlice1: (on: boolean) => void;

// Perfil COMPLETO (trainingStatus + userAge + trainingLimitations) → missingFields=[].
const COMPLETE = {
  name: "Will", language: "pt-BR", biologicalSex: "male", userAge: 33, heightCm: 178, weightKg: 80,
  trainingLevel: "consistent", trainingStatus: "consistent", trainingGoal: "muscle_gain",
  preferredTrainingLocation: "gym", trainingLocation: "gym", trainingPathology: "sem dor",
  trainingLimitations: "sem dor", initialXpGranted: true, totalXp: 100, streak: 5,
};

// lastWorkoutPlan de 1 exercício do catálogo — resolve o "original" para substituição.
function abdutoraPlan() {
  const ex = getCatalogById("cadeira_abdutora")!;
  return {
    focus: "Treino", focusKey: "legs_core", dateLabel: "Hoje",
    scheduledFor: new Date().toISOString(), summary: "", location: "academia",
    exercises: [{
      id: ex.id, name: ex.canonicalNamePt, canonicalNamePt: ex.canonicalNamePt,
      muscleGroup: ex.muscleGroup, sets: 3, reps: "12", rest: "60s", cue: "", note: "",
      videoUrl: ex.videoUrl, videoProvider: "local", sourceFileName: ex.sourceFileName,
    }],
  };
}

function seed(userId: string, over: Record<string, unknown> = {}) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  store[userId] = { userId, ...COMPLETE, ...over };
  writeFileSync(file, JSON.stringify(store, null, 2));
  clearCache();
}
function readMem(userId: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"))[userId] || {};
}
async function chat(userId: string, input: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  callsByKind = {}; lastBrainBody = ""; const e0 = consoleErrors.length;
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", history: [], input }),
  });
  const body = (await r.json()) as Record<string, any>;
  const headerErr = consoleErrors.slice(e0).some((x) => /ERR_HTTP_HEADERS_SENT|Cannot set headers/i.test(x));
  return { status: r.status, body, headerErr };
}
const META_KEYS = ["validation", "meta", "kind", "via", "reasoning", "modelCalled", "persisted"];

// Substituto VÁLIDO (mesmo grupo) e INVÁLIDO (outro grupo) para a Cadeira abdutora.
function validSubstituteName(): string {
  const orig = getCatalogById("cadeira_abdutora")!;
  const subs = suggestExerciseSubstitutes("cadeira_abdutora", { location: "gym", userRiskTags: [], userBodyRegion: undefined });
  const valid = subs.map((id) => getCatalogById(id)).find((e) => e && validateExerciseSubstitute(orig, e).valid);
  assert.ok(valid, "precisa existir um substituto válido para a Cadeira abdutora");
  return valid!.canonicalNamePt;
}
function invalidSubstituteName(): string {
  const orig = getCatalogById("cadeira_abdutora")!;
  const chest = getCatalogById("supino_reto")!;
  assert.equal(validateExerciseSubstitute(orig, chest).valid, false, "Supino reto deve ser substituto INVÁLIDO de glúteo");
  return chest.canonicalNamePt; // "Supino reto"
}

describe("Fatia 2C — cérebro possui adaptação/dor/continuidade (L3 não decide fala)", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = file;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({}, null, 2));
    installFetchStub();
    const mod = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as { app: typeof app };
    app = mod.app;
    clearCache = ((await import(pathToFileURL(join(process.cwd(), "src/memory-store.ts")).href)) as { clearMemoryStoreCache: () => void }).clearMemoryStoreCache;
    const cfg = ((await import(pathToFileURL(join(process.cwd(), "src/config.ts")).href)) as { config: { brainSlice1: boolean } }).config;
    setBrainSlice1 = (on) => { cfg.brainSlice1 = on; };
    await new Promise<void>((resolve, reject) => { server = app.listen(0, "127.0.0.1", () => resolve()); server.once("error", reject); });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(() => {
    stubPayload = { flag: null, confidence: 0, fala: MARKER, acao: "none", expectedResponse: null };
    setBrainSlice1(false);
  });
  after(async () => {
    globalThis.fetch = originalFetch; console.error = origErr;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(file, { force: true });
  });

  // 1. Flag OFF continua legado.
  it("flag OFF: adaptação/dor continua no legado (askGutoModel/contractIntent)", async () => {
    setBrainSlice1(false);
    seed("2c-off");
    const { status, body } = await chat("2c-off", "quero trocar esse exercício");
    assert.equal(status, 200);
    assert.ok((callsByKind.contractIntent || 0) >= 1, "flag OFF mantém o legado");
    assert.ok(!lastBrainBody.includes(C_MARKER), "legado não recebe a diretriz 2C");
  });

  // 2. Dor simples → cérebro possui o turno.
  it("dor simples → cérebro possui (acao:none, sem legado, fala preservada)", async () => {
    setBrainSlice1(true);
    seed("2c-dor");
    const { status, body, headerErr } = await chat("2c-dor", "meu joelho está doendo");
    assert.equal(status, 200);
    assert.equal(body.acao, "none");
    assert.equal(body.fala, MARKER, "a fala do cérebro é preservada");
    assert.equal(callsByKind.contractIntent || 0, 0, "cérebro possui: askGutoModel NÃO roda");
    assert.ok(lastBrainBody.includes(C_MARKER), "diretriz 2C anexada ao prompt do cérebro");
    assert.equal(headerErr, false, "sem resposta dupla");
    for (const k of META_KEYS) assert.ok(!(k in body), `meta não pode vazar: ${k}`);
  });

  // 3. Limitação conhecida → cérebro não repergunta.
  it("limitação conhecida (joelho) → diretriz informa a limitação (não reperguntar)", async () => {
    setBrainSlice1(true);
    seed("2c-known", { trainingLimitations: "dor no joelho", trainingPathology: "dor no joelho" });
    await chat("2c-known", "e aí, tudo certo?");
    assert.ok(lastBrainBody.includes(KNOWN_MARKER), "diretriz 2C marca a limitação como já conhecida");
    assert.ok(lastBrainBody.includes("dor no joelho"), "a limitação real aparece no prompt do cérebro");
  });

  // 4. Adaptação simples → executor/validador roda sem substituir fala.
  it("substituição VÁLIDA → validador aprova e a fala do cérebro é preservada", async () => {
    setBrainSlice1(true);
    const fala = `Troca por ${validSubstituteName()}, pega o mesmo músculo com menos incômodo. Bora.`;
    stubPayload = { flag: null, confidence: 0, fala, acao: "none", expectedResponse: null };
    seed("2c-valid", { lastWorkoutPlan: abdutoraPlan() });
    const { body, headerErr } = await chat("2c-valid", `${CTX_ABDUTORA} User message: quero trocar esse`);
    assert.equal(body.acao, "none");
    assert.equal(body.fala, fala, "substituição válida: a fala do cérebro NÃO é reescrita por template");
    assert.equal(callsByKind.contractIntent || 0, 0, "cérebro possui: sem legado");
    assert.equal(headerErr, false, "sem resposta dupla");
  });

  // 5. L3 não altera a fala do cérebro (menu de preferência que o legado reescreveria).
  it("L3 não reescreve a fala do cérebro (menu 'X ou Y, qual prefere?')", async () => {
    setBrainSlice1(true);
    const fala = "Stiff ou Mesa flexora, qual prefere? Bora.";
    stubPayload = { flag: null, confidence: 0, fala, acao: "none", expectedResponse: null };
    seed("2c-l3", { lastWorkoutPlan: abdutoraPlan() });
    const { body } = await chat("2c-l3", `${CTX_ABDUTORA} User message: esse exercício incomoda`);
    assert.equal(body.fala, fala, "enforceDecisiveSwap NÃO pode reescrever a fala do cérebro");
    assert.equal(body.acao, "none");
  });

  // 6. Substituição inválida → validação protege catálogo sem template legado.
  it("substituição INVÁLIDA → cérebro defere (validação protege catálogo, sem trocar a voz por template)", async () => {
    setBrainSlice1(true);
    const invalidFala = `Troca por ${invalidSubstituteName()}, vai ser melhor. Bora.`; // chest p/ glúteo
    stubPayload = { flag: null, confidence: 0, fala: invalidFala, acao: "none", expectedResponse: null };
    seed("2c-invalid", { lastWorkoutPlan: abdutoraPlan() });
    const { status, body, headerErr } = await chat("2c-invalid", `${CTX_ABDUTORA} User message: quero trocar`);
    assert.equal(status, 200);
    assert.notEqual(body.fala, invalidFala, "a substituição inválida do cérebro NÃO pode vazar ao usuário");
    // defer honesto: cai no decisor legado de troca/dor (pergunta o motivo) — não um
    // template silencioso reescrevendo a voz do cérebro.
    assert.ok(/trocar por qu|pra trocar|qual o motivo/i.test(String(body.fala)), "defer honesto → clareza do legado");
    assert.equal(headerErr, false, "sem resposta dupla");
  });

  // 7. Continuidade após dificuldade → cérebro conduz sem chantagem/streak.
  it("dificuldade ('hoje tá difícil') → cérebro conduz (acao:none) sem escada/streak legada", async () => {
    setBrainSlice1(true);
    seed("2c-dificil");
    const { body, headerErr } = await chat("2c-dificil", "hoje tá difícil");
    assert.equal(body.acao, "none");
    assert.equal(body.fala, MARKER, "o cérebro conduz na própria voz");
    assert.equal(callsByKind.contractIntent || 0, 0, "sem escada determinística legada");
    assert.ok(lastBrainBody.includes(C_MARKER), "diretriz de continuidade anexada");
    assert.equal(headerErr, false, "sem resposta dupla");
  });

  // 8. Persistência não duplica.
  it("persistência honesta e ÚNICA (memoryPatch aplicado 1x, sem dupla resposta)", async () => {
    setBrainSlice1(true);
    // energyLast é um campo whitelisted do applyMemoryPatch (persistência real, única).
    stubPayload = { flag: null, confidence: 0, fala: MARKER, acao: "none", expectedResponse: null, memoryPatch: { energyLast: "cansado" } };
    seed("2c-persist");
    const { body, headerErr } = await chat("2c-persist", "meu joelho tá ruim hoje");
    assert.equal(body.acao, "none");
    assert.equal(headerErr, false, "sem resposta dupla");
    const mem = readMem("2c-persist") as any;
    assert.equal(mem.energyLast, "cansado", "memoryPatch persistido (1x, honesto)");
  });

  // 9. Sem vazamento de meta/validation (já coberto no #2, reforço explícito).
  it("sem vazamento de meta/validation no payload público", async () => {
    setBrainSlice1(true);
    seed("2c-leak");
    const { body } = await chat("2c-leak", "esse exercício dói");
    for (const k of META_KEYS) assert.ok(!(k in body), `meta não pode vazar: ${k}`);
  });

  // 10. Sem resposta dupla no caminho de DEFER (fallback do decisor legado).
  it("defer com fallback legado → uma única resposta (sem ERR_HTTP_HEADERS_SENT)", async () => {
    setBrainSlice1(true);
    stubPayload = { flag: null, confidence: 0, fala: "vou montar tua dieta", acao: "generateDiet", expectedResponse: null };
    seed("2c-once");
    const { status, headerErr } = await chat("2c-once", `${CTX_ABDUTORA} User message: troca`);
    assert.equal(status, 200);
    assert.equal(headerErr, false, "defer + fallback não pode emitir resposta dupla");
  });

  // 11. Caso complexo fora de escopo → defer para legado.
  it("ação complexa fora de escopo (acao não suportada) → defer ao legado", async () => {
    setBrainSlice1(true);
    // acao "lock" passa pelo parse mas NÃO é suportada pelo cérebro (SUPPORTED={none,updateWorkout})
    // → validateContract DEFERE → o legado (askGutoModel) assume e roda SUA chamada de modelo.
    stubPayload = { flag: null, confidence: 0, fala: "trocando tudo", acao: "lock", expectedResponse: null };
    seed("2c-complex");
    const { status, body } = await chat("2c-complex", "tô precisando reorganizar várias coisas no meu plano de uma vez");
    assert.equal(status, 200);
    // acao não suportada → validateContract DEFERE → o legado (askGutoModel) assume e roda
    // o contractIntent classifier. Defer honesto: o cérebro não executa fora de escopo.
    assert.ok((callsByKind.contractIntent || 0) >= 1, "acao fora do escopo do cérebro → defer ao legado");
    assert.ok(!(body.acao === "updateWorkout" && body.workoutPlan), "o cérebro não executa fora de escopo");
  });
});
