import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { normalizeLocale, DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../language/locale.js";
import { parsePhpTranslationArray } from "../../language/php-array-parser.js";
import { auditTranslationMaps } from "../../language/audit.js";

async function listFiles(directory, root, output = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await listFiles(path, root, output);
      continue;
    }
    if (!entry.isFile() || ![".php", ".json"].includes(extname(entry.name).toLowerCase())) continue;
    output.push(path);
    if (output.length >= 500) return output;
  }
  return output;
}

function flattenFiles(files, localeRoot, locale) {
  return new Map(files.map((path) => [
    relative(localeRoot, path).split(sep).join("/"),
    path
  ]));
}

async function readTranslationResource(path) {
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > 2_000_000) {
    throw new Error("Translation resource exceeds the 2 MB safety limit");
  }
  if (extname(path).toLowerCase() === ".json") {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON translation resource must contain an object");
    }
    return parsed;
  }
  return parsePhpTranslationArray(content);
}

export async function auditLanguageFiles(projectRoot, {
  languageDirectory = "lang",
  sourceLocale = DEFAULT_LOCALE,
  targetLocale = "en",
  library,
  maxFiles = 500
} = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) {
    throw new TypeError("A project root directory is required");
  }
  const root = resolve(projectRoot);
  const source = normalizeLocale(sourceLocale);
  const target = normalizeLocale(targetLocale);
  if (!source || !target || source === target) {
    throw new TypeError("Language audit requires two different supported locales");
  }

  const langRoot = resolve(root, languageDirectory);
  const languageDirs = await readdir(langRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const localeRoots = new Map();
  for (const entry of languageDirs) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const locale = normalizeLocale(entry.name);
    if (!locale) continue;
    const existing = localeRoots.get(locale);
    // Prefer canonical es-419 over the legacy es alias when both exist.
    if (!existing || entry.name.toLowerCase() === locale.toLowerCase()) {
      localeRoots.set(locale, join(langRoot, entry.name));
    }
  }

  const sourceRoot = localeRoots.get(source);
  const targetRoot = localeRoots.get(target);
  if (!sourceRoot && !targetRoot) {
    return Object.freeze({
      status: "skipped",
      reason: "No supported locale directories were found.",
      sourceLocale: source,
      targetLocale: target,
      filesChecked: 0,
      parseErrors: Object.freeze([]),
      findings: Object.freeze([])
    });
  }

  const sourceFiles = sourceRoot ? await listFiles(sourceRoot, sourceRoot) : [];
  const targetFiles = targetRoot ? await listFiles(targetRoot, targetRoot) : [];
  if (sourceFiles.length > maxFiles || targetFiles.length > maxFiles) {
    throw new Error("Language audit exceeds the configured file limit");
  }
  const sourceMap = flattenFiles(sourceFiles, sourceRoot ?? langRoot, source);
  const targetMap = flattenFiles(targetFiles, targetRoot ?? langRoot, target);
  const allPaths = [...new Set([...sourceMap.keys(), ...targetMap.keys()])].sort();
  const files = [];
  const findings = [];
  const parseErrors = [];

  for (const relativePath of allPaths) {
    const sourcePath = sourceMap.get(relativePath);
    const targetPath = targetMap.get(relativePath);
    if (!sourcePath) {
      const item = { id: "target-file-without-source", path: relativePath, locale: target, severity: "low" };
      findings.push(item);
      files.push({ path: relativePath, status: "stale", counts: { sourceKeys: 0, targetKeys: 0 } });
      continue;
    }
    if (!targetPath) {
      const item = { id: "missing-locale-file", path: relativePath, locale: target, severity: "high" };
      findings.push(item);
      files.push({ path: relativePath, status: "partial", counts: { sourceKeys: 0, targetKeys: 0 } });
      continue;
    }
    try {
      const [sourceResource, targetResource] = await Promise.all([
        readTranslationResource(sourcePath),
        readTranslationResource(targetPath)
      ]);
      const result = auditTranslationMaps(sourceResource, targetResource, {
        sourceLocale: source,
        targetLocale: target,
        ...(library ? { library } : {})
      });
      const fileFindings = result.findings.map((item) => ({ ...item, path: relativePath }));
      findings.push(...fileFindings);
      files.push({
        path: relativePath,
        status: result.reviewStatus,
        counts: result.counts,
        sourceHash: result.sourceHash,
        targetHash: result.targetHash
      });
    } catch (error) {
      const issue = {
        id: "resource-parse-error",
        path: relativePath,
        severity: "high",
        message: error instanceof Error ? error.message : String(error)
      };
      parseErrors.push(issue);
      findings.push(issue);
      files.push({ path: relativePath, status: "review-required", counts: null });
    }
  }

  return Object.freeze({
    status: "checked",
    sourceLocale: source,
    targetLocale: target,
    supportedLocales: SUPPORTED_LOCALES,
    filesChecked: files.filter((item) => item.counts !== null).length,
    reviewStatus: parseErrors.length ? "review-required" :
      files.some((item) => item.status === "partial") ? "partial" :
      files.some((item) => item.status === "stale") ? "stale" :
      "review-required",
    files: Object.freeze(files),
    parseErrors: Object.freeze(parseErrors),
    findings: Object.freeze(findings),
    summary: Object.freeze({
      files: files.length,
      findings: findings.length,
      parseErrors: parseErrors.length,
      missingKeys: findings.filter((item) => item.id === "missing-key").length,
      placeholderMismatches: findings.filter((item) => item.id === "placeholder-mismatch").length,
      glossaryReview: findings.filter((item) => item.id === "glossary-review").length
    })
  });
}
