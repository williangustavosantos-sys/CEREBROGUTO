/**
 * GUTO Workout Level Structure (Fase 3L)
 *
 * Camada DETERMINÍSTICA que faz o `trainingLevel` virar comportamento real de
 * volume/intensidade — não dado morto. Aplica-se ao plano DEPOIS do filtro de
 * patologia e ANTES da progressão semanal, tanto para o plano vindo do curator
 * (IA) quanto do template determinístico.
 *
 * Princípio: avançado nunca recebe treino de iniciante. Se há dor/patologia, o
 * avançado continua avançado, mas com a região protegida (o filtro de segurança
 * já trocou/removeu exercícios antes) — e o resumo deixa isso claro.
 *
 * Não escolhe exercícios (isso é do catálogo/curator). Ajusta dose e mensagem.
 */

export type TrainingLevel = "beginner" | "returning" | "consistent" | "advanced";
export type WorkoutLanguage = "pt-BR" | "en-US" | "it-IT";

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function hasToken(haystack: string, tokens: string[]): boolean {
  // Pontuação ("avançado,") não pode quebrar o casamento por palavra.
  const cleaned = ` ${haystack.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  return tokens.some((t) => cleaned.includes(` ${normalize(t)} `));
}

/**
 * Resolve o nível efetivo a partir do enum limpo da calibragem
 * (`trainingLevel`) e/ou do `trainingStatus` (texto livre). Reconhece os 4
 * níveis canônicos em pt/en/it. Default = "consistent" (usuário ativo), que
 * preserva o baseline histórico — nunca rebaixa para iniciante por engano.
 *
 * Precedência: `trainingLevel` (enum canônico) > `trainingStatus` (texto livre).
 * Um aluno "consistent" que está "voltando" continua sendo consistent —
 * trainingStatus descreve o momento atual, não redefine a experiência acumulada.
 */
export function resolveTrainingLevel(level?: string, status?: string): TrainingLevel {
  // Enum canônico tem precedência absoluta sobre texto livre de status.
  // "voltando" em trainingStatus não deve rebaixar um "consistent" para "returning".
  const CANONICAL: Readonly<Record<string, TrainingLevel>> = {
    advanced: "advanced",
    consistent: "consistent",
    returning: "returning",
    beginner: "beginner",
  };
  const normalizedLevel = normalize(level || "");
  if (normalizedLevel in CANONICAL) {
    return CANONICAL[normalizedLevel];
  }

  // Fallback: texto livre de level + status para o caso de trainingLevel ser
  // texto livre (onboarding antigo) ou não ter sido preenchido.
  const n = normalize(`${level || ""} ${status || ""}`);
  if (!n) return "consistent";
  if (hasToken(n, ["advanced", "avancado", "avanzato", "avanzado", "experiente", "expert", "atleta"])) {
    return "advanced";
  }
  // "returning" antes de "beginner": "voltando depois de 2 meses parado" é retorno,
  // não iniciante — a palavra "voltando" tem prioridade sobre "parado".
  if (hasToken(n, ["returning", "voltando", "retornando", "retorno", "ripresa", "ripartendo", "rientro", "volta apos", "volta depois"])) {
    return "returning";
  }
  if (hasToken(n, ["beginner", "iniciante", "principiante", "parado", "nunca treinei", "sem treinar", "mai allenato", "novato", "comecando", "fermo"])) {
    return "beginner";
  }
  if (hasToken(n, ["consistent", "consistente", "costante", "constante", "treinando", "ja treino", "trained"])) {
    return "consistent";
  }
  return "consistent";
}

export interface LevelWorkoutExercise {
  id: string;
  muscleGroup: string;
  sets: number;
  reps: string;
  rest: string;
  note: string;
}

export interface LevelWorkoutPlan {
  focus: string;
  summary: string;
  difficulty?: string;
  exercises: LevelWorkoutExercise[];
}

function appendNote(note: string, addition: string): string {
  const base = (note || "").trim();
  return base ? `${base} ${addition}` : addition;
}

function advancedTechniqueNote(isStrength: boolean, language: WorkoutLanguage): string {
  if (language === "en-US") {
    return isStrength
      ? "Advanced: last set rest-pause (15s pause, then 3–5 more clean reps)."
      : "Advanced: last set to clean technical failure, control over ego.";
  }
  if (language === "it-IT") {
    return isStrength
      ? "Avanzato: ultima serie in rest-pause (pausa di 15s e altre 3–5 rip pulite)."
      : "Avanzato: ultima serie fino al cedimento tecnico, controllo prima dell'ego.";
  }
  return isStrength
    ? "Avançado: última série em rest-pause (pausa de 15s e mais 3–5 reps limpas)."
    : "Avançado: última série até a falha técnica, controle antes do ego.";
}

function beginnerNote(language: WorkoutLanguage): string {
  if (language === "en-US") return "Starter level: technique and full range first, load comes later.";
  if (language === "it-IT") return "Livello base: prima tecnica e ampiezza, il carico viene dopo.";
  return "Nível inicial: técnica e amplitude primeiro, carga vem depois.";
}

function levelDescriptor(level: TrainingLevel, hasLimitation: boolean, language: WorkoutLanguage): string | null {
  const L = {
    "pt-BR": {
      advancedSafe: "GUTO manteve o foco avançado e protegeu a área sensível: estímulo forte, com controle.",
      advanced: "GUTO manteve o foco avançado: volume e intensidade coerentes com teu nível.",
      beginner: "GUTO ajustou para nível inicial: volume controlado e técnica em primeiro lugar.",
    },
    "en-US": {
      advancedSafe: "GUTO kept the advanced focus and protected the sensitive area: strong stimulus, with control.",
      advanced: "GUTO kept the advanced focus: volume and intensity matching your level.",
      beginner: "GUTO set a starter level: controlled volume and technique first.",
    },
    "it-IT": {
      advancedSafe: "GUTO ha mantenuto il focus avanzato e protetto l'area sensibile: stimolo forte, con controllo.",
      advanced: "GUTO ha mantenuto il focus avanzato: volume e intensità coerenti col tuo livello.",
      beginner: "GUTO ha impostato un livello base: volume controllato e tecnica prima di tutto.",
    },
  }[language];
  if (level === "advanced") return hasLimitation ? L.advancedSafe : L.advanced;
  if (level === "beginner") return L.beginner;
  return null;
}

/**
 * Aplica a estrutura de nível ao plano. Aditivo e seguro:
 *  - avançado: +1 série nos compostos (cap 5) + técnica avançada na nota;
 *  - iniciante: limita volume a 3 séries + nota de técnica;
 *  - consistente/voltando: mantém o baseline (sem regressão).
 * Aquecimento nunca é alterado.
 */
export function applyLevelStructure<T extends LevelWorkoutPlan>(
  plan: T,
  opts: {
    level?: string;
    status?: string;
    goal?: string;
    hasLimitation?: boolean;
    language?: WorkoutLanguage;
  }
): T {
  const level = resolveTrainingLevel(opts.level, opts.status);
  const language = opts.language || "pt-BR";
  const isStrength = opts.goal === "muscle_gain" || opts.goal === "hypertrophy";

  let mainCount = 0;
  const exercises = plan.exercises.map((ex) => {
    if (ex.muscleGroup === "aquecimento") return ex;
    const isMain = mainCount < 2; // os 2 primeiros não-aquecimento = compostos
    mainCount += 1;
    const currentSets = Math.max(1, Number(ex.sets) || 3);

    if (level === "advanced") {
      return {
        ...ex,
        sets: isMain ? Math.min(5, currentSets + 1) : currentSets,
        note: isMain ? appendNote(ex.note, advancedTechniqueNote(isStrength, language)) : ex.note,
      };
    }
    if (level === "beginner") {
      return {
        ...ex,
        sets: Math.min(3, currentSets),
        note: isMain ? appendNote(ex.note, beginnerNote(language)) : ex.note,
      };
    }
    return ex; // consistent / returning → baseline
  });

  const descriptor = levelDescriptor(level, Boolean(opts.hasLimitation), language);
  return {
    ...plan,
    exercises,
    difficulty: level,
    summary: descriptor ? `${plan.summary} ${descriptor}`.trim() : plan.summary,
  };
}
