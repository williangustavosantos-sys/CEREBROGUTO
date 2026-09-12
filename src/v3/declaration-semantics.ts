/**
 * Shared interpretation of explicit propositions, before domain policy.
 * A mention is not an assertion. Operators have a scope and a polarity;
 * consumers must not rediscover them by searching the complete declaration.
 * Unknown language remains unknown rather than becoming a fabricated fact.
 */
export type AssertionState = "PRESENT" | "ABSENT" | "UNKNOWN";
type Operator<T> = readonly [RegExp, T];

export function normalizeDeclaration(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export function declarationClauses(message: string): string[] {
  return normalizeDeclaration(message).split(
    /[.;!?\n]+|,?\s+\b(?:mas|porem|ma|pero|but|however)\b\s+|,?\s+\b(?:e|and)\b\s+(?=(?:(?:eu|io|i)\s+)?(?:nao|non|como|consumo|mangio|bevo|bebo|sinto|tenho|ho|prefiro|preferisco|gosto|mi piace)\b)/u,
  ).map(value => value.trim()).filter(Boolean);
}

/** Modality and attribution precede polarity: a hypothesis is not a fact. */
export function isDirectDeclaration(clause: string): boolean {
  return !/\b(?:talvez|forse|maybe|se|if|nao sei|non so|nao posso afirmar|non posso affermare|meu irmao|minha irma|meu amigo|minha amiga|mio fratello|mia sorella|my brother|my friend)\b/u.test(clause);
}

/** Longest overlapping operator wins ("não gosto" contains "gosto"). */
function scopedOperator<T>(text: string, position: number, operators: readonly Operator<T>[]): T | undefined {
  const matches = operators.flatMap(([pattern, value]) => [...text.matchAll(new RegExp(pattern.source, "gu"))]
    .map(match => ({ start: match.index, end: match.index + match[0].length, value })));
  const independent = matches.filter(match => !matches.some(other =>
    other !== match && other.start <= match.start && other.end >= match.end && other.end - other.start > match.end - match.start));
  return independent.filter(match => match.start <= position).sort((a, b) => b.start - a.start)[0]?.value;
}

const FOOD_OPERATORS: readonly Operator<boolean>[] = [
  [/\b(?:nao|non|do not|don't)\s+(?:evito|evitar|avoid|excluo)\b/u, false],
  [/\b(?:nem|ne|nor)\s+(?:alerg\w*|allerg\w*|intoler\w*)/u, false],
  [/\b(?:nao|non)\s+(?:tenho|ho|sou|sono|soffro di)\s+(?:nenhuma?\s+)?(?:alerg\w*|allerg\w*|intoler\w*)/u, false],
  [/\b(?:nao|non|do not|don't)\s+(?:como|consumo|posso comer|posso consumir|mangio|mangiare|posso mangiare|eat|consume|tollero)\b/u, true],
  [/\b(?:nao gosto de|non mi piace|non mi piacciono|odeio|detesto|evito|evitar|avoid|exclude|excluo|sem|senza|without|alerg\w*|allerg\w*|intoler\w*)\b/u, true],
  [/\b(?:como|consumo|mangio|bevo|bebo|eat|drink|tollero|gosto de|mi piace|mi piacciono)\b/u, false],
];

export function foodTermExcluded(clause: string, term: RegExp): boolean | undefined {
  if (!isDirectDeclaration(clause)) return undefined;
  const match = term.exec(clause);
  if (!match) return undefined;
  return scopedOperator(clause, match.index, FOOD_OPERATORS);
}

export function literalTerm(value: string): RegExp {
  return new RegExp(`\\b${normalizeDeclaration(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "u");
}

export function namedFoodExcluded(declaration: string, names: readonly string[]): boolean {
  let excluded = false;
  for (const clause of declarationClauses(declaration)) {
    if (!isDirectDeclaration(clause)) continue;
    for (const name of names.filter(name => name.length >= 3)) {
      const stance = foodTermExcluded(clause, literalTerm(name));
      if (stance !== undefined) excluded = stance;
    }
  }
  return excluded;
}

export type FoodRestriction = "gluten_free" | "lactose_free" | "no_egg" | "no_meat" | "no_fish" | "soy_free";
export const FOOD_GROUPS: readonly (readonly [FoodRestriction, RegExp])[] = [
  ["soy_free", /\b(?:soja|soia|soy|soybean)\b/u],
  ["gluten_free", /\b(?:gluten|glutine)\b/u],
  ["lactose_free", /\b(?:lactose|lattosio|leite|latte|milk|dairy)\b/u],
  ["no_egg", /\b(?:ovo|ovos|egg|eggs|uovo|uova)\b/u],
  ["no_meat", /\b(?:carne|meat|frango|pollo|chicken|turkey|peru)\b/u],
  ["no_fish", /\b(?:peixe|peixes|fish|pesce|atum|tuna|tonno)\b/u],
];

export function labelAffirmed(clause: string, pattern: RegExp): boolean | undefined {
  const match = pattern.exec(clause);
  if (!match) return undefined;
  const before = clause.slice(0, match.index);
  if (/\b(?:talvez|forse|maybe|se|if)\b/u.test(before)) return undefined;
  return !negatesAssertion(before);
}

export function interpretFoodDeclaration(declaration: string): { state: AssertionState; restrictions: Set<FoodRestriction> } {
  const restrictions = new Set<FoodRestriction>();
  let recognized = false;
  for (const clause of declarationClauses(declaration)) {
    if (!isDirectDeclaration(clause)) continue;
    if (/\b(?:sem restrico|nenhuma restricao|nao tenho restrico|nessuna restrizione|non ho restrizioni|no restrictions|none)\w*/u.test(clause)) recognized = true;
    const vegan = labelAffirmed(clause, /\bvegan[oa]?\b/u);
    const vegetarian = labelAffirmed(clause, /\bvegetarian[oa]?\b/u);
    if (vegan !== undefined || vegetarian !== undefined) recognized = true;
    if (vegan) { restrictions.add("lactose_free"); restrictions.add("no_egg"); restrictions.add("no_meat"); restrictions.add("no_fish"); }
    if (vegetarian) { restrictions.add("no_meat"); restrictions.add("no_fish"); }
    for (const [key, pattern] of FOOD_GROUPS) {
      const excluded = foodTermExcluded(clause, pattern);
      if (excluded !== undefined) {
        recognized = true;
        if (excluded) restrictions.add(key);
        else if (!vegan && !vegetarian) restrictions.delete(key);
      }
    }
    if (labelAffirmed(clause, /\b(?:celiac[oa]?|celiachia|celiac disease)\b/u)) restrictions.add("gluten_free");
  }
  return { state: restrictions.size ? "PRESENT" : recognized ? "ABSENT" : "UNKNOWN", restrictions };
}

export const BODY_REGION_TERMS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:joelho|knee|ginocchi\w*)\b/u, "knee"],
  [/\b(?:lombar|lower back|schiena bassa|lombare)\b/u, "lower_back"],
  [/\b(?:ombro|shoulder|spalla|spalle)\b/u, "shoulder"],
  [/\b(?:tornozelo|ankle|caviglia)\b/u, "ankle"],
  [/\b(?:punho|wrist|polso)\b/u, "wrist"],
  [/\b(?:coluna|spine|neck|pescoco|collo)\b/u, "spine"],
  [/\b(?:quadril|hip|anca)\b/u, "hip"],
  [/\b(?:cotovelo|elbow|gomito)\b/u, "elbow"],
];
const PHYSICAL_SIGNAL = /\b(?:dor|dores|doi|doendo|doer|dolore|dolori|male|fastidio|pain|hurts?|hurting|incomod\w*|lesao|lesion\w*|limita\w*|patologia|condicao)\b/u;
const PHYSICAL_ABSENCE = /\b(?:nao|non|not|no|sem|senza|nenhuma?|nessun[oa]?)\b/u;

function negatesAssertion(prefix: string): boolean {
  // Focus operators are affirmative ("não só..."). Negative concord
  // ("não tenho nenhuma...") is one negation; negated cessation is two.
  const scope = prefix.replace(/\b(?:nao so|non solo|not only)\b/gu, "");
  const negative = PHYSICAL_ABSENCE.test(scope);
  const cessation = /\b(?:deixei de|parei de|smesso di|cessato di|stopped)\b/u.test(scope);
  return negative !== cessation;
}

export function interpretPhysicalDeclaration(declaration: string): {
  state: AssertionState; regions: Array<{ bodyRegion: string; active: boolean; declaration: string }>;
} {
  const regions = new Map<string, { bodyRegion: string; active: boolean; declaration: string }>();
  let present = false, absent = false;
  for (const clause of declarationClauses(declaration)) {
    if (!isDirectDeclaration(clause)) continue;
    const signal = PHYSICAL_SIGNAL.exec(clause);
    const restricted = /\b(?:nao posso|nao consigo|nao devo|evito|evitar|non posso|non riesco|devo evitare|cannot)\b/u.test(clause);
    if (!signal && !restricted) continue;
    const prefix = signal ? clause.slice(0, signal.index) : clause;
    const active = restricted || !negatesAssertion(prefix);
    if (active) present = true; else absent = true;
    for (const [term, bodyRegion] of BODY_REGION_TERMS) if (term.test(clause)) regions.set(bodyRegion, { bodyRegion, active, declaration: clause });
  }
  return { state: present ? "PRESENT" : absent ? "ABSENT" : "UNKNOWN", regions: [...regions.values()] };
}

/** Keep absence as known data; never feed its body-region words to safety. */
export function activePhysicalDeclaration(declaration: string): string {
  return declarationClauses(declaration)
    .filter(clause => interpretPhysicalDeclaration(clause).state !== "ABSENT")
    .join(". ");
}

const PREFERENCE_OPERATORS: readonly Operator<"like" | "dislike" | "prefer">[] = [
  [/\b(?:nao gosto de|nao curto|nao quero|non mi piace|non mi piacciono|non voglio|odeio|detesto|evito|dislike|hate)\b/u, "dislike"],
  [/\b(?:gosto de|curto|amo|adoro|comecei a gostar de|mi piace|mi piacciono|adoro|like|love)\b/u, "like"],
  [/\b(?:prefiro|preferisco|prefer)\b/u, "prefer"],
];

export function preferenceStance(clause: string, entity: RegExp): "like" | "dislike" | "prefer" | undefined {
  if (!isDirectDeclaration(clause)) return undefined;
  const match = entity.exec(clause);
  return match ? scopedOperator(clause, match.index, PREFERENCE_OPERATORS) : undefined;
}
