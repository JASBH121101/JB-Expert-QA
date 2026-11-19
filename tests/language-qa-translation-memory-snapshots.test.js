import test from "node:test";
import assert from "node:assert/strict";
import {
  TranslationMemory,
  fingerprintTranslationMemoryEntry,
  recordTranslationReview
} from "../src/language/index.js";

function makeApprovedEntry() {
  const input = {
    source: "Save changes",
    target: "Guardar cambios",
    sourceLocale: "en-US",
    targetLocale: "es-NI",
    context: "settings.action"
  };
  const hashes = fingerprintTranslationMemoryEntry(input);
  const review = recordTranslationReview({
    state: "approved",
    reviewer: "qa-reviewer",
    reviewedAt: "2026-11-19T10:00:00.000Z",
    ...hashes
  });
  return { ...input, review };
}

test("Translation Memory snapshots round-trip pending, approved and stale entries", () => {
  const original = new TranslationMemory();
  original.add({
    source: "Sign in", target: "Iniciar sesión",
    sourceLocale: "en", targetLocale: "es"
  });
  original.add(makeApprovedEntry());
  original.markStale({
    source: "Sign in", sourceLocale: "en-US", targetLocale: "es-NI"
  });

  const snapshot = original.exportSnapshot();
  const restored = new TranslationMemory();
  const result = restored.importSnapshot(JSON.parse(JSON.stringify(snapshot)));

  assert.deepEqual(result, { schemaVersion: 1, imported: 2, total: 2, replaced: false });
  assert.deepEqual(restored.exportSnapshot(), snapshot);
  assert.equal(restored.list().find(item => item.status === "approved").reviewer, "qa-reviewer");
});

test("Translation Memory import rejects tampered fingerprints atomically", () => {
  const memory = new TranslationMemory();
  memory.add({ source: "Open", target: "Abrir", sourceLocale: "en", targetLocale: "es" });
  const before = memory.exportSnapshot();
  const other = new TranslationMemory();
  other.add({ source: "Close", target: "Cerrar", sourceLocale: "en", targetLocale: "es" });
  const tampered = structuredClone(other.exportSnapshot());
  tampered.entries[0].targetHash = "0".repeat(64);

  assert.throws(() => memory.importSnapshot(tampered), /fingerprints|exact source/);
  assert.deepEqual(memory.exportSnapshot(), before);
});

test("Translation Memory import rejects conflicting entries unless replacement is explicit", () => {
  const memory = new TranslationMemory();
  memory.add({ source: "Save", target: "Guardar", sourceLocale: "en", targetLocale: "es" });
  const incoming = new TranslationMemory();
  incoming.add({ source: "Save", target: "Almacenar", sourceLocale: "en", targetLocale: "es" });

  assert.throws(() => memory.importSnapshot(incoming.exportSnapshot()), /conflicts/);
  const result = memory.importSnapshot(incoming.exportSnapshot(), { replace: true });
  assert.equal(result.replaced, true);
  assert.equal(memory.findExact({ source: "Save", sourceLocale: "en", targetLocale: "es" }).target, "Almacenar");
});

test("Translation Memory import rejects invalid schemas, duplicate keys and accessor records", () => {
  const memory = new TranslationMemory();
  assert.throws(() => memory.importSnapshot({ schemaVersion: 2, entries: [] }), /Unsupported/);
  const duplicateSource = {
    source: "Save", target: "Guardar", sourceLocale: "en", targetLocale: "es"
  };
  const staged = new TranslationMemory();
  staged.add(duplicateSource);
  const single = staged.exportSnapshot().entries[0];
  const duplicateSnapshot = { schemaVersion: 1, entries: [single, single] };
  assert.throws(() => memory.importSnapshot(duplicateSnapshot), /duplicate keys/);

  let getterCalled = false;
  const unsafe = { schemaVersion: 1, entries: [] };
  Object.defineProperty(unsafe, "entries", {
    enumerable: true,
    get() { getterCalled = true; return []; }
  });
  assert.throws(() => memory.importSnapshot(unsafe), /accessor properties/);
  assert.equal(getterCalled, false);
});
