import assert from "node:assert/strict";
import test from "node:test";
import { currentFoodDeclaration, evolveFoodState, foodStateAssertions, renderFoodState } from "../src/v3/current-food-state.js";
import { filterFoodsByDeclaration } from "../src/v3/nutrition/restrictions.js";
import { resolveDeclaredOperationalFacts } from "../src/v3/facts.js";
import { OFFICIAL_FOOD_CATALOG } from "../src/v3/nutrition/catalog.js";
const eligible = (messages: string[]) => {
  const state = messages.reduce((state, message) => evolveFoodState(state, message), foodStateAssertions(""));
  return { state, ids: filterFoodsByDeclaration(OFFICIAL_FOOD_CATALOG, renderFoodState(state)).map(food => food.id) };
};

test("food facets preserve independent restrictions through bidirectional PT/IT changes", () => {
  for (const messages of [
    ["Não como ovos. Não como batata.", "Mangio uova normalmente."],
    ["Non mangio uova. Non mangio patata.", "Agora como ovos normalmente."],
  ]) {
    const result = eligible(messages);
    assert.ok(result.ids.includes("eggs"));
    assert.ok(!result.ids.includes("potato"));
    assert.ok(!eligible([...messages, "Não como ovos."]).ids.includes("eggs"));
    assert.ok(eligible([...messages, "Não como ovos. Agora como ovos."]).ids.includes("eggs"));
  }
});

test("diet pattern supersession does not erase independent allergies or food exclusions", () => {
  const messages = ["Tenho alergia a ovos. Não como batata. Sou vegetariano.", "Sono vegano.", "Agora sou vegetariano."];
  const {ids,state} = eligible(messages);
  assert.ok(ids.includes("yogurt"));
  for (const id of ["chicken", "tuna", "eggs", "potato"]) assert.ok(!ids.includes(id), id);
  assert.equal(state.filter(entry => entry.key === "diet_pattern").length, 1);
  assert.equal(state.find(entry => entry.key === "diet_pattern")?.term, "vegetarian");
  assert.ok(!eligible([...messages, "Como ovos normalmente."]).ids.includes("eggs"), "consumption cannot revoke allergy");
  assert.ok(eligible([...messages, "Não tenho alergia a ovos."]).ids.includes("eggs"), "explicit denial can supersede allergy");
});

test("explicit no-restrictions updates exclusions without erasing unresolved safety", () => {
  const {ids} = eligible(["Sou vegetariano. Não como batata. Tenho alergia a ovos.", "Non ho restrizioni alimentari."]);
  assert.ok(ids.includes("potato"));
  assert.ok(ids.includes("chicken"));
  assert.ok(!ids.includes("eggs"));
});

test("soy safety is a hard filter for the new plant protein, with opposite assertion", () => {
  assert.ok(!eligible(["Sou vegano. Tenho alergia a soja."]).ids.includes("tofu"));
  assert.ok(!eligible(["Sono vegano. Sono allergico alla soia."]).ids.includes("tofu"));
  assert.ok(eligible(["Não tenho alergia a soja."]).ids.includes("tofu"));
});

test("unknown restrictions preserve evidence; non-food state cannot contaminate nutrition", () => {
  const state = evolveFoodState([], "Tenho alergia a kiwi.", true);
  assert.match(renderFoodState(state), /kiwi/);
  for (const phrase of ["Estou sem tempo.", "Evito bike."]) assert.deepEqual(foodStateAssertions(phrase), [], phrase);
  assert.deepEqual(foodStateAssertions("Talvez eu seja vegano."), []);
  assert.deepEqual(foodStateAssertions("Mio fratello è vegano."), []);
  const declaration = currentFoodDeclaration({ confirmedContext: null, currentFacts: [
    { factType: "PHYSICAL_CONSTRAINT", canonicalValue: "Não como ovos.", value: {} },
  ] as any });
  assert.ok(filterFoodsByDeclaration(OFFICIAL_FOOD_CATALOG, declaration).some(food => food.id === "eggs"));
});

test("replay leaves one current value and preserves original facet provenance", () => {
  const initial = eligible(["Sou vegetariano. Não como batata."]).state;
  const once = evolveFoodState(initial, "Agora sou vegano.");
  assert.deepEqual(evolveFoodState(once, "Agora sou vegano."), once);
  assert.equal(once.find(entry => entry.key === "exclusion:food:potato")?.declaration, "nao como batata");
});

test("ordered reset and reassertion use the last event even inside one declaration", () => {
  assert.ok(!eligible(["Não como ovos. Não tenho restrições alimentares. Não como ovos."]).ids.includes("eggs"));
  assert.ok(eligible(["Não como ovos. Não tenho restrições alimentares."]).ids.includes("eggs"));
});

test("unsupported food declarations survive the actual operational input with provenance", () => {
  for (const declaration of ["Tenho alergia a kiwi.", "Ho allergia alle arachidi.", "Não como kiwi."]) {
    const changes = resolveDeclaredOperationalFacts(declaration);
    assert.ok(changes.some(change => change.factType === "FOOD_CONSTRAINT" && change.value.declaration === declaration));
    const state = evolveFoodState([], declaration);
    assert.ok(state.some(entry => entry.key.startsWith("opaque:") && entry.active));
    assert.equal(renderFoodState(evolveFoodState(state, "Agora sou vegetariano.")).includes("kiwi"), declaration.includes("kiwi"));
  }
});

test("fish exclusion never excludes poultry, in either priority language", () => {
  for (const declaration of ["Não como peixe.", "Non mangio pesce."]) {
    const {ids} = eligible([declaration]);
    assert.ok(!ids.includes("tuna"));
    assert.ok(ids.includes("chicken"));
  }
});
