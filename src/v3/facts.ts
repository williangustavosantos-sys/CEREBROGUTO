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

  const frequency = /(?:treino|train|allen[ao])\s*(\d)\s*(?:x|vez(?:es)?|days?|dias?)/u.exec(text);
  if (frequency) changes.push(declared("TRAINING_FREQUENCY", frequency[1]!, { daysPerWeek: Number(frequency[1]) }));

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
  const region = /(joelho|knee|lombar|lower back|schiena bassa|ombro|shoulder|spalla|tornozelo|ankle|caviglia)/u.exec(text)?.[1];
  if (region && /(dor|incomod|nao consigo|limita|pain|fastidio)/u.test(text)) {
    changes.push(declared("PHYSICAL_CONSTRAINT", region, { bodyRegion: region, declaration: message.trim() }));
  }
  const sessionLocation = /(hoje|today|oggi).{0,36}\b(casa|home|park|parque|gym|academia)\b/u.exec(text)?.[2];
  if (sessionLocation) changes.push(declared("LOCATION", sessionLocation, { location: sessionLocation }, "session"));
  if (/\b(prefiro|preferisco|i prefer)\b/u.test(text)) changes.push(declared("BEHAVIORAL_PREFERENCE", text, { declaration: message.trim() }));
  return changes;
}

export function assertFactChange(change: FactChange): void {
  if (!OperationalFactTypes.includes(change.factType)) throw new V3Error("V3_FACT_TYPE_INVALID", "Tipo de fato operacional inválido.", 409);
  if (!change.canonicalValue.trim()) throw new V3Error("V3_FACT_VALUE_INVALID", "Valor de fato operacional inválido.", 409);
  if (!change.value || Array.isArray(change.value)) throw new V3Error("V3_FACT_VALUE_INVALID", "Estrutura de fato operacional inválida.", 409);
}
