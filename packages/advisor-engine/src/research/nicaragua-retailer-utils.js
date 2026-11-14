export function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(field + " must be a non-empty string");
  }
  return value.trim();
}

export function positiveInteger(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(field + " must be an integer between 1 and " + maximum);
  }
}

export function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}

export function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#(\d+);/gu, (_, code) => {
      const point = Number(code);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point) : "";
    })
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => {
      const point = Number.parseInt(code, 16);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point) : "";
    });
}

export function stripHtml(value) {
  return decodeHtml(String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

export function readMeta(html, targetName) {
  const tags = html.match(/<meta\b[^>]*>/giu) ?? [];
  for (const tag of tags) {
    const attributes = {};
    for (const match of tag.matchAll(/([a-z:-]+)\s*=\s*(["'])(.*?)\2/giu)) {
      attributes[match[1].toLowerCase()] = decodeHtml(match[3]);
    }
    if (attributes.property === targetName || attributes.name === targetName) {
      return attributes.content ?? null;
    }
  }
  return null;
}

export function collectJsonLdProducts(html) {
  const products = [];
  const scripts = html.matchAll(
    /<script\b(?=[^>]*type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/giu,
  );
  const visit = value => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (types.some(type => String(type ?? "").toLowerCase() === "product")) products.push(value);
    if (value["@graph"]) visit(value["@graph"]);
    if (value.mainEntity) visit(value.mainEntity);
    if (value.itemListElement) visit(value.itemListElement);
  };
  for (const match of scripts) {
    try { visit(JSON.parse(decodeHtml(match[1]))); } catch { /* Ignore unrelated or malformed JSON-LD blocks. */ }
  }
  return products;
}
