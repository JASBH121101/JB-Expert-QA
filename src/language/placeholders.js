const SIMPLE_PLACEHOLDER = /^:([A-Za-z_][A-Za-z0-9_]*)/;
const MUSTACHE_PLACEHOLDER = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/;
const BRACE_ARGUMENT = /^\{([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*([A-Za-z_][A-Za-z0-9_-]*))?(?=\s*[,}])/;
const PRINTF_PLACEHOLDER = /^%([0-9]+\$)?([sd])/;

function findBalancedBraceEnd(value, start) {
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    else if (value[index] === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return start + 1;
}

export function extractPlaceholders(value) {
  if (typeof value !== "string") return [];
  const found = [];
  let index = 0;

  while (index < value.length) {
    const remainder = value.slice(index);

    if (remainder.startsWith("{{")) {
      const mustache = remainder.match(MUSTACHE_PLACEHOLDER);
      if (mustache) {
        found.push("{{" + mustache[1] + "}}");
        index += mustache[0].length;
        continue;
      }
    }

    if (value[index] === "{") {
      const argument = remainder.match(BRACE_ARGUMENT);
      if (argument) {
        const name = argument[1];
        const format = argument[2] ?? "";
        found.push(format ? "{" + name + "," + format + "}" : "{" + name + "}");
        // ICU plural/select arguments contain nested branch braces. Consume
        // the complete argument so branch labels and branch text are not
        // misreported as independent placeholders.
        index = findBalancedBraceEnd(value, index);
        continue;
      }
    }

    const simple = remainder.match(SIMPLE_PLACEHOLDER);
    if (simple) {
      found.push(":" + simple[1]);
      index += simple[0].length;
      continue;
    }

    const printf = remainder.match(PRINTF_PLACEHOLDER);
    if (printf) {
      found.push("%" + (printf[1] ?? "") + printf[2]);
      index += printf[0].length;
      continue;
    }

    index += 1;
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
