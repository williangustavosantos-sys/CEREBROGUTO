import "./test-env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const tmpDir = join(process.cwd(), "tmp");
const testMemoryFile = join(tmpDir, "guto-memory.diet-generation-test.json");
const testDietFile = join(tmpDir, "guto-diet.generation-test.json");

let app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
let server: Server;
let baseUrl = "";
let originalFetch: typeof globalThis.fetch;

function readMemory(userId: string) {
  if (!existsSync(testMemoryFile)) return {};
  return (JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>)[userId] || {};
}

function writeMemory(userId: string, data: Record<string, any>) {
  const store = existsSync(testMemoryFile)
    ? JSON.parse(readFileSync(testMemoryFile, "utf8")) as Record<string, any>
    : {};
  store[userId] = { userId, name: "Will", language: "it-IT", ...data };
  writeFileSync(testMemoryFile, JSON.stringify(store, null, 2));
}

function authHeaders(userId: string) {
  const token = jwt.sign({ userId, role: "student" }, process.env.JWT_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function defaultDietModelResponse() {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                meals: [
                  {
                    id: "breakfast",
                    name: "Colazione",
                    time: "08:00",
                    totalKcal: 700,
                    gutoNote: "Base pulita, niente lattosio.",
                    foods: [
                      { name: "Avena", quantity: "80g", kcal: 300 },
                      { name: "Banana", quantity: "1 unit", kcal: 120 },
                      { name: "Uova", quantity: "3 units", kcal: 220 },
                      { name: "Olio di oliva", quantity: "5g", kcal: 60 },
                    ],
                  },
                  {
                    id: "lunch",
                    name: "Pranzo",
                    time: "13:00",
                    totalKcal: 800,
                    gutoNote: "Carbo e proteina senza inventare.",
                    foods: [
                      { name: "Pollo", quantity: "200g", kcal: 330 },
                      { name: "Riso", quantity: "180g", kcal: 250 },
                      { name: "Verdure", quantity: "200g", kcal: 80 },
                      { name: "Olio di oliva", quantity: "15g", kcal: 140 },
                    ],
                  },
                  {
                    id: "snack",
                    name: "Spuntino",
                    time: "17:00",
                    totalKcal: 800,
                    gutoNote: "Energia prima del blocco serale.",
                    foods: [
                      { name: "Tonno", quantity: "160g", kcal: 260 },
                      { name: "Patata", quantity: "300g", kcal: 260 },
                      { name: "Pane integrale", quantity: "100g", kcal: 220 },
                      { name: "Frutto", quantity: "1 unit", kcal: 60 },
                    ],
                  },
                  {
                    id: "dinner",
                    name: "Cena",
                    time: "20:30",
                    totalKcal: 620,
                    gutoNote: "Chiude il giorno senza latticini.",
                    foods: [
                      { name: "Pesce", quantity: "200g", kcal: 300 },
                      { name: "Pasta", quantity: "100g", kcal: 180 },
                      { name: "Verdure", quantity: "200g", kcal: 80 },
                      { name: "Olio di oliva", quantity: "5g", kcal: 60 },
                    ],
                  },
                ],
              }),
            },
          ],
        },
      },
    ],
  };
}

let dietModelResponse = defaultDietModelResponse;

function dietModelResponseWithBrazilianStapleOutsideBrazil() {
  const response = defaultDietModelResponse();
  const part = response.candidates[0]?.content.parts[0];
  assert.ok(part);
  const parsed = JSON.parse(part.text) as {
    meals: Array<{ foods: Array<{ name: string; quantity: string; kcal: number }> }>;
  };
  parsed.meals[0].foods[0].name = "Tapioca";
  parsed.meals[0].foods[0].quantity = "100g";
  part.text = JSON.stringify(parsed);
  return response;
}

describe("diet generation contract", () => {
  before(async () => {
    process.env.GUTO_MEMORY_FILE = testMemoryFile;
    process.env.GUTO_DIET_FILE = testDietFile;
    process.env.GUTO_DISABLE_LISTEN = "1";
    process.env.GUTO_ALLOW_DEV_ACCESS = "true";
    mkdirSync(tmpDir, { recursive: true });
    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("generativelanguage.googleapis.com")) {
        return originalFetch(input as any, init);
      }
      return new Response(JSON.stringify(dietModelResponse()), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const serverModule = (await import(pathToFileURL(join(process.cwd(), "server.ts")).href)) as {
      app: { listen: (port: number, hostname: string, callback?: () => void) => Server };
    };
    app = serverModule.app;
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind diet test server.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    dietModelResponse = defaultDietModelResponse;
    writeFileSync(testMemoryFile, JSON.stringify({}, null, 2));
    rmSync(testDietFile, { force: true });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(testMemoryFile, { force: true });
    rmSync(testDietFile, { force: true });
  });

  it("gera dieta a partir do intake validado e respeita lattosio", async () => {
    const userId = "diet-lattosio-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "Lattosio",
      resolvedFields: {
        foodRestriction: { rawValue: "Lattosio", status: "clear", normalizedValue: "lactose_intolerance" },
      },
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });

    assert.equal(res.status, 200);
    const plan = await res.json() as { meals: Array<{ foods: Array<{ name: string }> }>; foodRestrictions: string };
    const foodText = JSON.stringify(plan.meals).toLowerCase();
    assert.doesNotMatch(foodText, /latte|yogurt|mozzarella|ricotta|parmigiano/);
    assert.equal(plan.foodRestrictions, "Lattosio");

    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "generated");
    assert.ok(memory.memoryAudit.some((entry: any) => entry.source === "diet_generated"));
  });

  it("gera dieta mesmo com patologia física ambígua: patologia NÃO bloqueia nem aparece na dieta", async () => {
    // Bug 3: limitação física (treino) estava contaminando a dieta. A dieta só
    // pode depender de perfil nutricional + restrição alimentar. Mesmo com uma
    // patologia incerta pendente, a dieta deve ser gerada normalmente.
    const userId = "diet-pathology-decoupled";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Brasil",
      countryCode: "BR",
      city: "São Paulo",
      trainingPathology: "Gambia",
      trainingLimitations: "Gambia",
      foodRestrictions: "lactose",
      resolvedFields: {
        foodRestriction: { rawValue: "lactose", status: "clear", normalizedValue: "lactose_intolerance" },
        pathology: { rawValue: "Gambia", status: "needs_confirmation" },
      },
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { meals?: unknown[]; code?: string; message?: string };
    // Nunca pode retornar o código/mensagem de patologia na dieta.
    assert.notEqual(body.code, "TRAINING_PATHOLOGY_NEEDS_CLARIFICATION");
    assert.equal(body.message, undefined);
    assert.ok(Array.isArray(body.meals) && body.meals.length > 0);
    // Não pode vazar lactose (restrição alimentar real).
    const foodText = JSON.stringify(body.meals).toLowerCase();
    assert.doesNotMatch(foodText, /latte|yogurt|mozzarella|ricotta|parmigiano|leite|queijo/);

    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "generated");
  });

  it("recusa gerar sem countryCode e peso (422) com mensagem em en-US", async () => {
    const userId = "diet-missing-profile-en";
    writeMemory(userId, {
      biologicalSex: "female",
      userAge: 28,
      heightCm: 165,
      trainingLevel: "beginner",
      trainingGoal: "fat_loss",
      country: "Brazil",
      // countryCode, weightKg missing
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "en-US" }),
    });

    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string; missing: string[]; message: string };
    assert.equal(body.error, "missing_profile_fields");
    assert.ok(body.missing.includes("countryCode"));
    assert.ok(body.missing.includes("weightKg"));
    assert.match(body.message, /calibration/i);
  });

  it("recusa gerar sem perfil completo em pt-BR", async () => {
    const userId = "diet-missing-profile-pt";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 30,
      weightKg: 80,
      heightCm: 180,
      trainingGoal: "muscle_gain",
      countryCode: "BR",
      country: "Brasil",
      // trainingLevel missing
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 422);
    const body = (await res.json()) as { message: string };
    assert.match(body.message, /calibragem|montar tua dieta/i);
  });

  it("recusa comida brasileira difícil de achar quando país é Itália mesmo com app em português", async () => {
    const userId = "diet-italy-portuguese-no-tapioca";
    dietModelResponse = dietModelResponseWithBrazilianStapleOutsideBrazil;
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { reason?: string; issues?: string[]; message?: string };
    assert.equal(body.reason, "location");
    assert.ok(body.issues?.some((issue) => issue.includes("tapioca")));
    assert.match(body.message || "", /onde você mora|local/i);
    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "failed");
  });

  it("recusa peixe quando NÃO COMO declara peixe ou frutos do mar", async () => {
    const userId = "diet-no-fish-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "não como peixe",
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; reason?: string; issues?: string[]; message?: string };
    assert.equal(body.error, "diet_generation_failed");
    assert.equal(body.reason, "food_restriction");
    assert.ok(body.issues?.some((issue) => issue.includes("seafood/fish")));
    assert.match(body.message || "", /não come|do not eat/i);
    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "failed");
  });

  it("recusa ovo quando NÃO COMO declara ovo", async () => {
    const userId = "diet-no-egg-user";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      city: "Roma",
      foodRestrictions: "não como ovo",
    });

    const res = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "pt-BR" }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; reason?: string; issues?: string[]; message?: string };
    assert.equal(body.error, "diet_generation_failed");
    assert.equal(body.reason, "food_restriction");
    assert.ok(body.issues?.some((issue) => issue.includes("egg")));
    assert.match(body.message || "", /não come|do not eat/i);
    const memory = readMemory(userId);
    assert.equal(memory.dietGenerationStatus, "failed");
  });

  it("GET /guto/diet devolve plano após generate", async () => {
    const userId = "diet-get-after-generate";
    writeMemory(userId, {
      biologicalSex: "male",
      userAge: 35,
      heightCm: 178,
      weightKg: 82,
      trainingLevel: "consistent",
      trainingGoal: "muscle_gain",
      country: "Italia",
      countryCode: "IT",
      foodRestrictions: "none",
      resolvedFields: {
        foodRestriction: { rawValue: "none", status: "clear", normalizedValue: "none" },
      },
    });

    const generate = await originalFetch(`${baseUrl}/guto/diet/generate`, {
      method: "POST",
      headers: authHeaders(userId),
      body: JSON.stringify({ language: "it-IT" }),
    });
    assert.equal(generate.status, 200);

    const getRes = await originalFetch(`${baseUrl}/guto/diet`, {
      method: "GET",
      headers: authHeaders(userId),
    });
    assert.equal(getRes.status, 200);
    const plan = (await getRes.json()) as { meals: unknown[] };
    assert.ok(Array.isArray(plan.meals) && plan.meals.length > 0);
  });
});
