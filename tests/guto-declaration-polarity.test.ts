import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDietaryRestrictions, declarationExcludesFood } from "../src/v3/nutrition/restrictions.js";
import { OFFICIAL_FOOD_CATALOG } from "../src/v3/nutrition/catalog.js";
import { conflictsWithFoodDeclaration } from "../src/v3/food-declaration-policy.js";
import { resolveCuratedMemoryCandidates } from "../src/v3/beta1-memory.js";
import { resolveDeclaredOperationalFacts } from "../src/v3/facts.js";
import { interpretFoodDeclaration, interpretPhysicalDeclaration } from "../src/v3/declaration-semantics.js";

for (const declaration of [
  "Não tenho restrições alimentares. Como ovos e leite normalmente.",
  "Non ho restrizioni alimentari. Mangio uova e bevo latte normalmente.",
  "Não sou vegano nem vegetariano. Como carne e peixe.",
  "Non sono vegano né vegetariano. Mangio carne e pesce.",
  "Não tenho alergia a ovos nem intolerância à lactose.",
  "Não evito ovos nem leite.",
  "Non evito uova o latte.",
]) test(`positive consumption / absence is not an exclusion: ${declaration}`, () => {
  assert.deepEqual([...normalizeDietaryRestrictions(declaration)], []);
  for (const id of ["eggs", "chicken_breast", "tuna_canned"]) assert.equal(conflictsWithFoodDeclaration(id, declaration), false, id);
});

test("uncertainty, hypothetical and other-person statements cannot become user constraints", () => {
  for (const declaration of ["Talvez eu tenha dor no joelho.", "Forse ho dolore al ginocchio.",
    "Se eu sentir dor no joelho, aviso.", "Meu irmão tem dor no joelho.",
    "Não posso afirmar que sinto dor no joelho."]) {
    assert.equal(interpretPhysicalDeclaration(declaration).state, "UNKNOWN", declaration);
    assert.equal(resolveCuratedMemoryCandidates(declaration).filter(value => value.category === "TRAINING_LIMITATIONS").length, 0);
  }
  for (const declaration of ["Talvez eu seja vegetariano.", "Mio fratello è vegano.", "Se eu não comer ovos amanhã, tudo bem?"]) {
    assert.equal(interpretFoodDeclaration(declaration).state, "UNKNOWN", declaration);
  }
});

test("positive and negative body-region assertions have independent scopes", () => {
  const pt = interpretPhysicalDeclaration("Não sinto dor no joelho, mas meu ombro dói.");
  assert.deepEqual(pt.regions.map(({ bodyRegion, active }) => ({ bodyRegion, active })), [
    { bodyRegion: "knee", active: false }, { bodyRegion: "shoulder", active: true },
  ]);
  const it = interpretPhysicalDeclaration("Non ho dolore al ginocchio, ma ho dolore alla spalla.");
  assert.deepEqual(it.regions.map(({ bodyRegion, active }) => ({ bodyRegion, active })), pt.regions.map(({ bodyRegion, active }) => ({ bodyRegion, active })));
});

test("focus negation and negated cessation do not erase pain", () => {
  for (const declaration of ["Não só sinto dor no joelho, também estou cansado.",
    "Non solo ho dolore al ginocchio.", "Não deixei de sentir dor no joelho.",
    "Non ho smesso di sentire dolore al ginocchio."]) {
    assert.equal(interpretPhysicalDeclaration(declaration).state, "PRESENT", declaration);
  }
  for (const declaration of ["Deixei de sentir dor no joelho.", "Ho smesso di sentire dolore al ginocchio."]) {
    assert.equal(interpretPhysicalDeclaration(declaration).state, "ABSENT", declaration);
  }
});

for (const [declaration, expected] of [
  ["Não como ovos. Bebo leite normalmente.", ["no_egg"]],
  ["Non mangio uova. Bevo latte normalmente.", ["no_egg"]],
  ["Como ovos, mas não consumo leite.", ["lactose_free"]],
  ["Mangio uova, ma non consumo latte.", ["lactose_free"]],
  ["Sou vegetariana.", ["no_meat", "no_fish"]],
  ["Sono vegetariana.", ["no_meat", "no_fish"]],
  ["Sou vegana.", ["lactose_free", "no_egg", "no_meat", "no_fish"]],
  ["Sono vegana.", ["lactose_free", "no_egg", "no_meat", "no_fish"]],
] as const) test(`restriction keeps its own scope: ${declaration}`, () => {
  assert.deepEqual([...normalizeDietaryRestrictions(declaration)].sort(), [...expected].sort());
});

test("an exclusion in one clause cannot exclude food positively consumed in another", () => {
  const rice = OFFICIAL_FOOD_CATALOG.find(food => food.id === "rice")!;
  assert.equal(declarationExcludesFood(rice, "Não como banana. Como arroz normalmente."), false);
  assert.equal(declarationExcludesFood(rice, "Non mangio banana. Mangio riso normalmente."), false);
  assert.equal(declarationExcludesFood(rice, "Não como arroz."), true);
  assert.equal(declarationExcludesFood(rice, "Non mangio riso."), true);
});

for (const declaration of ["Não gosto de bike.", "Non mi piace la bicicletta."]) test(`dislike cannot create like or food restriction: ${declaration}`, () => {
  const candidates = resolveCuratedMemoryCandidates(declaration);
  const cardio = candidates.find(value => value.category === "TRAINING_PREFERENCES");
  assert.deepEqual(cardio?.value.disliked, ["bike"]);
  assert.ok(!cardio?.value.liked);
  assert.ok(!candidates.some(value => value.category === "FOOD_PREFERENCES"));
});

for (const [absent, present] of [
  ["Não sinto dor no joelho.", "Sinto dor no joelho."],
  ["Non ho dolore al ginocchio.", "Ho dolore al ginocchio."],
]) test(`pain polarity is symmetric: ${absent}`, () => {
  assert.ok(!resolveDeclaredOperationalFacts(absent).some(fact => fact.factType === "PHYSICAL_CONSTRAINT" && fact.value.active !== false));
  assert.ok(!resolveCuratedMemoryCandidates(absent).some(fact => fact.category === "TRAINING_LIMITATIONS" && fact.value.active !== false));
  assert.ok(resolveDeclaredOperationalFacts(present).some(fact => fact.factType === "PHYSICAL_CONSTRAINT" && fact.value.active !== false));
  assert.ok(resolveCuratedMemoryCandidates(present).some(fact => fact.category === "TRAINING_LIMITATIONS" && fact.value.active !== false));
});
