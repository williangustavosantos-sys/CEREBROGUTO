import { OFFICIAL_FOOD_CATALOG } from "./nutrition/catalog.js";
import { declarationClauses, FOOD_GROUPS, foodTermExcluded, isDirectDeclaration, labelAffirmed, literalTerm } from "./declaration-semantics.js";
import { V3Error } from "./errors.js";
import type { FactChange } from "./facts.js";
import type { OfficialSnapshot } from "./types.js";

/** Current assertions, not a growing transcript. Independent safety declarations
 * survive a dietary preference change. The aggregate revision lives in the
 * existing fact ledger; each retained facet keeps its declaration provenance. */
export interface FoodStateEntry {
  key: string;
  active: boolean;
  term: string;
  declaration: string;
}
export type CurrentFoodState = FoodStateEntry[];
const groupTerms: Record<string, string> = {
  gluten_free: "gluten", lactose_free: "lactose", no_egg: "eggs", no_meat: "meat", no_fish: "fish", soy_free: "soy",
};

export function foodStateAssertions(message: string, preserveUnknown = true): CurrentFoodState {
  const entries: CurrentFoodState = [];
  let assertionCount = 0;
  const put = (key: string, active: boolean, term: string, declaration: string) => {
    assertionCount++;
    entries.push({ key, active, term, declaration });
  };
  for (const clause of declarationClauses(message)) {
    if (!isDirectDeclaration(clause)) continue;
    const beforeCount = assertionCount;
    if (/\b(?:sem restrico|nenhuma restricao|nao tenho restrico|nessuna restrizione|non ho restrizioni|no restrictions)\w*/u.test(clause)) {
      put("exclusions_reset", false, "", clause);
    }
    const vegan = labelAffirmed(clause, /\bvegan[oa]?\b/u);
    const vegetarian = labelAffirmed(clause, /\bvegetarian[oa]?\b/u);
    const omnivore = labelAffirmed(clause, /\b(?:onivor[oa]|onnivor[oa]|omnivore)\b/u);
    if (vegan !== undefined) put("diet_pattern", vegan, "vegan", clause);
    if (vegetarian !== undefined) put("diet_pattern", vegetarian, "vegetarian", clause);
    if (omnivore) put("diet_pattern", false, "omnivore", clause);
    // Safety has separate identity. "I eat eggs" cannot silently revoke an
    // allergy; an explicit denial/resolution of that allergy can supersede it.
    const kind = /\b(?:alerg\w*|allerg\w*|intoler\w*|celiac\w*|celiachia)\b/u.test(clause) ? "safety" : "exclusion";
    for (const [key, term] of FOOD_GROUPS) {
      const stance = foodTermExcluded(clause, term);
      if (stance !== undefined) put(`${kind}:group:${key}`, stance, groupTerms[key]!, clause);
    }
    const celiac = labelAffirmed(clause, /\b(?:celiac[oa]?|celiachia|celiac disease)\b/u);
    if (celiac !== undefined) put("safety:group:gluten_free", celiac, "gluten", clause);
    for (const food of OFFICIAL_FOOD_CATALOG) {
      for (const name of [food.id, food.canonicalName, ...food.aliases]) {
        const stance = foodTermExcluded(clause, literalTerm(name));
        if (stance !== undefined) put(`${kind}:food:${food.id}`, stance, food.canonicalName, clause);
      }
    }
    // Preserve unsupported restrictions as opaque evidence. A partial parser
    // must never turn unrecognized safety text into "no restrictions".
    if (preserveUnknown && assertionCount === beforeCount && /\b(?:alerg\w*|allerg\w*|intolerancia|intolleranza|nao como|nao consumo|non mangio|non consumo|do not eat)\b/u.test(clause)) {
      put(`opaque:${clause}`, true, clause, clause);
    }
  }
  return entries;
}

export function evolveFoodState(previous: CurrentFoodState, declaration: string, preserveUnknown = true): CurrentFoodState {
  const state = new Map(previous.map(entry => [entry.key, entry]));
  for (const entry of foodStateAssertions(declaration, preserveUnknown)) {
    if (entry.key === "exclusions_reset") {
      for (const [key, previous] of state) if (key.startsWith("exclusion:") || key === "diet_pattern") state.set(key, { ...previous, active: false, declaration: entry.declaration });
      continue;
    }
    // Negating one label does not invent another or erase a different mode.
    if (entry.key === "diet_pattern" && !entry.active && entry.term !== "omnivore" && state.get(entry.key)?.term !== entry.term) continue;
    state.set(entry.key, entry);
  }
  return [...state.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function renderFoodState(state: CurrentFoodState): string {
  return state.filter(entry => entry.active).map(entry => entry.key === "diet_pattern"
    ? entry.term
    : entry.key.startsWith("opaque:") ? entry.declaration
    : `${entry.key.startsWith("safety:") ? "allergy" : "avoid"} ${entry.term}`).join(". ") || "No restrictions.";
}

export function isFoodFact(type: string): boolean {
  return ["FOOD_RESTRICTION", "FOOD_CONSTRAINT", "FOOD_EXCLUSION"].includes(type.toUpperCase());
}

/** All consumers use only food facts, never arbitrary conversation values. */
export function currentFoodDeclaration(snapshot: Pick<OfficialSnapshot, "confirmedContext" | "currentFacts">): string {
  const aggregate = snapshot.currentFacts?.find(fact => isFoodFact(fact.factType) && Array.isArray(fact.value.foodState));
  if (aggregate) return renderFoodState(aggregate.value.foodState as CurrentFoodState);
  // Compatibility for an existing context before its first stateful revision.
  let state = evolveFoodState([], snapshot.confirmedContext?.foodDeclaration || "", true);
  for (const fact of snapshot.currentFacts || []) if (isFoodFact(fact.factType)) {
    state = evolveFoodState(state, String(fact.value.declaration || fact.canonicalValue), true);
  }
  return renderFoodState(state);
}

export function foodStateChange(previous: CurrentFoodState, change: FactChange): FactChange {
  const declaration = String(change.value.declaration || change.canonicalValue);
  if (!foodStateAssertions(declaration).length) throw new V3Error("V3_FOOD_DECLARATION_CLARIFICATION_REQUIRED", "Preciso entender qual informação alimentar mudou.", 409);
  const foodState = evolveFoodState(previous, declaration);
  return { ...change, factType: "FOOD_CONSTRAINT", canonicalValue: renderFoodState(foodState), value: {
    declaration: renderFoodState(foodState), sourceDeclaration: declaration, foodState,
    assertionState: foodState.some(entry => entry.active) ? "PRESENT" : "ABSENT",
  } };
}
