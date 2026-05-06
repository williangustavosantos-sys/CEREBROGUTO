import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

type GutoLanguage = "pt-BR" | "en-US" | "it-IT" | "es-ES";

type GutoResponse = {
  fala?: string;
  expectedResponse?: {
    instruction?: string;
    context?: string;
  } | null;
  memoryPatch?: Record<string, any>;
};

const testMemoryDir = join(process.cwd(), "tmp");
const testMemoryFile = join(testMemoryDir, "guto-memory.history-context-test.json");
const originalFetch = globalThis.fetch.bind(globalThis);

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";

const forbiddenPortuguese: Record<Exclude<GutoLanguage, "pt-BR">, string[]> = {
  "en-US": ["amanhã", "hoje", "peito", "costas", "pernas", "treino", "academia", "dor", "limitação", "me manda", "boa", "ontem", "anteontem"],
  "it-IT": ["amanhã", "hoje", "peito", "costas", "pernas", "treino", "academia", "limitação", "me manda", "boa", "ontem", "anteontem"],
  "es-ES": ["amanhã", "hoje", "peito", "costas", "treino", "academia", "limitação", "me manda", "boa", "ontem", "anteontem"],
};

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function assertNoPortugueseLeak(response: GutoResponse, language: Exclude<GutoLanguage, "pt-BR">) {
  const visible = `${response.fala || ""}\n${response.expectedResponse?.instruction || ""}`;
  const text = ` ${normalize(visible).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  for (const term of forbiddenPortuguese[language]) {
    const normalizedTerm = normalize(term).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    assert.equal(text.includes(` ${normalizedTerm} `), false, `Portuguese leak "${term}" in ${language}: ${visible}`);
  }
}

function resetTestMemory() {
  mkdirSync(testMemoryDir, { recursive: true });
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
}

function readMemoryStore() {
  if (!existsSync(testMemoryFile)) return {} as Record<string, any>;
  return JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>;
}

function readUserMemory(userId: string) {
  return readMemoryStore()[userId];
}

function writeUserMemory(userId: string, data: Record<string, any>) {
  const store = readMemoryStore();
  store[userId] = { ...store[userId], ...data };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
}

function seedVisibleWorkoutFocus(userId: string, focus = "legs_core") {
  writeUserMemory(userId, {
    lastSuggestedFocus: focus,
    lastWorkoutPlan: { focusKey: focus },
  });
}

function buildGeminiResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function extractPrompt(init?: RequestInit) {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  return String(body?.contents?.[0]?.parts?.[0]?.text || "");
}

function extractFirstJsonObjectAfterMarker(text: string, markers: string[]) {
  const startSearch = markers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const from = startSearch ?? 0;
  const openIndex = text.indexOf("{", from);
  if (openIndex < 0) return {};

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      const candidate = text.slice(openIndex, i + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return {};
      }
    }
  }

  return {};
}

function installGeminiMock() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return originalFetch(input as any, init);

    const prompt = extractPrompt(init);

    const memory = extractFirstJsonObjectAfterMarker(prompt, ["Memória do usuário", "Memoria do usuario", "User memory", "MEMÓRIA"]);

    const inputMatch = prompt.match(/Mensagem atual do usuário: (.*)/);
    const inputMsg = inputMatch ? inputMatch[1].trim().toLowerCase() : "";

    if (inputMsg.includes("treinei isso ontem") || inputMsg.includes("treinei isso anteontem") || inputMsg.includes("ayer") || inputMsg.includes("ieri") || inputMsg.includes("yesterday")) {
      if (memory.lastSuggestedFocus || memory.lastWorkoutFocus) {
        const isPt = inputMsg.includes("treinei");
        const isEn = inputMsg.includes("trained");
        const isIt = inputMsg.includes("allenato");
        const isEs = inputMsg.includes("entren");
        const fala = isPt
          ? "Boa. Não repito pernas e core."
          : isEn
            ? "Good. Not repeating legs and core."
            : isIt
              ? "Bene. Non ripeto gambe e core."
              : isEs
                ? "Bien. No repito piernas y core."
                : "Good. Not repeating that focus.";
        return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({
          fala,
          acao: "none",
          expectedResponse: null,
          trainedReference: {
            dateLabel: inputMsg.includes("anteontem") || inputMsg.includes("before") || inputMsg.includes("antes") || inputMsg.includes("avantieri") ? "day_before_yesterday" : "yesterday",
          }
        }))), { status: 200, headers: { "Content-Type": "application/json" } });
      } else {
        return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({
          fala: "Treinou o que ontem?",
          acao: "none",
          expectedResponse: null
        }))), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }

    if (inputMsg.includes("os últimos dois dias") || inputMsg.includes("last two days") || inputMsg.includes("ultimi due giorni") || inputMsg.includes("últimos dos días")) {
      const isPt = inputMsg.includes("dois dias");
      const isEn = inputMsg.includes("two days");
      const isIt = inputMsg.includes("due giorni");
      const isEs = inputMsg.includes("dos días");

      let fala = "";
      if (isPt) fala = "não repito pernas/core nem peito/tríceps. Vamos focar em costas e bíceps.";
      if (isEn) fala = "not repeating legs/core or chest/triceps. Let's do back and biceps.";
      if (isIt) fala = "non ripeto gambe/core né petto/tricipiti. Facciamo schiena e bicipiti.";
      if (isEs) fala = "no repito piernas/core ni pecho/tríceps. Vamos con espalda y bíceps.";

      return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({
        fala,
        acao: "none",
        expectedResponse: null,
        memoryPatch: {
          recentTrainingHistory: [
            { dateLabel: "recent", muscleGroup: "legs_core", raw: inputMsg },
            { dateLabel: "recent", muscleGroup: "chest_triceps", raw: inputMsg }
          ]
        }
      }))), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(
      JSON.stringify(
        buildGeminiResponse(
          JSON.stringify({
            fala: "Perdi conexão por um momento. Reorganiza e me envia de novo em 1 frase.",
            acao: "none",
            expectedResponse: null,
          })
        )
      ),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof globalThis.fetch;
}

async function postGuto(body: Record<string, unknown>) {
  const token = jwt.sign(
    { userId: (body.profile as any)?.userId || "test-user", role: "student" },
    process.env.JWT_SECRET || "dev-secret-change-in-production"
  );
  const response = await originalFetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  return (await response.json()) as GutoResponse;
}

before(async () => {
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GUTO_ALLOW_DEV_ACCESS = "true";

  resetTestMemory();
  installGeminiMock();

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
  };
  app = serverModule.app;

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(testMemoryFile, { force: true });
});

beforeEach(() => {
  resetTestMemory();
});

describe("GUTO contextual muscle history", () => {
  it("resolves 'treinei isso ontem' to the last suggested legs_core focus", async () => {
    const userId = "history-context-pt-yesterday";
    seedVisibleWorkoutFocus(userId);
    const response = await postGuto({
      language: "pt-BR",
      profile: { userId, name: "Will" },
      history: [{ role: "model", parts: [{ text: "Hoje vou puxar pernas e core na academia." }] }],
      input: "treinei isso ontem",
    });

    const memory = { ...readUserMemory(userId), ...response.memoryPatch };
    assert.equal(memory.recentTrainingHistory?.[0]?.muscleGroup, "legs_core");
    assert.equal(memory.recentTrainingHistory?.[0]?.dateLabel, "yesterday");
    assert.notEqual(memory.nextWorkoutFocus, "legs_core");
    assert.doesNotMatch(response.fala || "", /vou puxar pernas e core/i);
    assert.doesNotMatch(response.fala || "", /Perdi conexão/i);
  });

  it("resolves 'treinei isso anteontem' without saving it as limitation", async () => {
    const userId = "history-context-pt-day-before";
    seedVisibleWorkoutFocus(userId);
    const response = await postGuto({
      language: "pt-BR",
      profile: { userId, name: "Will" },
      history: [{ role: "model", parts: [{ text: "Hoje a base é pernas e core." }] }],
      input: "treinei isso anteontem",
    });

    const memory = { ...readUserMemory(userId), ...response.memoryPatch };
    assert.equal(memory.recentTrainingHistory?.[0]?.muscleGroup, "legs_core");
    assert.equal(memory.recentTrainingHistory?.[0]?.dateLabel, "day_before_yesterday");
    assert.equal(memory.trainingLimitations, undefined);
    assert.equal(memory.trainingStatus, undefined);
  });

  it("extracts compound recent history and switches next focus to back_biceps", async () => {
    const userId = "history-context-pt-compound";
    const response = await postGuto({
      language: "pt-BR",
      profile: { userId, name: "Will", trainingLocation: "academia" },
      history: [],
      input: "treinei pernas e core e peito e tríceps os últimos dois dias",
    });

    const memory = { ...readUserMemory(userId), ...response.memoryPatch };
    const groups = new Set(memory.recentTrainingHistory?.map((item: any) => `${item.muscleGroup}:${item.dateLabel}`));
    assert.equal(groups.has("legs_core:recent"), true);
    assert.equal(groups.has("chest_triceps:recent"), true);
    assert.equal(memory.nextWorkoutFocus, "back_biceps");
    assert.match(response.fala || "", /não repito pernas\/core nem peito\/tríceps/i);
    assert.match(response.fala || "", /costas e bíceps/i);
    assert.doesNotMatch(response.fala || "", /Perdi conexão/i);
  });

  const localizedCases: Array<{
    language: Exclude<GutoLanguage, "pt-BR">;
    historyText: string;
    yesterday: string;
    dayBefore: string;
    compound: string;
    expectedCompound: RegExp;
  }> = [
      {
        language: "en-US",
        historyText: "Today we go legs and core.",
        yesterday: "I trained that yesterday",
        dayBefore: "I trained that the day before yesterday",
        compound: "I trained legs and core and chest and triceps over the last two days",
        expectedCompound: /not repeating legs\/core or chest\/triceps/i,
      },
      {
        language: "it-IT",
        historyText: "Oggi andiamo su gambe e core.",
        yesterday: "l'ho allenato ieri",
        dayBefore: "l'ho allenato avantieri",
        compound: "ho allenato gambe e core e petto e tricipiti negli ultimi due giorni",
        expectedCompound: /non ripeto gambe\/core né petto\/tricipiti/i,
      },
      {
        language: "es-ES",
        historyText: "Hoy vamos con piernas y core.",
        yesterday: "lo entrené ayer",
        dayBefore: "lo entrené antes de ayer",
        compound: "entrené piernas y core y pecho y tríceps los últimos dos días",
        expectedCompound: /no repito piernas\/core ni pecho\/tríceps/i,
      },
    ];

  for (const testCase of localizedCases) {
    it(`resolves contextual and compound history in ${testCase.language}`, async () => {
      const yesterdayUserId = `history-context-${testCase.language}-yesterday`;
      seedVisibleWorkoutFocus(yesterdayUserId);
      const yesterdayResponse = await postGuto({
        language: testCase.language,
        profile: { userId: yesterdayUserId, name: "Will" },
        history: [{ role: "model", parts: [{ text: testCase.historyText }] }],
        input: testCase.yesterday,
      });
      const yesterdayMemory = { ...readUserMemory(yesterdayUserId), ...yesterdayResponse.memoryPatch };
      assert.equal(yesterdayMemory.recentTrainingHistory?.[0]?.muscleGroup, "legs_core");
      assert.equal(yesterdayMemory.recentTrainingHistory?.[0]?.dateLabel, "yesterday");
      assert.notEqual(yesterdayMemory.nextWorkoutFocus, "legs_core");
      assertNoPortugueseLeak(yesterdayResponse, testCase.language);

      const dayBeforeUserId = `history-context-${testCase.language}-day-before`;
      seedVisibleWorkoutFocus(dayBeforeUserId);
      const dayBeforeResponse = await postGuto({
        language: testCase.language,
        profile: { userId: dayBeforeUserId, name: "Will" },
        history: [{ role: "model", parts: [{ text: testCase.historyText }] }],
        input: testCase.dayBefore,
      });
      const dayBeforeMemory = { ...readUserMemory(dayBeforeUserId), ...dayBeforeResponse.memoryPatch };
      assert.equal(dayBeforeMemory.recentTrainingHistory?.[0]?.muscleGroup, "legs_core");
      assert.equal(dayBeforeMemory.recentTrainingHistory?.[0]?.dateLabel, "day_before_yesterday");
      assert.equal(dayBeforeMemory.trainingLimitations, undefined);

      const compoundUserId = `history-context-${testCase.language}-compound`;
      const compoundResponse = await postGuto({
        language: testCase.language,
        profile: { userId: compoundUserId, name: "Will", trainingLocation: "academia" },
        history: [],
        input: testCase.compound,
      });
      const compoundMemory = { ...readUserMemory(compoundUserId), ...compoundResponse.memoryPatch };
      const groups = new Set(compoundMemory.recentTrainingHistory?.map((item: any) => `${item.muscleGroup}:${item.dateLabel}`));
      assert.equal(groups.has("legs_core:recent"), true);
      assert.equal(groups.has("chest_triceps:recent"), true);
      assert.equal(compoundMemory.nextWorkoutFocus, "back_biceps");
      assert.match(compoundResponse.fala || "", testCase.expectedCompound);
      assertNoPortugueseLeak(compoundResponse, testCase.language);
      assert.doesNotMatch(compoundResponse.fala || "", /Perdi conexão|conexão/i);
    });
  }
});
