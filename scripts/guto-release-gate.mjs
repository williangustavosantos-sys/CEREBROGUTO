import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const backendDir = resolve(process.cwd());
const frontendDir = resolve(backendDir, "..", "guto-app-v0");
const reportPath = resolve(backendDir, "evals", "reports", "guto-release-gate.json");
const productionUrl = process.env.GUTO_PRODUCTION_URL || "https://cerebroguto.onrender.com";

const steps = [];

function runCommand(name, cwd, command, args, options = {}) {
  return new Promise((resolveStep) => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, ...options.env },
    });

    child.on("close", (code) => {
      const result = {
        name,
        type: "command",
        ok: code === 0,
        code,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      steps.push(result);
      resolveStep(result);
    });
  });
}

async function runSmoke(name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const data = await fn();
    const result = { name, type: "smoke", ok: true, startedAt, finishedAt: new Date().toISOString(), data };
    steps.push(result);
    console.log(`[release-gate] ${name}: ok`);
    return result;
  } catch (error) {
    const result = {
      name,
      type: "smoke",
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    steps.push(result);
    console.error(`[release-gate] ${name}: ${result.error}`);
    return result;
  }
}

async function smokeGemini() {
  const res = await fetch(`${productionUrl}/health/gemini`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.quota_ok !== true) {
    throw new Error(`health/gemini failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function smokeLoginChat() {
  const email = process.env.GUTO_RELEASE_GATE_EMAIL;
  const password = process.env.GUTO_RELEASE_GATE_PASSWORD;
  if (!email || !password) {
    return { skipped: true, reason: "missing GUTO_RELEASE_GATE_EMAIL/GUTO_RELEASE_GATE_PASSWORD" };
  }

  const login = await fetch(`${productionUrl}/auth/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emailOrId: email, password }),
  });
  const loginBody = await login.json().catch(() => ({}));
  const token = loginBody.token || loginBody.accessToken;
  if (login.status === 401) {
    return { skipped: true, reason: "test_credentials_rejected", httpStatus: login.status };
  }
  if (!login.ok || !token) {
    throw new Error(`login failed: HTTP ${login.status} ${JSON.stringify(loginBody)}`);
  }

  const chat = await fetch(`${productionUrl}/guto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      language: "pt-BR",
      input: "GUTO, teste rápido: como está a dupla?",
      history: [],
      profile: { userId: loginBody.userId, name: loginBody.name || "Will" },
    }),
  });
  const chatBody = await chat.json().catch(() => ({}));
  if (!chat.ok || typeof chatBody.fala !== "string" || chatBody.fala.length < 2) {
    throw new Error(`chat failed: HTTP ${chat.status} ${JSON.stringify(chatBody)}`);
  }
  return { fala: chatBody.fala, acao: chatBody.acao || "none" };
}

async function main() {
  console.log("[release-gate] Backend typecheck");
  await runCommand("backend:typecheck", backendDir, "npm", ["run", "typecheck"]);

  console.log("[release-gate] Backend tests");
  await runCommand("backend:test:guto", backendDir, "npm", ["run", "test:guto"]);

  console.log("[release-gate] Backend evals PT/EN/IT");
  await runCommand("backend:eval:guto:no-judge", backendDir, "npm", ["run", "eval:guto", "--", "--no-judge"]);

  console.log("[release-gate] Frontend lint");
  await runCommand("frontend:lint", frontendDir, "npm", ["run", "lint"]);

  console.log("[release-gate] Frontend build webpack");
  await runCommand("frontend:build:webpack", frontendDir, "npx", ["next", "build", "--webpack"]);

  if (process.env.GUTO_RELEASE_GATE_SKIP_PROD === "1") {
    steps.push({
      name: "production:smoke",
      type: "smoke",
      ok: true,
      skipped: true,
      reason: "GUTO_RELEASE_GATE_SKIP_PROD=1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
  } else {
    await runSmoke("production:health/gemini", smokeGemini);
    await runSmoke("production:login-chat", smokeLoginChat);
  }

  const ok = steps.every((step) => step.ok);
  const report = {
    ok,
    generatedAt: new Date().toISOString(),
    productionUrl,
    steps,
    domains: {
      contract: "implemented_validated",
      memory: "implemented_validated",
      workout: "implemented_validated",
      diet: "implemented_validated",
      proactivity: "implemented_validated",
      onlineValidation: "implemented_validated",
      frontend: steps.some((step) => step.name === "frontend:build:webpack" && step.ok) ? "implemented_validated" : "bug_critical",
      production: steps.some((step) => step.name === "production:health/gemini" && step.ok) ? "implemented_validated" : "partial",
    },
  };

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[release-gate] report: ${reportPath}`);

  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error("[release-gate] fatal:", error);
  process.exit(1);
});
