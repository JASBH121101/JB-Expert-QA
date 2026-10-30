export const SEVERITIES = Object.freeze([
  "critical",
  "high",
  "medium",
  "low",
  "info"
]);

export const DEFAULT_SEVERITY_PENALTIES = Object.freeze({
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
  info: 0
});

export function assertSeverity(severity) {
  if (!SEVERITIES.includes(severity)) {
    throw new TypeError(`Unknown severity: ${severity}`);
  }
  return severity;
}
