import assert from "node:assert/strict";
import test from "node:test";
import {
  validateWindowsStorageSecurityReport,
  WindowsStorageSecurityError
} from "../src/agent/windows-storage-security.js";

const DIRECTORY = "C:\\ProgramData\\JB Expert QA";
const SERVICE_SID = "S-1-5-19";

function validReport(overrides = {}) {
  return {
    directory: DIRECTORY,
    processIdentitySid: SERVICE_SID,
    ownerSid: SERVICE_SID,
    daclProtected: true,
    accessEntries: [
      { sid: SERVICE_SID, type: "allow", access: "modify", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false },
      { sid: "S-1-5-18", type: "allow", access: "full-control", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false },
      { sid: "S-1-5-32-544", type: "allow", access: "full-control", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false }
    ],
    ...overrides
  };
}

function validate(report) {
  return validateWindowsStorageSecurityReport(report, {
    directory: DIRECTORY,
    expectedServiceSid: SERVICE_SID
  });
}

test("Windows storage attestation accepts the expected service owner and a protected minimal DACL", () => {
  assert.deepEqual(validate(validReport()), {
    identityVerified: true,
    ownerVerified: true,
    permissionsVerified: true,
    daclProtected: true
  });
});

test("Windows storage attestation rejects an unexpected directory or service identity", () => {
  assert.throws(
    () => validate(validReport({ directory: "C:\\ProgramData\\Other" })),
    error => error instanceof WindowsStorageSecurityError &&
      error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
  assert.throws(
    () => validate(validReport({ processIdentitySid: "S-1-5-20" })),
    error => error instanceof WindowsStorageSecurityError &&
      error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
  assert.throws(
    () => validate(validReport({ ownerSid: "S-1-5-18" })),
    error => error instanceof WindowsStorageSecurityError &&
      error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
});

test("Windows storage attestation rejects inherited, unprotected and deny ACEs", () => {
  assert.throws(
    () => validate(validReport({ daclProtected: false })),
    error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
  assert.throws(
    () => validate(validReport({
      accessEntries: [
        { sid: SERVICE_SID, type: "allow", access: "modify", inherited: true, containerInherit: true, objectInherit: true, inheritOnly: false }
      ]
    })),
    error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
  assert.throws(
    () => validate(validReport({
      accessEntries: [
        { sid: SERVICE_SID, type: "deny", access: "modify", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false }
      ]
    })),
    error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
});

test("Windows storage attestation rejects broad principals and unexpected ACEs", () => {
  for (const sid of ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]) {
    assert.throws(
      () => validate(validReport({
        accessEntries: [
          { sid: SERVICE_SID, type: "allow", access: "modify", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false },
          { sid, type: "allow", access: "full-control", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false }
        ]
      })),
      error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
    );
  }
  assert.throws(
    () => validate(validReport({
      accessEntries: [
        { sid: SERVICE_SID, type: "allow", access: "read", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false }
      ]
    })),
    error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
});

test("Windows storage attestation requires ACEs to apply to child files and directories", () => {
  assert.throws(
    () => validate(validReport({
      accessEntries: [
        { sid: SERVICE_SID, type: "allow", access: "modify", inherited: false, containerInherit: true, objectInherit: false, inheritOnly: false },
        { sid: "S-1-5-18", type: "allow", access: "full-control", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false },
        { sid: "S-1-5-32-544", type: "allow", access: "full-control", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false }
      ]
    })),
    error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
  assert.throws(
    () => validate(validReport({
      accessEntries: [
        { sid: SERVICE_SID, type: "allow", access: "modify", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: true },
        { sid: "S-1-5-18", type: "allow", access: "full-control", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false },
        { sid: "S-1-5-32-544", type: "allow", access: "full-control", inherited: false, containerInherit: true, objectInherit: true, inheritOnly: false }
      ]
    })),
    error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
});

test("Windows storage attestation rejects accessor-backed reports without invoking getters", () => {
  let invoked = false;
  const report = validReport();
  Object.defineProperty(report, "processIdentitySid", {
    enumerable: true,
    get() {
      invoked = true;
      return SERVICE_SID;
    }
  });
  assert.throws(
    () => validate(report),
    error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
  assert.equal(invoked, false);
});

test("Windows storage attestation requires a supported service identity and dense plain ACE arrays", () => {
  assert.throws(
    () => validateWindowsStorageSecurityReport(validReport(), {
      directory: DIRECTORY,
      expectedServiceSid: "S-1-5-18"
    }),
    error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
  const sparse = validReport({
    accessEntries: new Array(1)
  });
  assert.throws(() => validate(sparse), error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID");
});

test("Windows storage attestation rejects accessor-backed ACE slots without invoking getters", () => {
  let invoked = false;
  const entries = new Array(1);
  Object.defineProperty(entries, "0", {
    enumerable: true,
    get() {
      invoked = true;
      return { sid: SERVICE_SID, type: "allow", access: "modify", inherited: false };
    }
  });
  assert.throws(
    () => validate(validReport({ accessEntries: entries })),
    error => error.code === "WINDOWS_STORAGE_SECURITY_INVALID"
  );
  assert.equal(invoked, false);
});
