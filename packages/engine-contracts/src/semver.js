const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(value) {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  });
}

export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new TypeError("Both versions must use stable MAJOR.MINOR.PATCH syntax");
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

export function isVersionWithinCompatibilityRange(version, { minVersion, maxMajor }) {
  const parsed = parseStableVersion(version);
  const minimum = parseStableVersion(minVersion);
  if (!parsed || !minimum || !Number.isSafeInteger(maxMajor) || maxMajor < minimum.major) {
    return false;
  }
  return compareStableVersions(version, minVersion) >= 0 && parsed.major <= maxMajor;
}
