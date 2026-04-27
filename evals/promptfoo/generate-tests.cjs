const { readFileSync } = require("fs");
const { resolve } = require("path");

const CASES_FILE = process.env.GUTO_EVAL_CASES_FILE || "evals/guto-cases.jsonl";
const GROUP_TO_CATEGORY = {
  resistencia: "resistencia",
  continuidade: "resistencia",
  conclusao: "resistencia",
  planejamento: "resistencia",
  direcao: "resistencia",
  higiene: "higiene",
  nonsense: "higiene",
  idioma: "idioma",
  intake: "memoria",
  memoria: "memoria",
  risco_real: "risco_real",
  risco_fisico: "risco_real",
  emocional: "risco_real",
  persona: "persona",
  manipulacao: "persona",
  foco: "persona",
  vida: "persona",
  execucao: "persona",
};

function loadCases() {
  const absolute = resolve(process.cwd(), CASES_FILE);
  return readFileSync(absolute, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`JSON invalido em ${CASES_FILE}:${index + 1}`);
      }
    });
}

module.exports = async function generateTests() {
  return loadCases().map((testCase) => ({
    description: `${testCase.id} [${testCase.group}]`,
    vars: {
      id: testCase.id,
      group: testCase.group,
      category: testCase.category || GROUP_TO_CATEGORY[testCase.group] || "persona",
      input: testCase.input,
      language: testCase.language || "pt-BR",
      history: { items: testCase.history || [] },
      profile: testCase.profile || {},
      memory: testCase.memory || {},
      ...(testCase.expectedResponse ? { expectedResponse: testCase.expectedResponse } : {}),
      assertions: testCase.assertions || {},
      rubric: { items: testCase.rubric || [] },
    },
    metadata: {
      id: testCase.id,
      group: testCase.group,
      category: testCase.category || GROUP_TO_CATEGORY[testCase.group] || "persona",
    },
    assert: [
      {
        type: "javascript",
        value: "file://evals/promptfoo/guto-deterministic-assert.cjs",
      },
      {
        type: "javascript",
        value: "file://evals/promptfoo/guto-rubric-judge.cjs",
      },
    ],
  }));
};
