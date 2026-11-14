const ENGINE_PACKAGES = Object.freeze([
  "@jb/expert-qa",
  "@jb/security-guard",
  "@jb/malware-engine"
]);

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version) {
  if (typeof version !== "string") return null;
  const match = version.trim().match(SEMVER_PATTERN);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease.localeCompare(right.prerelease, "en", { numeric: true });
}

export function classifyUpdate(currentVersion, candidateVersion) {
  const current = parseVersion(currentVersion);
  const candidate = parseVersion(candidateVersion);
  if (!current || !candidate) {
    return Object.freeze({ status: "invalid-version", releaseType: null, newer: false });
  }
  const comparison = compareVersions(current, candidate);
  if (comparison >= 0) {
    return Object.freeze({
      status: comparison === 0 ? "current" : "candidate-not-newer",
      releaseType: null,
      newer: false
    });
  }
  if (candidate.prerelease) {
    return Object.freeze({ status: "prerelease", releaseType: "prerelease", newer: true });
  }
  const releaseType = current.major !== candidate.major
    ? "major"
    : current.minor !== candidate.minor
      ? "minor"
      : "patch";
  return Object.freeze({ status: "update-available", releaseType, newer: true });
}

export function evaluateHybridUpdate({
  packageName,
  currentVersion,
  candidateVersion,
  channel = "stable",
  integrityVerified = false,
  signatureVerified = false,
  compatibilityVerified = false,
  testsPassed = null,
  userApproved = false
} = {}) {
  if (!ENGINE_PACKAGES.includes(packageName)) {
    return Object.freeze({ decision: "blocked", reason: "unknown-engine-package" });
  }
  if (!["stable", "beta"].includes(channel)) {
    return Object.freeze({ decision: "blocked", reason: "invalid-release-channel" });
  }
  if (typeof userApproved !== "boolean" ||
      ![true, false, null].includes(testsPassed)) {
    return Object.freeze({ decision: "blocked", reason: "invalid-update-state" });
  }

  const classification = classifyUpdate(currentVersion, candidateVersion);
  if (!classification.newer) {
    return Object.freeze({
      decision: "no-update",
      reason: classification.status,
      releaseType: classification.releaseType
    });
  }
  if (classification.status === "prerelease" && channel !== "beta") {
    return Object.freeze({ decision: "blocked", reason: "prerelease-not-allowed-on-stable" });
  }
  if (!integrityVerified || !signatureVerified || !compatibilityVerified) {
    return Object.freeze({
      decision: "blocked",
      reason: "verification-required",
      integrityVerified,
      signatureVerified,
      compatibilityVerified,
      releaseType: classification.releaseType
    });
  }
  if (testsPassed === false) {
    return Object.freeze({
      decision: "rollback-required",
      reason: "post-install-tests-failed",
      releaseType: classification.releaseType
    });
  }
  if (testsPassed !== true) {
    return Object.freeze({
      decision: classification.releaseType === "patch" && !userApproved
        ? "eligible-for-auto-validation"
        : "approval-required",
      reason: "tests-not-yet-passed",
      releaseType: classification.releaseType
    });
  }
  if (classification.releaseType === "patch") {
    return Object.freeze({
      decision: "auto-apply",
      reason: "verified-compatible-patch",
      releaseType: "patch"
    });
  }
  if (!userApproved) {
    return Object.freeze({
      decision: "approval-required",
      reason: "minor-or-major-release",
      releaseType: classification.releaseType
    });
  }
  return Object.freeze({
    decision: "apply-after-approval",
    reason: "user-approved-release",
    releaseType: classification.releaseType
  });
}

export const HYBRID_UPDATE_POLICY = Object.freeze({
  mode: "hybrid",
  automaticReleaseTypes: Object.freeze(["patch"]),
  approvalRequiredReleaseTypes: Object.freeze(["minor", "major"]),
  requiredChecks: Object.freeze([
    "manifest-signature",
    "package-integrity",
    "node-and-engine-compatibility",
    "post-install-tests"
  ]),
  rollbackOnFailure: true,
  packageIsolation: true
});

export { ENGINE_PACKAGES };
