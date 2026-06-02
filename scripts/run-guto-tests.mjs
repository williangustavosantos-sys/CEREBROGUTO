import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const backendDir = resolve(process.cwd());
const testsDir = resolve(backendDir, "tests");

// Mantém o backoff do curador instantâneo nos testes: cenários que caem em
// fallback (modelo mockado vazio) ainda exercem o retry (3 tentativas), mas sem
// dormir de verdade — suíte rápida e determinística. Produção usa o default.
if (!process.env.GUTO_CURATOR_BACKOFF_MS) process.env.GUTO_CURATOR_BACKOFF_MS = "0";
const files = readdirSync(testsDir)
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => resolve(testsDir, file));

for (const file of files) {
  console.log(`\n[guto-tests] ${file.replace(`${backendDir}/`, "")}`);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=1", file],
    {
      cwd: backendDir,
      stdio: "inherit",
      env: process.env,
    }
  );

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
