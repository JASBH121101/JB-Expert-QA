import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyUpdate,
  evaluateHybridUpdate,
  ENGINE_PACKAGES,
  HYBRID_UPDATE_POLICY
} from "../src/update-manager/policy.js";

const verified = {
  integrityVerified: true,
  signatureVerified: true,
  compatibilityVerified: true
};

test("classifies patch, minor, major, prerelease and invalid versions", () => {
  assert.equal(classifyUpdate("1.2.3", "1.2.4").releaseType, "patch");
  assert.equal(classifyUpdate("1.2.3", "1.3.0").releaseType, "minor");
  assert.equal(classifyUpdate("1.2.3", "2.0.0").releaseType, "major");
  assert.equal(classifyUpdate("1.2.3", "1.3.0-beta.1").status, "prerelease");
  assert.equal(classifyUpdate("1.2", "1.3.0").status, "invalid-version");
  assert.equal(classifyUpdate("1.2.3", "1.2.2").newer, false);
});

test("hybrid policy allows a verified patch to auto-apply only after tests pass", () => {
  const beforeTests = evaluateHybridUpdate({
    packageName: "@jb/expert-qa",
    currentVersion: "0.2.0",
    candidateVersion: "0.2.1",
    ...verified
  });
  assert.equal(beforeTests.decision, "eligible-for-auto-validation");

  const afterTests = evaluateHybridUpdate({
    packageName: "@jb/expert-qa",
    currentVersion: "0.2.0",
    candidateVersion: "0.2.1",
    ...verified,
    testsPassed: true
  });
  assert.equal(afterTests.decision, "auto-apply");
});

test("hybrid policy requires approval for minor and major releases", () => {
  for (const candidateVersion of ["0.3.0", "1.0.0"]) {
    const result = evaluateHybridUpdate({
      packageName: "@jb/security-guard",
      currentVersion: "0.2.0",
      candidateVersion,
      ...verified,
      testsPassed: true
    });
    assert.equal(result.decision, "approval-required");
  }
  const approved = evaluateHybridUpdate({
    packageName: "@jb/security-guard",
    currentVersion: "0.2.0",
    candidateVersion: "0.3.0",
    ...verified,
    testsPassed: true,
    userApproved: true
  });
  assert.equal(approved.decision, "apply-after-approval");
});

test("hybrid policy blocks unknown packages and unverifiable updates", () => {
  assert.equal(evaluateHybridUpdate({
    packageName: "untrusted-package",
    currentVersion: "1.0.0",
    candidateVersion: "1.0.1",
    ...verified
  }).decision, "blocked");

  assert.equal(evaluateHybridUpdate({
    packageName: "@jb/malware-engine",
    currentVersion: "0.6.2",
    candidateVersion: "0.6.3",
    integrityVerified: true,
    signatureVerified: false,
    compatibilityVerified: true
  }).reason, "verification-required");
});

test("hybrid policy refuses prereleases on stable channel and requests rollback on failed tests", () => {
  assert.equal(evaluateHybridUpdate({
    packageName: "@jb/malware-engine",
    currentVersion: "0.6.2",
    candidateVersion: "0.7.0-beta.1",
    ...verified,
    channel: "stable"
  }).reason, "prerelease-not-allowed-on-stable");

  assert.equal(evaluateHybridUpdate({
    packageName: "@jb/malware-engine",
    currentVersion: "0.6.2",
    candidateVersion: "0.6.3",
    ...verified,
    testsPassed: false
  }).decision, "rollback-required");
});

test("policy covers each independently versioned engine", () => {
  assert.deepEqual(ENGINE_PACKAGES, [
    "@jb/expert-qa",
    "@jb/security-guard",
    "@jb/malware-engine"
  ]);
  assert.deepEqual(HYBRID_UPDATE_POLICY.automaticReleaseTypes, ["patch"]);
  assert.equal(HYBRID_UPDATE_POLICY.rollbackOnFailure, true);
});
