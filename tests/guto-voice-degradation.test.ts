import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("/voz degrades remote synthesis failures without surfacing upstream HTTP errors", () => {
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const routeStart = source.indexOf('app.post("/voz"');
  const routeEnd = source.indexOf('app.post("/guto-audio"', routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);

  const route = source.slice(routeStart, routeEnd);
  const synthUnavailableIndex = route.indexOf('[GUTO_VOICE] synth_unavailable');
  const responseIndex = route.indexOf("voiceUnavailable: true", synthUnavailableIndex);
  const gutoAudioIndex = route.indexOf('app.post("/guto-audio"');

  assert.notEqual(synthUnavailableIndex, -1);
  assert.notEqual(responseIndex, -1);
  assert.equal(gutoAudioIndex, -1);
  assert.doesNotMatch(route, /res\.status\(primary\.status\s*\|\|\s*502\)/);
  assert.doesNotMatch(route, /res\.status\(502\)/);
});
