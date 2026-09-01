import { V3Error } from "./errors.js";

/**
 * The operational facts which may change over time.  They are intentionally
 * separate from relationship memories and from the UI profile cache: facts
 * have a valid time and a recorded time in PostgreSQL.
 */
export const OperationalFactTypes = [
  "GOAL",
  "BODY_WEIGHT",
  "TRAINING_FREQUENCY",
  "EXPERIENCE_LEVEL",
  "FOOD_CONSTRAINT",
  "FOOD_EXCLUSION",
  "PHYSICAL_CONSTRAINT",
  "LOCATION",
  "BEHAVIORAL_PREFERENCE",
] as const;

export type OperationalFactType = (typeof OperationalFactTypes)[number];
export type FactImpactDomain = "WORKOUT" | "NUTRITION" | "PROGRESS" | "PROACTIVITY" | "SESSION";

export interface FactChange {
  factType: OperationalFactType;
  canonicalValue: string;
  value: Record<string, unknown>;
  source: "user_declared" | "system";
  confirmationStatus: "FACT_CONFIRMED" | "FACT_UNKNOWN";
  /** A location spoken as "today" is a session hint, never a base-plan mutation. */
  scope?: "profile" | "session";
}

export interface RecordedFact extends FactChange {
  id: string;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  supersededAt: string | null;
  supersededBy: string | null;
}

export const FactImpactMap: Readonly<Record<OperationalFactType, readonly FactImpactDomain[]>> = {
  GOAL: ["WORKOUT", "NUTRITION"],
  BODY_WEIGHT: ["NUTRITION", "PROGRESS"],
  TRAINING_FREQUENCY: ["WORKOUT", "PROGRESS"],
  EXPERIENCE_LEVEL: ["WORKOUT"],
  FOOD_CONSTRAINT: ["NUTRITION"],
  FOOD_EXCLUSION: ["NUTRITION"],
  PHYSICAL_CONSTRAINT: ["WORKOUT"],
  LOCATION: ["SESSION", "NUTRITION", "PROACTIVITY"],
  BEHAVIORAL_PREFERENCE: [],
};

export function impactsFor(changes: readonly FactChange[]): Set<FactImpactDomain> {
  return new Set(changes.flatMap((change) => FactImpactMap[change.factType]));
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}

function declared(type: OperationalFactType, canonicalValue: string, value: Record<string, unknown>, scope?: FactChange["scope"]): FactChange {
  return { factType: type, canonicalValue, value, source: "user_declared", confirmationStatus: "FACT_CONFIRMED", scope };
}

/**
 * A deliberately small deterministic resolver. Gemini still supplies the
 * language and the DecisionEnvelope; this resolver makes the mutation safe,
 * bounded and testable before the Fact Executor touches PostgreSQL.
 */
export function resolveDeclaredOperationalFacts(message: string): FactChange[] {
  const text = normalized(message);
  const changes: FactChange[] = [];
  const goal = /(?:objetivo (?:agora )?(?:e|eh)|quero focar em|agora quero)\s+(?:perder gordura|emagrecer|fat loss)/u.test(text)
    ? "fat_loss"
    : /(?:objetivo (?:agora )?(?:e|eh)|quero focar em|agora quero)\s+(?:hipertrofia|ganhar massa|muscle gain)/u.test(text)
      ? "hypertrophy"
      : null;
  if (goal) changes.push(declared("GOAL", goal, { code: goal }));

  const weight = /(?:peso|weigh|peso agora)\s*(?:e|eh|:)?\s*(\d{2,3}(?:[.,]\d{1,2})?)\s*kg/u.exec(text);
  if (weight) {
    const value = Number(weight[1]!.replace(",", "."));
    if (value >= 25 && value <= 500) changes.push(declared("BODY_WEIGHT", String(value), { weightKg: value }));
  }

  // Full-number capture (\d{1,2}) with a non-digit boundary: "25 vezes" must
  // be read as 25 (then rejected as out of domain), NEVER silently converted
  // to its last digit 5. Only the valid product domain 2..6 is emitted as a fact; an
  // out-of-domain frequency is not persisted (the model still handles it).
  const frequency = /(?:treino|treinar|train|allen[ao])\s*(\d{1,2})(?!\d)\s*(?:x|vez(?:es)?|days?|dias?)/u.exec(text);
  if (frequency) {
    const value = Number(frequency[1]);
    if (value >= 2 && value <= 6) changes.push(declared("TRAINING_FREQUENCY", frequency[1]!, { daysPerWeek: value }));
  }

  const level = /(?:sou |estou )?(iniciante|beginner|avancad[oa]|advanced|voltando|returning|ativo|active)/u.exec(text);
  if (level) {
    const mapping: Record<string, string> = { iniciante: "beginner", beginner: "beginner", avancado: "advanced", advanced: "advanced", voltando: "returning", returning: "returning", ativo: "active", active: "active" };
    const code = mapping[level[1]!] || level[1]!;
    changes.push(declared("EXPERIENCE_LEVEL", code, { code }));
  }

  if (/\b(vegetarian|vegetariano|vegetariana|vegano|vegana|vegan|sem gluten|gluten free|intoleran|alerg)/u.test(text)) {
    changes.push(declared("FOOD_CONSTRAINT", text, { declaration: message.trim() }));
  }
  if (/\b(nao como|nao consumo|non mangio|avoid|evito)\b/u.test(text)) {
    changes.push(declared("FOOD_EXCLUSION", text, { declaration: message.trim() }));
  }
  const region = /(joelho|knee|lombar|lower back|schiena bassa|ombro|shoulder|spalla|tornozelo|ankle|caviglia|punho|wrist|polso|coluna|neck|collo)/u.exec(text)?.[1];
  // Pain detection covers common inflections across PT/IT/EN (dor, dói, doendo,
  // doer, dolore, dolor, hurts, hurting, istighfare), so a literal "está doendo
  // minha lombar" enters the safety path just like "dor na lombar".
  if (region && /(do[ée]|doendo|doer|doendo|dolor|dolore|male|facendo male|fastidio|hurts?|hurt(ing)?|pain|istighfare|incomod|nao consigo|limita)\b/u.test(text)) {
    changes.push(declared("PHYSICAL_CONSTRAINT", region, { bodyRegion: region, declaration: message.trim() }));
  }
  const sessionLocation = /(hoje|today|oggi).{0,36}\b(casa|home|park|parque|gym|academia)\b/u.exec(text)?.[2];
  if (sessionLocation) changes.push(declared("LOCATION", sessionLocation, { location: sessionLocation }, "session"));
  if (/\b(prefiro|preferisco|i prefer)\b/u.test(text)) changes.push(declared("BEHAVIORAL_PREFERENCE", text, { declaration: message.trim() }));
  return changes;
}

/**
 * First Contact calibration correction interpreter.
 *
 * During First Contact, before a context is CONFIRMED, the user may correct
 * any objective calibration field used to build the ConfirmedUserContext
 * (age, sex, weight, height, experience, goal, training frequency) as well as
 * the food/limitation declarations. This deterministic interpreter turns a
 * natural-language sentence ("Na verdade estou com 75 kg.") into the same
 * profile/goal fields the calibration authority persists, so a correction is
 * applied to the DRAFT and never silently accepted as-is.
 */
export interface FirstContactCalibrationCorrection {
  biologicalSex?: "male" | "female";
  age?: number;
  weightKg?: number;
  heightCm?: number;
  trainingStatus?: "beginner" | "returning" | "active" | "advanced";
  weeklyFrequencyDaysPerWeek?: number;
  goalCode?: string;
  /** Set when the user stated a training frequency outside the valid domain
   * (2..6). The correction must be REJECTED (never persisted as a different
   * value), so the service throws a clear domain error instead of silently
   * dropping or corrupting the intent. */
  rejectedFrequency?: number;
}

export function interpretFirstContactCalibrationCorrection(message: string): FirstContactCalibrationCorrection {
  const text = normalized(message);
  const result: FirstContactCalibrationCorrection = {};

  if (/\bmasculino|sou homem|sou homem|male|sexo masculino\b/u.test(text)) result.biologicalSex = "male";
  else if (/\bfeminin[oa]|sou mulher|female|sexo feminino\b/u.test(text)) result.biologicalSex = "female";

  const age = /(\d{1,3})\s*anos?/u.exec(text)?.[1];
  if (age) {
    const value = Number(age);
    if (value >= 13 && value <= 120) result.age = value;
  }

  // Height first (cm suffix or metre decimal "1,81" without kg) so a height is
  // never misread as a weight in the metres range.
  const heightMetres = /(?:altura|height|statur)\D{0,14}(\d)[.,](\d{2})\s*(?:m|metros?|metri)?/u.exec(text);
  const heightCm = /(\d{3})\s*cm/u.exec(text)?.[1];
  if (heightCm) {
    const value = Number(heightCm);
    if (value >= 100 && value <= 250) result.heightCm = value;
  } else if (heightMetres) {
    const cm = Number(`${heightMetres[1]}${heightMetres[2]}`);
    if (cm >= 100 && cm <= 250) result.heightCm = cm;
  }

  const weight = /(\d{2,3}(?:[.,]\d{1,2})?)\s*kg/u.exec(text)?.[1];
  if (weight) {
    const value = Number(weight.replace(",", "."));
    if (value >= 25 && value <= 500) result.weightKg = value;
  }

  // Full-number capture with a non-digit boundary. The prefix is optional so
  // short phrases ("5 vezes") work, but "25 vezes" must be read as 25 — never
  // as its last digit 5. Values outside 2..6 are surfaced as rejectedFrequency
  // so the caller can reject with a clear domain error.
  const frequency = /(?:(?:treino|treinar|train|allenai)\D{0,16}?)?(\d{1,2})(?!\d)\s*(?:x|vez(?:es)?|days?\b|dias?\b)\s*(?:por semana|a settimana|per week|\/|)/u.exec(text);
  if (frequency) {
    const value = Number(frequency[1]);
    if (value >= 2 && value <= 6) result.weeklyFrequencyDaysPerWeek = value;
    else result.rejectedFrequency = value;
  }

  const experience = /(?:sou|estou|nivel|level|niveau)\D{0,14}?(?:na verdade\s*)?(iniciante|beginner|intermediari[oa]|intermediate|avancad[oa]|advanced|voltando|returning|ativo\b|active\b)/u.exec(text)?.[1];
  if (experience) {
    const mapping: Record<string, "beginner" | "returning" | "active" | "advanced"> = {
      iniciante: "beginner", beginner: "beginner",
      intermediario: "active", intermediaria: "active", intermediate: "active",
      avancado: "advanced", avancada: "advanced", advanced: "advanced",
      voltando: "returning", returning: "returning",
      ativo: "active", active: "active",
    };
    result.trainingStatus = mapping[experience] || "active";
  }

  if (/(?:ganhar massa|hipertrofia|muscle (?:gain|building)|foco em volume|crescer\b)/u.test(text)) result.goalCode = "muscle_gain";
  else if (/(?:perder gordura|emagrecer|fat loss|secar\b|recompor)/u.test(text)) result.goalCode = "fat_loss";
  else if (/(?:condicionamento|conditioning|resistencia aerobica)/u.test(text)) result.goalCode = "conditioning";
  else if (/(?:consistencia|consistency|regularidade)/u.test(text)) result.goalCode = "consistency";
  else if (/(?:mobilidade|mobility|flexibilidade)/u.test(text)) result.goalCode = "mobility_health";

  return result;
}

export function assertFactChange(change: FactChange): void {
  if (!OperationalFactTypes.includes(change.factType)) throw new V3Error("V3_FACT_TYPE_INVALID", "Tipo de fato operacional inválido.", 409);
  if (!change.canonicalValue.trim()) throw new V3Error("V3_FACT_VALUE_INVALID", "Valor de fato operacional inválido.", 409);
  if (!change.value || Array.isArray(change.value)) throw new V3Error("V3_FACT_VALUE_INVALID", "Estrutura de fato operacional inválida.", 409);
  if (change.factType === "TRAINING_FREQUENCY") {
    const daysPerWeek = Number(change.value.daysPerWeek);
    if (!Number.isInteger(daysPerWeek) || daysPerWeek < 2 || daysPerWeek > 6) {
      throw new V3Error("V3_TRAINING_FREQUENCY_OUT_OF_DOMAIN", "Frequência de treino fora do domínio válido (2 a 6).", 422);
    }
  }
}
