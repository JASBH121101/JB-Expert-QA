import test from "node:test";
import assert from "node:assert/strict";
import { parseFragranceCustomerMessage } from "../src/domains/fragrance/intent.js";

test("understands a soft, non-hostigoso daily request in Spanish", () => {
  const result = parseFragranceCustomerMessage("Busco un perfume suave y que no sea hostigoso para el día a día.");
  assert.equal(result.preferences.occasion, "day");
  assert.equal(result.preferences.intensity, "soft");
  assert.equal(result.preferences.projection, "close");
  assert.equal(result.needsClarification, false);
});

test("understands an intense night-time request", () => {
  const result = parseFragranceCustomerMessage("Quiero algo intenso para usar de noche.");
  assert.equal(result.preferences.occasion, "evening");
  assert.equal(result.preferences.intensity, "strong");
  assert.equal(result.preferences.projection, "strong");
});

test("normalizes Spanish accents when identifying daily and warm-weather preferences", () => {
  const result = parseFragranceCustomerMessage("Algo fresco para el día a día en clima húmedo y caluroso.");
  assert.equal(result.preferences.occasion, "day");
  assert.equal(result.preferences.climate, "hot_humid");
  assert.deepEqual(result.preferences.preferredCharacters, ["fresh", "clean"]);
});

test("maps explicit citrus and floral wording to normalized fragrance families", () => {
  const result = parseFragranceCustomerMessage("Me gustan los aromas cítricos y florales.");
  assert.deepEqual(result.preferences.preferredFamilies, ["citrus", "floral"]);
});

test("detects an explicit long-lasting request without fabricating a duration", () => {
  const result = parseFragranceCustomerMessage("Quiero que dure bastante.");
  assert.equal(result.preferences.performancePriority, "long_lasting");
  assert.equal(result.preferences.longevityHours, undefined);
});

test("asks for clarification when no supported preference is stated", () => {
  const result = parseFragranceCustomerMessage("Quiero algo especial.");
  assert.equal(result.needsClarification, true);
  assert.deepEqual(result.preferences, {});
});

test("does not resolve contradictory intensity requests by guessing", () => {
  const result = parseFragranceCustomerMessage("Quiero algo suave pero muy fuerte e intenso.");
  assert.equal(result.preferences.intensity, undefined);
  assert.equal(result.preferences.projection, undefined);
});
