import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const backendDir = resolve(process.cwd());
const testsDir = resolve(backendDir, "tests");
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
