import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage",
  ".next", ".nuxt", ".output", ".cache", ".turbo", ".vercel", ".wrangler",
  "vendor", "playwright-report", "test-results"
]);
const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".json",
  ".md", ".mdx", ".yml", ".yaml", ".toml", ".sql", ".prisma",
  ".xml", ".svg", ".sh", ".ps1", ".py", ".rb", ".php", ".java",
  ".kt", ".go", ".rs", ".cs", ".graphql", ".gql"
]);
const LOCKFILE_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
  "yarn.lock", "bun.lock", "bun.lockb"
]);
const SAFE_ENV_TEMPLATES = new Set([
  ".env.example", ".env.sample", ".env.template", ".env.defaults"
]);
const SENSITIVE_FILENAMES = new Set([
  ".npmrc", ".pypirc", ".netrc", "credentials", "id_rsa", "id_ed25519"
]);

function posix(value) { return value.split(sep).join("/"); }
function isEnvFile(name) {
  const normalized = name.toLowerCase();
  return normalized === ".env" ||
    (normalized.startsWith(".env.") && !SAFE_ENV_TEMPLATES.has(normalized));
}
function isSensitiveFile(name) {
  const lower = name.toLowerCase();
  return SENSITIVE_FILENAMES.has(lower) ||
    /(?:credential|service[-_]?account|private[-_]?key|google[-_]?credentials|firebase-adminsdk|secret).*\.(?:json|ya?ml)$/i.test(lower) ||
    /\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(name);
}
function isSupported(name) {
  return SAFE_ENV_TEMPLATES.has(name) || LOCKFILE_NAMES.has(name) ||
    TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}
function withinRoot(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !rel.startsWith(sep));
}

export async function scanProject(rootPath, {
  maxFiles = 2500,
  maxFileBytes = 1_000_000,
  maxTotalBytes = 20_000_000,
  maxDepth = 20
} = {}) {
  for (const [name, value] of Object.entries({ maxFiles, maxFileBytes, maxTotalBytes, maxDepth })) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(name + " must be a positive integer");
  }
  const root = resolve(rootPath);
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new TypeError("Project path must be a real directory, not a symbolic link");
  }

  const files = [];
  const manifests = [];
  const lockFiles = [];
  const environmentFiles = [];
  const sensitiveFiles = [];
  const oversizedFiles = [];
  const unreadableFiles = [];
  const skippedSymlinks = [];
  let totalBytes = 0;
  let truncated = false;

  async function walk(directory, depth) {
    if (depth > maxDepth) { truncated = true; return; }
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      unreadableFiles.push(posix(relative(root, directory)) || ".");
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (truncated) return;
      const absolute = resolve(directory, entry.name);
      if (!withinRoot(root, absolute)) continue;
      let stats;
      try { stats = await lstat(absolute); }
      catch { unreadableFiles.push(posix(relative(root, absolute))); continue; }

      const rel = posix(relative(root, absolute));
      if (stats.isSymbolicLink()) { skippedSymlinks.push(rel); continue; }
      if (stats.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absolute, depth + 1);
        continue;
      }
      if (!stats.isFile()) continue;

      const name = basename(entry.name);
      if (isEnvFile(name)) { environmentFiles.push(rel); continue; }
      if (isSensitiveFile(name)) { sensitiveFiles.push(rel); continue; }
      if (!isSupported(name)) continue;
      if (files.length >= maxFiles) { truncated = true; break; }
      if (stats.size > maxFileBytes || totalBytes + stats.size > maxTotalBytes) {
        oversizedFiles.push({ path: rel, sizeBytes: stats.size });
        continue;
      }

      let content;
      try { content = await readFile(absolute, "utf8"); }
      catch { unreadableFiles.push(rel); continue; }
      totalBytes += stats.size;
      files.push({
        path: rel,
        extension: extname(name).toLowerCase(),
        sizeBytes: stats.size,
        lineCount: content.length ? content.split(/\r\n|\n|\r/).length : 0,
        content
      });

      if (name === "package.json") {
        try { manifests.push({ path: rel, data: JSON.parse(content), parseError: null }); }
        catch (error) {
          manifests.push({
            path: rel,
            data: null,
            parseError: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (LOCKFILE_NAMES.has(name)) lockFiles.push(rel);
    }
  }

  await walk(root, 0);
  const languageCounts = {};
  for (const file of files) {
    const key = file.extension || "[no extension]";
    languageCounts[key] = (languageCounts[key] ?? 0) + 1;
  }

  return Object.freeze({
    rootName: basename(root),
    files: Object.freeze(files),
    manifests: Object.freeze(manifests),
    lockFiles: Object.freeze(lockFiles),
    environmentFiles: Object.freeze(environmentFiles),
    sensitiveFiles: Object.freeze(sensitiveFiles),
    oversizedFiles: Object.freeze(oversizedFiles),
    unreadableFiles: Object.freeze(unreadableFiles),
    skippedSymlinks: Object.freeze(skippedSymlinks),
    summary: Object.freeze({
      filesRead: files.length,
      totalBytes,
      languageCounts: Object.freeze(languageCounts),
      packageManifests: manifests.length,
      lockFiles: lockFiles.length,
      environmentFiles: environmentFiles.length,
      sensitiveFiles: sensitiveFiles.length,
      oversizedFiles: oversizedFiles.length,
      unreadableFiles: unreadableFiles.length,
      skippedSymlinks: skippedSymlinks.length,
      truncated
    })
  });
}
