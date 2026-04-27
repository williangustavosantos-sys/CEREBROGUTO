const DEFAULT_BASE_URL = process.env.GUTO_EVAL_BASE_URL || "http://localhost:3001";

function slug(value) {
  return String(value || "case")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

class GutoBackendProvider {
  constructor(options = {}) {
    this.config = options.config || {};
  }

  id() {
    return "guto-backend";
  }

  async callApi(prompt, context = {}) {
    const vars = context.vars || {};
    const baseUrl = String(process.env.GUTO_EVAL_BASE_URL || this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    const testId = slug(vars.id || context.test?.description);
    const runId = slug(process.env.PROMPTFOO_RUN_ID || Date.now());
    const userId = `promptfoo-${runId}-${testId}`;
    const profile = vars.profile && typeof vars.profile === "object" ? vars.profile : {};
    const memory = vars.memory && typeof vars.memory === "object" ? vars.memory : {};
    const language = vars.language || profile.language || memory.language || "pt-BR";

    const memoryPayload = {
      userId,
      name: profile.name || memory.name || "Will",
      language,
      ...profile,
      ...memory,
    };

    const memoryResult = await fetchJson(`${baseUrl}/guto/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(memoryPayload),
    });

    if (!memoryResult.response.ok) {
      return {
        error: memoryResult.data?.message || `Falha ao preparar memoria: HTTP ${memoryResult.response.status}`,
      };
    }

    const payload = {
      profile: {
        name: "Will",
        userId,
        streak: 0,
        trainedToday: false,
        ...profile,
        ...memory,
      },
      input: String(prompt || vars.input || ""),
      language,
      history: Array.isArray(vars.history?.items) ? vars.history.items : [],
      expectedResponse: vars.expectedResponse || null,
    };

    const result = await fetchJson(`${baseUrl}/guto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!result.response.ok) {
      return {
        error: result.data?.message || `GUTO HTTP ${result.response.status}`,
        output: JSON.stringify(result.data || {}, null, 2),
      };
    }

    return {
      output: JSON.stringify(
        {
          fala: result.data?.fala || result.data?.message || "",
          acao: result.data?.acao || "none",
          expectedResponse: result.data?.expectedResponse || null,
        },
        null,
        2
      ),
    };
  }
}

module.exports = GutoBackendProvider;
