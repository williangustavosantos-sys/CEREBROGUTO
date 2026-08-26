import "dotenv/config";
import { randomUUID } from "node:crypto";
import { deriveV3Identity } from "../src/v3/legacy-identity.js";

// Validador REAL painel → Cérebro V3 (Preview).
//
// Executa, contra um backend de verdade, a jornada completa com um aluno
// CRIADO PELO PAINEL (não seed):
//   painel cria aluno → provisiona credencial V3 → login V3 → tenant mapping →
//   reset de senha → jornada (consentimento → calibragem → pacto → First Contact
//   → treino+dieta → chat → reload).
//
// Uso:
//   GUTO_VERIFY_API_URL=https://<backend-preview> \
//   GUTO_VERIFY_ADMIN_EMAIL=... GUTO_VERIFY_ADMIN_PASSWORD=... \
//   GUTO_VERIFY_STUDENT_EMAIL=... GUTO_VERIFY_STUDENT_PASSWORD=... \
//   npx tsx scripts/verify-panel-to-v3.ts
//
// Opcionais: GUTO_VERIFY_STUDENT_NAME, GUTO_VERIFY_TEAM_ID,
//            GUTO_VERIFY_FRONTEND_URL.

const base = (process.env.GUTO_VERIFY_API_URL || "http://localhost:3001").replace(/\/+$/, "");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

interface ApiResult { status: number; body: any }

async function api(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const res = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body };
}

async function expectStatus(
  path: string,
  options: { method?: string; token?: string; body?: unknown },
  expected: number,
): Promise<ApiResult> {
  const result = await api(path, options);
  if (result.status !== expected) {
    const label = `${options.method || "GET"} ${path}`;
    throw new Error(`${label} -> ${result.status} (esperado ${expected}): ${JSON.stringify(result.body).slice(0, 400)}`);
  }
  return result;
}

interface Check { pass: boolean; note: string }
const results: Record<string, Check> = {};

function mark(key: string, pass: boolean, note = ""): void {
  results[key] = { pass, note };
}

async function main(): Promise<void> {
  const adminEmail = required("GUTO_VERIFY_ADMIN_EMAIL");
  const adminPassword = required("GUTO_VERIFY_ADMIN_PASSWORD");
  const studentEmail = required("GUTO_VERIFY_STUDENT_EMAIL");
  const studentPassword = required("GUTO_VERIFY_STUDENT_PASSWORD");
  const studentName = process.env.GUTO_VERIFY_STUDENT_NAME?.trim() || "Aluno Painel V3";
  const requestedTeamId = process.env.GUTO_VERIFY_TEAM_ID?.trim() || undefined;

  // V3_ONLY + readiness do ambiente
  try {
    const health = await api("/health/v3");
    const body = health.body || {};
    mark(
      "V3_ONLY",
      health.status === 200 && body.enabled === true && body.ready === true,
      `enabled=${body.enabled} ready=${body.ready} v3Only=${body.v3Only} (status ${health.status})`,
    );
  } catch (error) {
    mark("V3_ONLY", false, String(error));
  }

  // 1. Login admin (painel) — autoridade administrativa.
  let adminToken = "";
  try {
    const login = await expectStatus("/auth/admin/login", {
      method: "POST",
      body: { email: adminEmail, password: adminPassword },
    }, 200);
    adminToken = login.body.token as string;
  } catch (error) {
    mark("PANEL_TO_V3_PROVISIONING", false, `admin login: ${String(error)}`);
    mark("PANEL_CREATED_USER_V3_LOGIN", false, "admin login falhou");
    mark("TENANT_MAPPING", false, "admin login falhou");
    mark("PASSWORD_RESET_SYNC", false, "admin login falhou");
    mark("NO_IDENTITY_DUPLICATION", false, "admin login falhou");
    finish();
    return;
  }

  // 2. Painel cria aluno (com senha) → provisionamento V3 deve disparar.
  const createBody: Record<string, unknown> = {
    name: studentName,
    email: studentEmail,
    password: studentPassword,
    active: true,
  };
  if (requestedTeamId) createBody.teamId = requestedTeamId;

  let legacyUserId = "";
  let actualTeamId = "GUTO_CORE";
  try {
    const create = await expectStatus("/admin/students", {
      method: "POST",
      token: adminToken,
      body: createBody,
    }, 201);
    legacyUserId = create.body.user?.userId as string;
    actualTeamId = (create.body.user?.teamId as string) || requestedTeamId || "GUTO_CORE";
  } catch (error) {
    mark("PANEL_TO_V3_PROVISIONING", false, `criar aluno: ${String(error)}`);
    mark("PANEL_CREATED_USER_V3_LOGIN", false, "criar aluno falhou");
    mark("TENANT_MAPPING", false, "criar aluno falhou");
    mark("PASSWORD_RESET_SYNC", false, "criar aluno falhou");
    mark("NO_IDENTITY_DUPLICATION", false, "criar aluno falhou");
    finish();
    return;
  }

  // 3. Login V3 com a MESMA credencial do painel (prova o provisionamento).
  let v3Token = "";
  try {
    let login: ApiResult = { status: 0, body: null };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      login = await api("/guto/v3/auth/login", {
        method: "POST",
        body: { emailOrId: studentEmail, password: studentPassword },
      });
      if (login.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (login.status !== 200) throw new Error(JSON.stringify(login.body).slice(0, 300));
    v3Token = login.body.token as string;
    mark("PANEL_TO_V3_PROVISIONING", true, `credencial provisionada; login V3 ok (userId=${login.body.userId})`);
    mark("PANEL_CREATED_USER_V3_LOGIN", true, `aluno do painel logou no V3 (role=${login.body.role})`);
  } catch (error) {
    mark("PANEL_TO_V3_PROVISIONING", false, String(error));
    mark("PANEL_CREATED_USER_V3_LOGIN", false, String(error));
  }

  // 4. Tenant mapping + identidade sem duplicação.
  if (v3Token) {
    try {
      const state = await expectStatus("/guto/v3/state", { method: "GET", token: v3Token }, 200);
      const actor = state.body.state?.actor as { externalSubject?: string; tenantId?: string } | undefined;
      const expected = deriveV3Identity(legacyUserId, actualTeamId);
      const ok = actor?.externalSubject === legacyUserId && actor?.tenantId === expected.tenantId;
      mark(
        "TENANT_MAPPING",
        ok,
        `teamId=${actualTeamId} -> slug=${expected.tenantSlug}; externalSubject=${actor?.externalSubject} tenantId=${actor?.tenantId} (esperado ${expected.tenantId})`,
      );
    } catch (error) {
      mark("TENANT_MAPPING", false, String(error));
    }
  } else {
    mark("TENANT_MAPPING", false, "sem token V3");
  }

  // 5. Sem duplicação: re-criar o MESMO email → 409 no painel; e re-provisionar
  //    o mesmo aluno NÃO pode criar outra identidade.
  try {
    const duplicate = await api("/admin/students", { method: "POST", token: adminToken, body: createBody });
    let note = `re-criar email -> ${duplicate.status}`;
    if (v3Token) {
      const state = await expectStatus("/guto/v3/state", { method: "GET", token: v3Token }, 200);
      const actor = state.body.state?.actor as { externalSubject?: string } | undefined;
      note += `; externalSubject=${actor?.externalSubject} (deve ser ${legacyUserId})`;
    }
    mark("NO_IDENTITY_DUPLICATION", duplicate.status === 409, note);
  } catch (error) {
    mark("NO_IDENTITY_DUPLICATION", false, String(error));
  }

  // 6. Reset de senha pelo painel → sincroniza no V3 (nova senha loga, antiga não).
  let newPassword = "";
  try {
    newPassword = `${studentPassword}!nova`;
    await expectStatus(`/admin/students/${encodeURIComponent(legacyUserId)}/reset-password`, {
      method: "POST",
      token: adminToken,
      body: { password: newPassword },
    }, 200);
    const loginNew = await api("/guto/v3/auth/login", {
      method: "POST",
      body: { emailOrId: studentEmail, password: newPassword },
    });
    const loginOld = await api("/guto/v3/auth/login", {
      method: "POST",
      body: { emailOrId: studentEmail, password: studentPassword },
    });
    const ok = loginNew.status === 200 && loginOld.status === 401;
    mark("PASSWORD_RESET_SYNC", ok, `nova senha=${loginNew.status}, senha antiga=${loginOld.status}`);
    if (loginNew.status === 200) v3Token = loginNew.body.token as string;
  } catch (error) {
    mark("PASSWORD_RESET_SYNC", false, String(error));
  }

  // 7. Autenticação V3 do frontend (endpoints que o app Preview chama).
  try {
    const me = await expectStatus("/guto/v3/auth/me", { method: "GET", token: v3Token }, 200);
    const ok = me.body?.role === "student" && Boolean(me.body?.userId);
    mark("FRONTEND_V3_AUTH", ok, `role=${me.body?.role} userId=${me.body?.userId}`);
  } catch (error) {
    mark("FRONTEND_V3_AUTH", false, String(error));
  }

  // 8. Jornada real (consentimento → nome → calibragem → pacto → First Contact →
  //    treino+dieta → chat → reload).
  try {
    const rid = () => randomUUID();
    await expectStatus("/guto/v3/consent/accept", { method: "POST", token: v3Token, body: { requestId: rid() } }, 200);
    await expectStatus("/guto/v3/memory", {
      method: "POST", token: v3Token,
      body: { requestId: rid(), name: studentName, confirmedName: true, language: "pt-BR" },
    }, 200);
    await expectStatus("/guto/v3/memory", {
      method: "POST", token: v3Token,
      body: {
        requestId: rid(), language: "pt-BR",
        biologicalSex: "female", userAge: 22, weightKg: 69, heightCm: 165,
        trainingLevel: "returning", trainingGoal: "muscle_gain", trainingFrequency: 4,
        preferredTrainingLocation: "gym", trainingPathology: "limitação lombar",
        country: "Andorra", city: "Arinsal", foodRestrictions: "vegetariana",
      },
    }, 200);
    await expectStatus("/guto/v3/memory", {
      method: "POST", token: v3Token,
      body: { requestId: rid(), name: studentName, language: "pt-BR", xpEvent: "grant_initial_xp" },
    }, 200);
    await expectStatus("/guto/v3/first-contact/start", { method: "POST", token: v3Token, body: { requestId: rid() } }, 200);
    await expectStatus("/guto/v3/first-contact/respond", {
      method: "POST", token: v3Token,
      body: { requestId: rid(), expectedStep: "food_restrictions", answer: "Vegetariana." },
    }, 200);
    await expectStatus("/guto/v3/first-contact/respond", {
      method: "POST", token: v3Token,
      body: { requestId: rid(), expectedStep: "training_limitations", answer: "Limitação lombar." },
    }, 200);
    await expectStatus("/guto/v3/first-contact/confirm", {
      method: "POST", token: v3Token,
      body: { requestId: rid(), confirmed: true },
    }, 200);

    const state = await expectStatus("/guto/v3/state", { method: "GET", token: v3Token }, 200);
    const s = state.body.state as any;
    const firstContactOk = s?.firstContact?.status === "COMPLETED";
    const workoutAndDietOk = Boolean(s?.workout?.items?.length) && Boolean(s?.diet?.meals?.length);
    mark("FIRST_CONTACT", firstContactOk, `status=${s?.firstContact?.status}`);
    mark("WORKOUT_AND_DIET", workoutAndDietOk, `workoutItems=${s?.workout?.items?.length} dietMeals=${s?.diet?.meals?.length}`);

    try {
      await expectStatus("/guto/v3", {
        method: "POST", token: v3Token,
        body: { message: "Oi, comecei.", requestId: rid() },
      }, 200);
      mark("CHAT", true, "turno respondido");
    } catch (error) {
      mark("CHAT", false, String(error));
    }

    const reloaded = await expectStatus("/guto/v3/state", { method: "GET", token: v3Token }, 200);
    const s2 = reloaded.body.state as any;
    const persisted = Boolean(s?.workout?.id) && s?.workout?.id === s2?.workout?.id && s?.diet?.id === s2?.diet?.id;
    mark("RELOAD_PERSISTENCE", persisted, `workout.id=${s?.workout?.id} diet.id=${s?.diet?.id}`);
  } catch (error) {
    mark("FIRST_CONTACT", false, String(error));
    mark("WORKOUT_AND_DIET", false, String(error));
    mark("CHAT", false, "jornada interrompida");
    mark("RELOAD_PERSISTENCE", false, "jornada interrompida");
  }

  finish();
}

function finish(): void {
  const coreKeys = [
    "PANEL_TO_V3_PROVISIONING",
    "PANEL_CREATED_USER_V3_LOGIN",
    "TENANT_MAPPING",
    "PASSWORD_RESET_SYNC",
    "FRONTEND_V3_AUTH",
    "FIRST_CONTACT",
    "WORKOUT_AND_DIET",
    "V3_ONLY",
  ];
  const allCorePass = coreKeys.every((key) => results[key]?.pass === true);

  const report: Record<string, string> = {};
  for (const key of coreKeys) report[key] = results[key]?.pass === true ? "PASS" : "FAIL";
  report["NO_IDENTITY_DUPLICATION"] = results["NO_IDENTITY_DUPLICATION"]?.pass === true ? "PASS" : "FAIL";
  report["CHAT"] = results["CHAT"]?.pass === true ? "PASS" : "FAIL";
  report["RELOAD_PERSISTENCE"] = results["RELOAD_PERSISTENCE"]?.pass === true ? "PASS" : "FAIL";
  report["FRONTEND_PREVIEW"] = process.env.GUTO_VERIFY_FRONTEND_URL || "NÃO INFORMADO";
  report["BACKEND_PREVIEW"] = base;
  report["READY_FOR_REAL_PRODUCT_TEST"] = allCorePass ? "YES" : "NO";

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  for (const [key, check] of Object.entries(results)) {
    process.stdout.write(`  [${check.pass ? "PASS" : "FAIL"}] ${key} — ${check.note}\n`);
  }
}

main().catch((error) => {
  console.error("verify-panel-to-v3 fatal:", error);
  process.exit(1);
});
