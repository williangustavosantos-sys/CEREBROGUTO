import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getV3Runtime } from "../src/v3/runtime.js";

interface DataPoint {
  testCaseId: string;
  input: Parameters<ReturnType<typeof getV3Runtime>["gutoTurnFlow"]>[0];
  reference?: unknown;
}

const file = resolve(process.cwd(), process.argv[2] || "evals/v3/guto-turn-dataset.json");
const data = JSON.parse(await readFile(file, "utf8")) as DataPoint[];
const runtime = getV3Runtime();
const completed = [];
for (const point of data) {
  const output = await runtime.gutoTurnFlow(point.input);
  completed.push({ ...point, output });
}
const results = await runtime.ai.evaluate({
  evaluator: runtime.behavioralEvaluator,
  dataset: completed,
  evalRunId: `guto-v3-${Date.now()}`,
});
const failed = results.filter((result) => {
  const evaluations = Array.isArray(result.evaluation) ? result.evaluation : [result.evaluation];
  return evaluations.some((evaluation) => evaluation.status === "FAIL");
});
process.stdout.write(`${JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length }, null, 2)}\n`);
if (failed.length) process.exitCode = 1;
