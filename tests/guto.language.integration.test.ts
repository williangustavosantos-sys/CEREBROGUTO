import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

type GutoLanguage = "pt-BR" | "en-US" | "it-IT" | "es-ES";

type GutoResponse = {
  fala?: string;
  acao?: string;
  expectedResponse?: {
    instruction?: string;
    context?: string;
  } | null;
  workoutPlan?: {
    focus?: string;
    dateLabel?: string;
    summary?: string;
    exercises?: Array<{
      name?: string;
      cue?: string;
      note?: string;
    }>;
  } | null;
  memoryPatch?: Record<string, unknown>;
};

const testMemoryDir = join(process.cwd(), "tmp");
const testMemoryFile = join(testMemoryDir, "guto-memory.language-test.json");
const originalFetch = globalThis.fetch.bind(globalThis);

let app: { listen: (port: number, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";

const forbiddenPortuguese: Record<Exclude<GutoLanguage, "pt-BR">, string[]> = {
  "en-US": [
    "amanhã", "hoje", "peito", "costas", "pernas", "ombros", "abdômen",
    "treino", "treinar", "academia", "dor", "limitação", "me manda", "me responde",
    "fechado", "boa", "sem dor", "agora", "ontem", "anteontem",
  ],
  "it-IT": [
    "amanhã", "hoje", "peito", "costas", "bíceps", "pernas", "ombros", "abdômen",
    "treino", "treinar", "academia", "limitação", "me manda", "me responde",
    "fechado", "boa", "sem dor", "ontem", "anteontem",
  ],
  "es-ES": [
    "amanhã", "hoje", "peito", "costas", "ombros", "treino", "treinar",
    "academia", "limitação", "me manda", "me responde", "fechado", "boa", "sem dor",
    "ontem", "anteontem",
  ],
};

const expectedFocusByLanguage: Record<GutoLanguage, string[]> = {
  "pt-BR": ["peito e tríceps", "costas e bíceps", "pernas e core", "ombros e abdômen", "corpo inteiro"],
  "en-US": ["chest and triceps", "back and biceps", "legs and core", "shoulders and abs", "full body"],
  "it-IT": ["petto e tricipiti", "schiena e bicipiti", "gambe e core", "spalle e addome", "corpo intero"],
  "es-ES": ["pecho y tríceps", "espalda y bíceps", "piernas y core", "hombros y abdomen", "cuerpo completo"],
};

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function visibleText(response: GutoResponse) {
  const texts = [
    response.fala,
    response.expectedResponse?.instruction,
    response.workoutPlan?.focus,
    response.workoutPlan?.dateLabel,
    response.workoutPlan?.summary,
  ];
  for (const exercise of response.workoutPlan?.exercises || []) {
    texts.push(exercise.name, exercise.cue, exercise.note);
  }
  return texts.filter((text): text is string => Boolean(text)).join("\n");
}

function assertNoPortugueseLeak(response: GutoResponse, language: Exclude<GutoLanguage, "pt-BR">) {
  const text = ` ${normalize(visibleText(response)).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  for (const term of forbiddenPortuguese[language]) {
    const normalizedTerm = normalize(term).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    assert.equal(
      text.includes(` ${normalizedTerm} `),
      false,
      `Unexpected Portuguese term "${term}" in ${language} response:\n${visibleText(response)}`
    );
  }
}

function resetTestMemory() {
  mkdirSync(testMemoryDir, { recursive: true });
  writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
}

function readUserMemory(userId: string) {
  if (!existsSync(testMemoryFile)) return undefined;
  return JSON.parse(readFileSync(testMemoryFile, "utf8"))[userId];
}

function buildGeminiResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function installGeminiMock() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) {
      return originalFetch(input as any, init);
    }

    const response = JSON.stringify({
      fala: "Fechado. Amanhã eu puxo peito e tríceps. Me manda idade e dor.",
      acao: "none",
      expectedResponse: {
        type: "text",
        context: "training_limitations",
        instruction: "idade e dor",
      },
    });

    return new Response(JSON.stringify(buildGeminiResponse(response)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

async function postGuto(body: Record<string, unknown>) {
  const response = await originalFetch(`${baseUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  return (await response.json()) as GutoResponse;
}

before(async () => {
  process.env.GUTO_MEMORY_FILE = testMemoryFile;
  process.env.GUTO_DISABLE_LISTEN = "1";
  process.env.GEMINI_API_KEY = "test-gemini-key";

  resetTestMemory();
  installGeminiMock();

  const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
    app: { listen: (port: number, callback?: () => void) => Server };
  };
  app = serverModule.app;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
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
  rmSync(testMemoryDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetTestMemory();
});

describe("GUTO visible language guarantees", () => {
  const fullInputs: Array<{ language: GutoLanguage; input: string }> = [
    { language: "pt-BR", input: "amanhã às 15 na academia, tô voltando agora e tenho 30 anos sem dor" },
    { language: "en-US", input: "tomorrow at 3 pm at the gym, I am getting back into training and I am 30 with no pain" },
    { language: "it-IT", input: "domani alle 15 in palestra, sto riprendendo adesso e ho 30 anni senza dolore" },
    { language: "es-ES", input: "mañana a las 15 en el gimnasio, estoy volviendo ahora y tengo 30 años sin dolor" },
  ];

  for (const { language, input } of fullInputs) {
    it(`keeps full workout creation visible text in ${language}`, async () => {
      const userId = `language-full-${language}`;
      const response = await postGuto({
        language,
        profile: { userId, name: "Will" },
        history: [],
        input,
      });

      assert.equal(response.acao, "updateWorkout");
      assert.equal(response.expectedResponse, null);
      assert.ok(response.workoutPlan?.focus);
      assert.ok(expectedFocusByLanguage[language].map(normalize).includes(normalize(response.workoutPlan.focus || "")));

      const memory = readUserMemory(userId);
      assert.equal(memory.trainingAge, 30);
      assert.notEqual(memory.trainingAge, 15);

      if (language !== "pt-BR") {
        assertNoPortugueseLeak(response, language);
      } else {
        assert.match(response.workoutPlan?.focus || "", /peito e tríceps|costas e bíceps|pernas e core/i);
      }
    });
  }

  const historyCases: Array<{ language: GutoLanguage; historyText: string; input: string; expected: RegExp }> = [
    {
      language: "pt-BR",
      historyText: "Hoje a base é peito e tríceps.",
      input: "treinei isso ontem",
      expected: /não repito peito e tríceps/i,
    },
    {
      language: "en-US",
      historyText: "Today the base is chest and triceps.",
      input: "I trained that yesterday",
      expected: /not repeating chest and triceps/i,
    },
    {
      language: "it-IT",
      historyText: "Oggi la base è petto e tricipiti.",
      input: "l'ho allenato ieri",
      expected: /non ripeto petto e tricipiti/i,
    },
    {
      language: "es-ES",
      historyText: "Hoy la base es pecho y tríceps.",
      input: "lo entrené ayer",
      expected: /no repito pecho y tríceps/i,
    },
  ];

  for (const { language, historyText, input, expected } of historyCases) {
    it(`understands chest/triceps history reference in ${language}`, async () => {
      const response = await postGuto({
        language,
        profile: { userId: `language-history-${language}`, name: "Will" },
        history: [{ role: "model", parts: [{ text: historyText }] }],
        input,
      });

      assert.match(response.fala || "", expected);
      assert.equal(response.expectedResponse?.context, "training_limitations");
      if (language !== "pt-BR") {
        assertNoPortugueseLeak(response, language);
      }
    });
  }
});
