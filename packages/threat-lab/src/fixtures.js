// Harmless industry-standard antivirus test string. Never execute this value.
export const EICAR_TEST_STRING = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export function createSyntheticFixture({ label = "benign-fixture", content = "JB Threat Lab inert fixture" } = {}) {
  if (typeof content !== "string" && !Buffer.isBuffer(content)) {
    throw new TypeError("content must be a string or Buffer");
  }
  return Object.freeze({
    label: String(label).slice(0, 100),
    bytes: Buffer.from(content),
    executable: false,
    network: false
  });
}

export function createInertSuspiciousTextFixture(kind = "script-pattern") {
  const samples = {
    "script-pattern": "# Inert text fixture only\\n# Example marker: Invoke-Expression\\n# Not executable; do not run",
    "sql-pattern": "SELECT * FROM demo WHERE name = '' OR '1'='1'; -- inert test text",
    "path-pattern": "../../etc/passwd (literal test string; never used as a path)"
  };
  if (!Object.hasOwn(samples, kind)) throw new TypeError("Unsupported fixture kind");
  return createSyntheticFixture({ label: kind, content: samples[kind] });
}
