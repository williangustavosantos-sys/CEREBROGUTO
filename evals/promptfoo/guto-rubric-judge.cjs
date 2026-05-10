// Judge LLM dos evals do GUTO — Claude Sonnet via Anthropic Messages API.
// Independente do modelo do GUTO (Gemini), evita auto-grade.
//
// Uses direct fetch (não SDK) porque este arquivo é CJS e o @anthropic-ai/sdk
// é ESM-first — interop é frágil. fetch nativo é Node 18+ e basta.
const JUDGE_MODEL =
  process.env.GUTO_EVAL_JUDGE_MODEL ||
  "claude-sonnet-4-5-20250929";

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

module.exports = async function gutoRubricJudge(output, context) {
  const vars = context.vars || {};
  const rubric = Array.isArray(vars.rubric?.items) ? vars.rubric.items : [];
  const enabled = process.env.GUTO_EVAL_JUDGE !== "0";
  const response = parseOutput(output);

  if (!enabled || !process.env.ANTHROPIC_API_KEY || !rubric.length || !response.fala) {
    return {
      pass: true,
      score: 1,
      reason:
        "Juiz LLM ignorado. Defina ANTHROPIC_API_KEY e mantenha GUTO_EVAL_JUDGE != 0 para ativar.",
    };
  }

  const prompt = [
    "Voce avalia respostas do GUTO, um sistema de acao e accountability.",
    "Julgue comportamento, nao estilo bonito.",
    "Retorne somente JSON valido no formato:",
    '{"passed":true,"score":5,"failures":[],"notes":"..."}',
    "Score 1-5: 1=quebra persona/erra grave; 3=ok com falha menor; 4=cumpre rubrica; 5=cumpre + execucao exemplar.",
    "Pass = passed:true AND score>=4 AND failures vazio.",
    "",
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

  let judgeResponse;
  let data;
  try {
    judgeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 1024,
        system:
          "You are a strict judge of GUTO chatbot behavior. Return ONLY valid JSON: " +
          '{"passed": <boolean>, "score": <1-5>, "failures": <string[]>, "notes": <string>}. ' +
          "No prose, no markdown, no code fences.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    data = await judgeResponse.json().catch(() => ({}));
  } catch (err) {
    return {
      pass: true,
      score: 1,
      reason: `Juiz LLM indisponivel: ${err && err.message ? err.message : String(err)}`,
    };
  }

  if (!judgeResponse.ok || (data && data.error)) {
    return {
      pass: true,
      score: 1,
      reason: `Juiz LLM indisponivel: ${(data && data.error && data.error.message) || judgeResponse.status}`,
    };
  }

  try {
    // Anthropic Messages API shape: { content: [{ type: "text", text: "..." }] }
    const raw = (data && data.content && data.content[0] && data.content[0].text) || "{}";
    // Strip markdown fences se Claude tiver enviado mesmo após o system prompt
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    const failures = Array.isArray(parsed.failures)
      ? parsed.failures.filter((item) => typeof item === "string")
      : [];
    const score = typeof parsed.score === "number" ? parsed.score : 0;
    const pass = parsed.passed === true && score >= 4 && failures.length === 0;

    return {
      pass,
      score: Math.max(0, Math.min(1, score / 5)),
      reason: pass
        ? parsed.notes || "Rubrica aprovada."
        : failures.join(" | ") || parsed.notes || "Rubrica reprovada.",
    };
  } catch {
    return {
      pass: true,
      score: 1,
      reason: "Juiz LLM retornou JSON invalido; caso nao foi bloqueado por falha do juiz.",
    };
  }
};
