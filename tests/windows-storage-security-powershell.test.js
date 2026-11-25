import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createWindowsPowerShellStorageSecurityVerifier,
  WindowsPowerShellStorageVerifierError
} from "../src/agent/windows-storage-security-powershell.js";

test("Windows PowerShell verifier validates bounded timeout configuration", () => {
  assert.throws(
    () => createWindowsPowerShellStorageSecurityVerifier({ timeoutMs: 999 }),
    error => error instanceof WindowsPowerShellStorageVerifierError &&
      error.code === "WINDOWS_STORAGE_VERIFIER_INVALID"
  );
  assert.throws(
    () => createWindowsPowerShellStorageSecurityVerifier({ timeoutMs: 16000 }),
    error => error instanceof WindowsPowerShellStorageVerifierError &&
      error.code === "WINDOWS_STORAGE_VERIFIER_INVALID"
  );
});

test("Windows PowerShell verifier rejects accessor-backed options without invoking getters", () => {
  let invoked = false;
  const options = {};
  Object.defineProperty(options, "timeoutMs", {
    enumerable: true,
    get() {
      invoked = true;
      return 5000;
    }
  });
  assert.throws(
    () => createWindowsPowerShellStorageSecurityVerifier(options),
    error => error instanceof WindowsPowerShellStorageVerifierError &&
      error.code === "WINDOWS_STORAGE_VERIFIER_INVALID"
  );
  assert.equal(invoked, false);
});

test("Windows PowerShell verifier is unavailable on non-Windows runtimes", () => {
  if (process.platform === "win32") return;
  assert.throws(
    () => createWindowsPowerShellStorageSecurityVerifier(),
    error => error instanceof WindowsPowerShellStorageVerifierError &&
      error.code === "WINDOWS_ONLY"
  );
});

test("native Windows verifier reads the process token, directory owner and complete NTFS DACL without mutation", {
  skip: process.platform !== "win32"
}, async t => {
  const directory = resolve(await mkdtemp(join(tmpdir(), "jbqa-native-storage-verifier-")));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const verify = createWindowsPowerShellStorageSecurityVerifier({ timeoutMs: 10000 });
  const request = {
    directory,
    expectedServiceSid: "S-1-5-19"
  };
  const first = verify(request);

  assert.equal(first.directory, directory);
  assert.match(first.processIdentitySid, /^S-1-[0-9]+(?:-[0-9]+)+$/u);
  assert.match(first.ownerSid, /^S-1-[0-9]+(?:-[0-9]+)+$/u);
  assert.equal(typeof first.daclProtected, "boolean");
  assert.ok(Array.isArray(first.accessEntries));
  assert.ok(first.accessEntries.length <= 64);
  for (const entry of first.accessEntries) {
    assert.deepEqual(Object.keys(entry).sort(), ["access", "inherited", "sid", "type"]);
    assert.match(entry.sid, /^S-1-[0-9]+(?:-[0-9]+)+$/u);
    assert.ok(["allow", "deny"].includes(entry.type));
    assert.ok(["modify", "full-control", "unsupported"].includes(entry.access));
    assert.equal(typeof entry.inherited, "boolean");
  }

  const second = verify(request);
  assert.deepEqual(second, first, "repeat inspection must return the same read-only token and ACL evidence");
});

test("native Windows verifier rejects a request containing accessor-backed data", {
  skip: process.platform !== "win32"
}, () => {
  const verify = createWindowsPowerShellStorageSecurityVerifier();
  let invoked = false;
  const request = { directory: "C:\\ProgramData\\JBQA", expectedServiceSid: "S-1-5-19" };
  Object.defineProperty(request, "directory", {
    enumerable: true,
    get() {
      invoked = true;
      return "C:\\ProgramData\\JBQA";
    }
  });
  assert.throws(
    () => verify(request),
    error => error instanceof WindowsPowerShellStorageVerifierError &&
      error.code === "WINDOWS_STORAGE_VERIFIER_INVALID"
  );
  assert.equal(invoked, false);
});
