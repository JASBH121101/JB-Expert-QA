const PLACEHOLDER_PATTERN = /:([A-Za-z_][A-Za-z0-9_]*)|\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*([A-Za-z_][A-Za-z0-9_-]*))?(?=\s*[,}])|%([0-9]+\$)?([sd])/g;

function formatBracePlaceholder(name, format) {
  return format ? "{" + name + "," + format + "}" : "{" + name + "}";
}

export function extractPlaceholders(value) {
  if (typeof value !== "string") return [];
  const found = [];
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    if (match[1]) found.push(":" + match[1]);
    else if (match[2]) found.push("{{" + match[2] + "}}");
    else if (match[3]) found.push(formatBracePlaceholder(match[3], match[4]));
    else found.push("%" + (match[5] ?? "") + match[6]);
  }
  return found.sort();
}

export function comparePlaceholders(source, target) {
  const expected = extractPlaceholders(source);
  const targetPlaceholders = extractPlaceholders(target);
  const remaining = [...targetPlaceholders];
  const missing = [];
  for (const item of expected) {
    const index = remaining.indexOf(item);
    if (index < 0) missing.push(item);
    else remaining.splice(index, 1);
  }
  return Object.freeze({
    matches: missing.length === 0 && remaining.length === 0,
    missing: Object.freeze(missing),
    unexpected: Object.freeze(remaining),
    source: Object.freeze(expected),
    target: Object.freeze(targetPlaceholders)
  });
}
