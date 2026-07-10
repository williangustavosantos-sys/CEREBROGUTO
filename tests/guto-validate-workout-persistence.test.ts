import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("validate-workout persists memory through the serialized user write before success", () => {
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const routeStart = source.indexOf('app.post("/guto/validate-workout"');
  const routeEnd = source.indexOf("// ── Proactivity endpoints", routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);

  const route = source.slice(routeStart, routeEnd);
  const saveIndex = route.indexOf("saveMemory(memory);");
  const flushIndex = route.indexOf("await flushMemoryStoreWrites();", saveIndex);
  const successIndex = route.indexOf("return res.json({", flushIndex);

  assert.notEqual(saveIndex, -1);
  assert.notEqual(flushIndex, -1);
  assert.notEqual(successIndex, -1);
  assert.ok(saveIndex < flushIndex);
  assert.ok(flushIndex < successIndex);
  assert.doesNotMatch(route, /writeMemoryStore\(store\);/);
});
