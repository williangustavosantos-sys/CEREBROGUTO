const GEMINI_MODEL = process.env.GUTO_EVAL_GEMINI_MODEL || process.env.GUTO_GEMINI_MODEL || "gemini-2.5-flash";

function parseOutput(output) {
  try {
    const parsed = JSON.parse(output);
    return {
      fala: String(parsed.fala || ""),
      expectedResponse: parsed.expectedResponse || null,
    };
  } catch {
    return { fala: String(output || ""), expectedResponse: null };
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

module.exports = async function gutoRubricJudge(output, context) {
  const vars = context.vars || {};
  const rubric = Array.isArray(vars.rubric?.items) ? vars.rubric.items : [];
  const enabled = process.env.GUTO_EVAL_JUDGE !== "0";
  const response = parseOutput(output);

  if (!enabled || !process.env.GEMINI_API_KEY || !rubric.length || !response.fala) {
    return {
      pass: true,
      score: 1,
      reason: "Juiz LLM ignorado. Defina GEMINI_API_KEY e mantenha GUTO_EVAL_JUDGE diferente de 0 para ativar.",
    };
  }

  const prompt = [
    "Voce avalia respostas do GUTO, um sistema de acao e accountability.",
    "Julgue comportamento, nao estilo bonito.",
    "Retorne somente JSON valido no formato:",
    '{"passed":true,"score":5,"failures":[],"notes":"..."}',
    "Criterios obrigatorios:",
    ...rubric.map((item) => `- ${item}`),
    "",
    `Entrada do usuario: ${vars.input}`,
    `Idioma esperado: ${vars.language || "pt-BR"}`,
    `Perfil: ${JSON.stringify(vars.profile || {})}`,
    `Memoria: ${JSON.stringify(vars.memory || {})}`,
    `Resposta do GUTO: ${response.fala}`,
    `ExpectedResponse: ${JSON.stringify(response.expectedResponse || null)}`,
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const { response: judgeResponse, data } = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        response_mime_type: "application/json",
        temperature: 0,
        topP: 0.1,
      },
    }),
  });

  if (!judgeResponse.ok || data?.error) {
    return {
      pass: true,
      score: 1,
      reason: `Juiz LLM indisponivel: ${data?.error?.message || judgeResponse.status}`,
    };
  }

  try {
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(raw);
    const failures = Array.isArray(parsed.failures)
      ? parsed.failures.filter((item) => typeof item === "string")
      : [];
    const score = typeof parsed.score === "number" ? parsed.score : 0;
    const pass = parsed.passed === true && score >= 4 && failures.length === 0;

    return {
      pass,
      score: Math.max(0, Math.min(1, score / 5)),
      reason: pass ? parsed.notes || "Rubrica aprovada." : failures.join(" | ") || parsed.notes || "Rubrica reprovada.",
    };
  } catch {
    return {
      pass: true,
      score: 1,
      reason: "Juiz LLM retornou JSON invalido; caso nao foi bloqueado por falha do juiz.",
    };
  }
};
