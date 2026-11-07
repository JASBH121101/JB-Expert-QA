function asFindings(report, label) {
  if (!report || !Array.isArray(report.diagnostics)) {
    throw new TypeError(label + " report must contain a diagnostics array");
  }
  return report.diagnostics;
}

function findingKey(finding) {
  return JSON.stringify([
    String(finding.ruleId ?? ""),
    String(finding.id ?? ""),
    String(finding.location ?? "")
  ]);
}

/**
 * Compare the findings from a previous audit with a targeted re-verification.
 * This is a comparison helper; it does not execute rules or mutate either report.
 */
export function compareReverification(previousReport, currentReport, { ruleIds } = {}) {
  const previous = asFindings(previousReport, "previous");
  const current = asFindings(currentReport, "current");

  if (ruleIds !== undefined && (
    !Array.isArray(ruleIds) ||
    ruleIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(ruleIds).size !== ruleIds.length
  )) {
    throw new TypeError("ruleIds must be an array of unique non-empty rule IDs");
  }

  const selected = ruleIds === undefined ? null : new Set(ruleIds);
  const inScope = (finding) => !selected ||
    selected.has(finding.ruleId) ||
    selected.has(finding.id);

  const previousScoped = previous.filter(inScope);
  const currentScoped = current.filter(inScope);
  const previousByKey = new Map(previousScoped.map((item) => [findingKey(item), item]));
  const currentByKey = new Map(currentScoped.map((item) => [findingKey(item), item]));

  const resolved = [];
  const unchanged = [];
  const newFindings = [];

  for (const [key, item] of previousByKey) {
    if (currentByKey.has(key)) unchanged.push(currentByKey.get(key));
    else resolved.push(item);
  }
  for (const [key, item] of currentByKey) {
    if (!previousByKey.has(key)) newFindings.push(item);
  }

  return Object.freeze({
    generatedAt: new Date().toISOString(),
    scope: Object.freeze({
      type: selected ? "targeted-rules" : "full-report",
      ruleIds: selected ? Object.freeze([...selected]) : null
    }),
    summary: Object.freeze({
      previous: previousScoped.length,
      current: currentScoped.length,
      resolved: resolved.length,
      unchanged: unchanged.length,
      newFindings: newFindings.length
    }),
    resolved: Object.freeze(resolved),
    unchanged: Object.freeze(unchanged),
    newFindings: Object.freeze(newFindings)
  });
}
