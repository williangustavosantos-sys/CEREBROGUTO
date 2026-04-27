const GLOBAL_FORBIDDEN = [
  "como posso ajudar",
  "em que posso ajudar",
  "procure ajuda",
  "busque ajuda",
  "procure um médico",
  "procure um medico",
  "procure um psicólogo",
  "procure um psicologo",
  "procure um especialista",
  "fale com um profissional",
];

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function parseOutput(output) {
  try {
    const parsed = JSON.parse(output);
    return {
      fala: String(parsed.fala || ""),
      acao: parsed.acao,
      expectedResponse: parsed.expectedResponse || null,
    };
  } catch {
    return { fala: String(output || ""), acao: undefined, expectedResponse: null };
  }
}

function countSentences(value) {
  return String(value || "")
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

module.exports = function deterministicGutoAssert(output, context) {
  const vars = context.vars || {};
  const assertions = vars.assertions || {};
  const response = parseOutput(output);
  const failures = [];
  const normalizedFala = normalize(response.fala);
  const forbidden = [...GLOBAL_FORBIDDEN, ...(Array.isArray(assertions.forbidden) ? assertions.forbidden : [])];

  if (!response.fala.trim()) failures.push("Campo fala ausente ou vazio.");

  for (const term of forbidden) {
    if (normalizedFala.includes(normalize(term))) {
      failures.push(`Contem termo proibido: "${term}".`);
    }
  }

  if (Array.isArray(assertions.requiredAny) && assertions.requiredAny.length) {
    const matched = assertions.requiredAny.some((term) => normalizedFala.includes(normalize(term)));
    if (!matched) failures.push(`Nao contem nenhum requiredAny: ${assertions.requiredAny.join(", ")}.`);
  }

  if (Array.isArray(assertions.requiredAll) && assertions.requiredAll.length) {
    const missing = assertions.requiredAll.filter((term) => !normalizedFala.includes(normalize(term)));
    if (missing.length) failures.push(`Nao contem requiredAll: ${missing.join(", ")}.`);
  }

  if (assertions.maxChars && response.fala.length > assertions.maxChars) {
    failures.push(`Resposta longa demais: ${response.fala.length}/${assertions.maxChars} chars.`);
  }

  if (assertions.maxSentences && countSentences(response.fala) > assertions.maxSentences) {
    failures.push(`Frases demais: ${countSentences(response.fala)}/${assertions.maxSentences}.`);
  }

  if (assertions.expectedAction && response.acao !== assertions.expectedAction) {
    failures.push(`Acao esperada ${assertions.expectedAction}, recebeu ${response.acao || "undefined"}.`);
  }

  if (Object.prototype.hasOwnProperty.call(assertions, "expectedResponseContext")) {
    const expectedContext = assertions.expectedResponseContext;
    const actualContext = response.expectedResponse?.context;
    if (expectedContext === null && response.expectedResponse) {
      failures.push(`expectedResponse deveria ser null, recebeu ${JSON.stringify(response.expectedResponse)}.`);
    } else if (expectedContext && actualContext !== expectedContext) {
      failures.push(`Contexto esperado ${expectedContext}, recebeu ${actualContext || "null"}.`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(assertions, "expectedResponseType")) {
    const expectedType = assertions.expectedResponseType;
    const actualType = response.expectedResponse?.type;
    if (expectedType === null && response.expectedResponse) {
      failures.push(`Tipo expectedResponse deveria ser null, recebeu ${actualType}.`);
    } else if (expectedType && actualType !== expectedType) {
      failures.push(`Tipo expectedResponse esperado ${expectedType}, recebeu ${actualType || "null"}.`);
    }
  }

  return {
    pass: failures.length === 0,
    score: failures.length === 0 ? 1 : 0,
    reason: failures.length ? failures.join(" | ") : "Comportamento deterministico aprovado.",
  };
};
