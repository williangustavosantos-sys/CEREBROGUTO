// Fatia 2A — testes ARQUITETURAIS (determinísticos, stub do modelo).
// Provam: diretriz 2A só no cérebro; risco → cérebro POSSUI (compõe SAFETY_OVERRIDE,
// não defere); flag OFF não recebe a diretriz; sem vazamento; sem resposta dupla.
// O comportamento (sem chantagem, presença-primeiro) é validado VIVO com Gemini real.
import "./test-env.js";
process.env.GEMINI_API_KEY = "test-key-2a";
process.env.ENABLE_PROACTIVE_JOB = "false";
process.env.ENABLE_DAILY_BRIEFING = "false";

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const dir = join(process.cwd(), "tmp");
const file = join(dir, "guto-memory.brain-2a-test.json");
const MARKER = "FALA_2A";
const DIRECTIVE_MARKER = "DIRETRIZ SOBERANA — IDENTIDADE NO RACIOCÍNIO";
const SAFETY_MARKER = "REGRAS PARA ESTE TURNO";

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

const BASE = {
  name: "Will", language: "pt-BR", biologicalSex: "male", userAge: 33, heightCm: 178, weightKg: 80,
  trainingLevel: "consistent", trainingStatus: "consistent", trainingGoal: "muscle_gain",
  preferredTrainingLocation: "home", trainingLocation: "home", trainingPathology: "sem dor",
  initialXpGranted: true, totalXp: 100, streak: 5,
};
function seed(userId: string, over: Record<string, unknown> = {}) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  store[userId] = { userId, ...BASE, ...over };
  writeFileSync(file, JSON.stringify(store, null, 2));
  clearCache();
}
async function chat(userId: string, input: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  callsByKind = {}; lastBrainBody = ""; const errBefore = consoleErrors.length;
  const r = await fetch(`${baseUrl}/guto`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: "pt-BR", history: [], input }),
  });
  const body = (await r.json()) as Record<string, unknown>;
  const headerErr = consoleErrors.slice(errBefore).some((e) => /ERR_HTTP_HEADERS_SENT|Cannot set headers/i.test(e));
  return { status: r.status, body, headerErr };
}
const META_KEYS = ["validation", "meta", "kind", "via", "reasoning", "modelCalled", "persisted"];

describe("Fatia 2A — cérebro possui conversa/emoção/identidade (arquitetura)", () => {
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

  it("flag ON: diretriz 2A é injetada SÓ no prompt do cérebro", async () => {
    setBrainSlice1(true);
    seed("dir-on");
    const { status, body } = await chat("dir-on", "valeu guto, parceria firme");
    assert.equal(status, 200);
    assert.equal(body.fala, MARKER);
    assert.ok(lastBrainBody.includes(DIRECTIVE_MARKER), "o prompt do cérebro DEVE conter a diretriz 2A");
    assert.equal(callsByKind.contractIntent || 0, 0, "cérebro possui: legado (contractIntent) não roda");
  });

  it("flag OFF: legado NÃO recebe a diretriz 2A (buildGutoBrainPrompt intocado)", async () => {
    setBrainSlice1(false);
    seed("dir-off");
    const { status } = await chat("dir-off", "valeu guto, parceria firme");
    assert.equal(status, 200);
    assert.ok(lastBrainBody.length > 0, "o legado também monta um brain prompt");
    assert.ok(!lastBrainBody.includes(DIRECTIVE_MARKER), "a diretriz 2A NÃO pode aparecer no prompt legado");
  });

  it("flag ON + risco ativo: cérebro POSSUI e compõe SAFETY_OVERRIDE (não defere, sem resposta dupla)", async () => {
    setBrainSlice1(true);
    stubPayload = { flag: "suicide_self_harm", confidence: 0.95, fala: MARKER, acao: "none", expectedResponse: null };
    seed("risk-on");
    const { status, body, headerErr } = await chat("risk-on", "não aguento mais nada, queria sumir");
    assert.equal(status, 200);
    assert.equal(body.fala, MARKER, "o cérebro entrega a resposta (não defere ao legado)");
    assert.equal(callsByKind.contractIntent || 0, 0, "risco é POSSUÍDO pelo cérebro — legado não roda");
    assert.ok(lastBrainBody.includes(SAFETY_MARKER), "o riskOverride injeta o SAFETY_OVERRIDE no prompt do cérebro");
    assert.equal(headerErr, false, "sem resposta dupla (header já enviado)");
    for (const k of META_KEYS) assert.ok(!(k in body), `meta não pode vazar: ${k}`);
  });

  it("flag OFF + risco ativo: legado assume (paridade — SAFETY_OVERRIDE pelo askGutoModel)", async () => {
    setBrainSlice1(false);
    stubPayload = { flag: "suicide_self_harm", confidence: 0.95, fala: MARKER, acao: "none", expectedResponse: null };
    seed("risk-off");
    const { status } = await chat("risk-off", "não aguento mais nada, queria sumir");
    assert.equal(status, 200);
    // Legado clássico: askGutoModel roda classifyContractIntent.
    assert.ok((callsByKind.contractIntent || 0) >= 1, "flag OFF mantém o legado (contractIntent roda)");
  });

  it("flag ON + turno que EXIGE treino → defere ao legado (acao != none)", async () => {
    setBrainSlice1(true);
    stubPayload = { flag: null, confidence: 0, fala: "bora montar", acao: "updateWorkout", expectedResponse: null };
    seed("train-on");
    const { status } = await chat("train-on", "guto, monta meu treino de hoje");
    assert.equal(status, 200);
    assert.ok((callsByKind.contractIntent || 0) >= 1, "treino real defere ao legado");
  });
});
