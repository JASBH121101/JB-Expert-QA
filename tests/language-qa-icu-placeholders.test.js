import test from "node:test";
import assert from "node:assert/strict";
import { extractPlaceholders, comparePlaceholders } from "../src/language/placeholders.js";

test("extracts simple, Laravel, mustache, printf and ICU argument placeholders", () => {
  assert.deepEqual(
    extractPlaceholders("Hello :name {{ user }} {count} %2$s {amount, number}"),
    ["%2$s", ":name", "{amount,number}", "{count}", "{{user}}"]
  );
});

test("compares ICU argument names and format types independent of message order", () => {
  const source = "{count, plural, one {# item} other {# items}} for {name}";
  const target = "Para {name}: {count, plural, one {# artículo} other {# artículos}}";
  assert.equal(comparePlaceholders(source, target).matches, true);
  assert.equal(comparePlaceholders("{amount, number}", "{amount, date}").matches, false);
  assert.deepEqual(
    comparePlaceholders("{count, plural, one {# item} other {# items}}", "{count}").missing,
    ["{count,plural}"]
  );
});

test("preserves duplicate counts for ICU and positional placeholders", () => {
  const mismatch = comparePlaceholders("{count, number} {count, number} %2$s", "{count, number} %s");
  assert.equal(mismatch.matches, false);
  assert.deepEqual(mismatch.missing, ["%2$s", "{count,number}"]);
  assert.deepEqual(mismatch.unexpected, ["%s"]);
});

test("does not interpret ICU branch names or ordinary braces as arguments", () => {
  assert.deepEqual(
    extractPlaceholders("{gender, select, male {He} female {She} other {They}}"),
    ["{gender,select}"]
  );
  assert.deepEqual(extractPlaceholders("A CSS block { color: red }"), []);
});
