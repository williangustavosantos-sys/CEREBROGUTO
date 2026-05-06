import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

type GutoResponse = {
  fala?: string;
  acao?: string;
  expectedResponse?: {
    type?: string;
    instruction?: string;
    context?: string;
  } | null;
  avatarEmotion?: string;
  workoutPlan?: {
    scheduledFor?: string;
    exercises?: Array<unknown>;
  } | null;
  memoryPatch?: Record<string, unknown>;
};

const testMemoryDir = join(process.cwd(), "tmp");
const testMemoryFile = join(testMemoryDir, "guto-memory.integration-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";

const originalFetch = globalThis.fetch.bind(globalThis);

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

function buildGeminiResponse(text: string) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text }],
        },
      },
    ],
  };
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

function extractPrompt(init?: RequestInit) {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  return String(body?.contents?.[0]?.parts?.[0]?.text || "");
}

function installGeminiMock() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (!url.includes("generativelanguage.googleapis.com")) {
      return originalFetch(input as any, init);
    }

    const prompt = extractPrompt(init);

    const memory = extractFirstJsonObjectAfterMarker(prompt, ["Memória do usuário", "Memoria do usuario", "User memory", "MEMÓRIA"]);

    const inputMatch = prompt.match(/Mensagem atual do usuário: (.*)/);
    const inputMsg = inputMatch ? inputMatch[1].trim().toLowerCase() : "";

    // 1. Treino completo com tudo fornecido
    if (inputMsg.includes("15") && inputMsg.includes("30") && inputMsg.includes("academia")) {
      return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({
        fala: "Fechado! Treino marcado para amanhã às 15h00 na academia.",
        acao: "updateWorkout",
        expectedResponse: null,
        memoryPatch: {
          trainingSchedule: "tomorrow",
          trainingLocation: "academia",
          trainingStatus: "voltando agora",
          trainingAge: 30,
          trainingLimitations: "sem dor"
        }
      }))), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 2. Referência vaga de histórico
    if (inputMsg.includes("treinei isso") && inputMsg.includes("ontem")) {
      if (memory.lastSuggestedFocus || memory.lastWorkoutFocus) {
        return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({
          fala: "Boa. Não repito peito e tríceps. Me manda tua idade e dor.",
          acao: "none",
          expectedResponse: {
            type: "text",
            context: "training_limitations",
            instruction: "idade e dor",
          },
          trainedReference: {
            dateLabel: "yesterday"
          }
        }))), { status: 200, headers: { "Content-Type": "application/json" } });
      } else {
        return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({
          fala: "Treinou o que ontem? Preciso saber pra não repetir.",
          acao: "none",
          expectedResponse: null
        }))), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }

    // 3. Referência explícita de histórico
    if (inputMsg.includes("anteontem") && inputMsg.includes("costas")) {
      return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({
        fala: "Entendi, não repito peito nem costas. Vamos de pernas e core. Me manda idade e dor.",
        acao: "none",
        expectedResponse: {
          type: "text",
          context: "training_limitations",
          instruction: "idade e dor",
        },
        trainedReference: {
          dateLabel: "day_before_yesterday",
          explicitMuscleGroup: "back_biceps"
        }
      }))), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 4. Usuário doente
    if (inputMsg.includes("doente") || inputMsg.includes("não tô muito bem")) {
      return new Response(JSON.stringify(buildGeminiResponse(JSON.stringify({
        fala: "Sem heroísmo, vamos leve pra recuperar ritmo. Vai treinar em casa, academia ou parque?",
        acao: "none",
        expectedResponse: {
          type: "text",
          context: "training_location",
          instruction: "Onde vai treinar?",
        },
        memoryPatch: {
          trainingStatus: "doente e voltando agora",
          trainingLimitations: "voltando de doença"
        },
        avatarEmotion: "default"
      }))), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 5. Fallback padrão
    return new Response(
      JSON.stringify(
        buildGeminiResponse(
          JSON.stringify({
            fala: "Me manda onde você treina agora e como está o corpo.",
            acao: "none",
            expectedResponse: {
              type: "text",
              context: "training_location",
              instruction: "onde você treina agora e como está o corpo",
            },
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
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server.");
  }
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

describe("GUTO /guto integration", () => {
  it("handles a full out-of-order sentence and does not save trainingAge as the scheduled hour", async () => {
    const userId = "test-guto-ai-first";
    const response = await postGuto({
      language: "pt-BR",
      profile: {
        userId,
        name: "Will",
      },
      history: [],
      input: "amanhã às 15 na academia, tô voltando agora e tenho 30 anos sem dor",
    });

    assert.equal(response.acao, "updateWorkout");
    assert.equal(response.expectedResponse, null);
    assert.match(response.fala || "", /amanhã às 15h00/i);
    assert.match(response.fala || "", /academia/i);
    assert.ok(response.workoutPlan?.scheduledFor);
    assert.ok((response.workoutPlan?.exercises?.length || 0) > 0);

    const scheduledDate = new Date(String(response.workoutPlan?.scheduledFor));
    const now = new Date();
    assert.notEqual(scheduledDate.toDateString(), now.toDateString());

    const memory = readUserMemory(userId);
    assert.equal(memory.trainingSchedule, "tomorrow");
    assert.equal(memory.trainingLocation, "academia");
    assert.match(memory.trainingStatus, /voltando agora/i);
    assert.equal(memory.trainingAge, 30);
    assert.notEqual(memory.trainingAge, 15);
    assert.equal(memory.trainingLimitations, "sem dor");
    assert.ok(memory.lastWorkoutPlan);
  });

  it("handles 'treinei isso ontem' as training history, not pain", async () => {
    const userId = "test-historico-muscular";
    writeUserMemory(userId, { lastSuggestedFocus: "chest_triceps" });
    const response = await postGuto({
      language: "pt-BR",
      profile: {
        userId,
        name: "Will",
      },
      history: [
        {
          role: "model",
          parts: [
            {
              text: "Hoje a base vai ser peito e tríceps. Me fala em uma frase se você tava parado ou já vinha treinando.",
            },
          ],
        },
      ],
      input: "treinei isso ontem",
    });

    assert.doesNotMatch(response.fala || "", /amanhã/i);
    assert.match(response.fala || "", /não repito peito e tríceps/i);
    assert.equal(response.expectedResponse?.context, "training_limitations");
    assert.match(response.expectedResponse?.instruction || "", /idade/i);

    const memory = readUserMemory(userId);
    assert.equal(memory.trainingLimitations, undefined);
    assert.equal(memory.nextWorkoutFocus, "back_biceps");
    assert.equal(memory.recentTrainingHistory?.[0]?.dateLabel, "yesterday");
    assert.equal(memory.recentTrainingHistory?.[0]?.muscleGroup, "chest_triceps");
    assert.match(memory.recentTrainingHistory?.[0]?.raw || "", /treinei isso ontem/i);
  });

  it("continues from history and switches next focus to legs_core for 'treinei anteontem costas'", async () => {
    const userId = "test-historico-muscular";
    writeUserMemory(userId, { lastSuggestedFocus: "chest_triceps" });

    await postGuto({
      language: "pt-BR",
      profile: {
        userId,
        name: "Will",
      },
      history: [
        {
          role: "model",
          parts: [
            {
              text: "Hoje a base vai ser peito e tríceps. Me fala em uma frase se você tava parado ou já vinha treinando.",
            },
          ],
        },
      ],
      input: "treinei isso ontem",
    });

    const response = await postGuto({
      language: "pt-BR",
      profile: {
        userId,
        name: "Will",
      },
      history: [
        {
          role: "model",
          parts: [
            {
              text: "Hoje a base vai ser peito e tríceps. Me fala em uma frase se você tava parado ou já vinha treinando.",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              text: "treinei isso ontem",
            },
          ],
        },
      ],
      input: "treinei anteontem costas",
    });

    assert.doesNotMatch(response.fala || "", /costas e bíceps/i);
    assert.match(response.fala || "", /não repito peito nem costas/i);
    assert.match(response.fala || "", /pernas e core/i);
    assert.equal(response.expectedResponse?.context, "training_limitations");

    const memory = readUserMemory(userId);
    assert.equal(memory.trainingLimitations, undefined);
    assert.equal(memory.nextWorkoutFocus, "legs_core");
    assert.equal(memory.recentTrainingHistory?.[0]?.dateLabel, "day_before_yesterday");
    assert.equal(memory.recentTrainingHistory?.[0]?.muscleGroup, "back_biceps");
    assert.match(memory.recentTrainingHistory?.[0]?.raw || "", /treinei anteontem costas/i);
  });

  it("keeps a sick user on a light route and asks for a simple location", async () => {
    const userId = "test-doente";
    const response = await postGuto({
      language: "pt-BR",
      profile: {
        userId,
        name: "Will",
      },
      history: [],
      input: "não tô muito bem, fiquei doente e tô voltando agora",
    });

    assert.notEqual(response.acao, "updateWorkout");
    assert.equal(response.expectedResponse?.context, "training_location");
    assert.notEqual(response.avatarEmotion, "reward");
    assert.match(response.fala || "", /sem heroísmo|leve|recuperar ritmo/i);
    assert.match(response.fala || "", /casa|academia|parque/i);
    assert.doesNotMatch(response.fala || "", /procure ajuda|médico|psicólogo|especialista/i);
    assert.ok(!response.workoutPlan);

    const memory = readUserMemory(userId);
    assert.match(memory.trainingStatus || "", /doente|voltando agora/i);
    assert.equal(memory.trainingLimitations, "voltando de doença");
  });
});
