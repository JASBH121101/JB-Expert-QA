import assert from "node:assert/strict";
import test from "node:test";
import {
  readWindowsStorageSecurityReport,
  WindowsStorageSecurityError
} from "../src/agent/windows-storage-security-native.js";

test("native Windows ACL inspection fails closed when invoked on a non-Windows host", t => {
  if (process.platform === "win32") {
    t.skip("PowerShell security inspection requires a LocalService or NetworkService process identity");
    return;
  }
  assert.throws(
    () => readWindowsStorageSecurityReport({
      directory: "/tmp/jbqa-windows-acl-test",
      expectedServiceSid: "S-1-5-19"
    }),
    error => error instanceof WindowsStorageSecurityError &&
      error.code === "WINDOWS_STORAGE_SECURITY_CONFIGURATION_INVALID"
  );
});

test("native Windows ACL inspection rejects unsupported service identities", t => {
  if (process.platform === "win32") {
    t.skip("PowerShell security inspection requires a Windows service identity");
    return;
  }
  assert.throws(
    () => readWindowsStorageSecurityReport({
      directory: "C:\\ProgramData\\JBExpertQA",
      expectedServiceSid: "S-1-5-18"
    }),
    error => error instanceof WindowsStorageSecurityError &&
      error.code === "WINDOWS_STORAGE_SECURITY_PLATFORM_UNSUPPORTED"
  );
});
