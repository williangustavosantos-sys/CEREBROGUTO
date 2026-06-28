// Commit 1 — Fatia 1: feature flag GUTO_BRAIN_SLICE1 (default OFF).
// Verifica a semântica ESTRITA (=== "true") lendo o config real em subprocessos
// isolados, porque config.ts lê process.env no momento do import (module-level).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, "..");
const configUrl = pathToFileURL(resolve(backendDir, "src/config.ts")).href;

/** Importa o config real num subprocesso com um valor de env e devolve config.brainSlice1. */
function readBrainSlice1Flag(envValue: string | undefined): string {
  // Projeto compila p/ CommonJS: no namespace ESM os exports nomeados ficam em m.default.
  const script = `import(${JSON.stringify(configUrl)}).then((m) => process.stdout.write(String((m.default ?? m).config.brainSlice1)));`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GUTO_BRAIN_SLICE1;
  // Evita os guards de produção do config.ts (allowDevAccess/jwt em prod).
  delete env.NODE_ENV;
  delete env.RENDER;
  if (envValue !== undefined) env.GUTO_BRAIN_SLICE1 = envValue;
  const r = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: backendDir,
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`falha ao importar config (status ${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

test("GUTO_BRAIN_SLICE1 ausente => false (default OFF)", () => {
  assert.equal(readBrainSlice1Flag(undefined), "false");
});

test('GUTO_BRAIN_SLICE1="true" => true', () => {
  assert.equal(readBrainSlice1Flag("true"), "true");
});

test('GUTO_BRAIN_SLICE1="1" => false (estrito, só "true" liga)', () => {
  assert.equal(readBrainSlice1Flag("1"), "false");
});

test('GUTO_BRAIN_SLICE1="yes" => false (estrito)', () => {
  assert.equal(readBrainSlice1Flag("yes"), "false");
});

test('GUTO_BRAIN_SLICE1="TRUE" => false (case-sensitive)', () => {
  assert.equal(readBrainSlice1Flag("TRUE"), "false");
});
