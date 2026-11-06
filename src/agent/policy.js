import { redactUrlsInText } from "../core/redaction.js";

const SAFE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".py", ".rb", ".php", ".java", ".kt", ".go", ".rs", ".cs"
]);
const BLOCKED_SEGMENTS = new Set([
  ".git", ".github", "node_modules", "supabase", "migrations", "migration",
  "infra", "infrastructure", "terraform", "secrets", "secret", "core", "agent", "ai", "security",
  "auth", "authentication", "authorization", "billing", "payment", "payments",
  "database", "databases", "db", "config", "deploy", "deployment"
]);
const BLOCKED_FILENAMES = new Set([
  ".env", ".npmrc", ".pypirc", ".netrc", "credentials",
  "package.json", "package-lock.json", "npm-shrinkwrap.json",
  "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "wrangler.toml", "dockerfile", "docker-compose.yml"
]);

export function normalizeProjectPath(value) {
  if (typeof value !== "string") return null;
  const path = value.replace(/\\/g, "/").trim();
  if (!path || path.includes("\0") || path.startsWith("/") || /^[a-z]:/i.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

export function evaluatePatchPaths(paths, { maxFiles = 5 } = {}) {
  if (!Array.isArray(paths)) throw new TypeError("paths must be an array");
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 20) {
    throw new TypeError("maxFiles must be between 1 and 20");
  }
  const allowed = [];
  const blocked = [];
  for (const rawPath of [...new Set(paths)]) {
    const path = normalizeProjectPath(rawPath);
    if (!path) {
      blocked.push({ path: String(rawPath), reason: "invalid or non-relative path" });
      continue;
    }
    const parts = path.split("/");
    const filename = parts[parts.length - 1].toLowerCase();
    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
    const blockedSegment = parts.find((part) => BLOCKED_SEGMENTS.has(part.toLowerCase()));
    const sensitivePath = parts.some((part) => /^(?:auth(?:entication)?|login|sessions?|payments?|billing|checkout|databases?|sql|secrets?|credentials?|config)(?:[-_.]|$)/i.test(part));
    if (BLOCKED_FILENAMES.has(filename) || /^\.env(?:\.|$)/i.test(filename)) {
      blocked.push({ path, reason: "sensitive or dependency-manifest file" });
    } else if (parts[0].toLowerCase() !== "src") {
      blocked.push({ path, reason: "automatic repair is restricted to the src directory" });
    } else if (blockedSegment || sensitivePath) {
      blocked.push({ path, reason: "protected source path: " + (blockedSegment || "sensitive component") });
    } else if (!SAFE_EXTENSIONS.has(extension)) {
      blocked.push({ path, reason: "file extension is outside the auto-repair allowlist" });
    } else {
      allowed.push(path);
    }
  }
  return Object.freeze({
    allowed: Object.freeze(allowed.slice(0, maxFiles)),
    blocked: Object.freeze(blocked),
    overLimit: allowed.length > maxFiles
  });
}

export function validateUnifiedPatch(patch, { allowedPaths = [] } = {}) {
  if (typeof patch !== "string" || !patch.trim()) {
    throw new TypeError("A non-empty unified diff is required");
  }
  if (Buffer.byteLength(patch, "utf8") > 100000) {
    throw new RangeError("Patch exceeds the 100 KB safety limit");
  }
  if (/^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|similarity index|dissimilarity index|GIT binary patch|Binary files)\b/m.test(patch)) {
    throw new Error("New, deleted, renamed, copied, mode-changed or binary files are not allowed");
  }
  const allowed = new Set(allowedPaths.map(normalizeProjectPath).filter(Boolean));
  const matches = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+?)\s*$/gm)];
  if (!matches.length) throw new Error("Patch must contain standard git diff file headers");
  const paths = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const oldPath = normalizeProjectPath(match[1]);
    const newPath = normalizeProjectPath(match[2]);
    if (!oldPath || !newPath || oldPath !== newPath) {
      throw new Error("Patch paths must be safe, relative, and unchanged");
    }
    if (!allowed.has(oldPath)) {
      throw new Error("Patch references a file outside the approved source allowlist: " + oldPath);
    }
    const sectionEnd = index + 1 < matches.length ? matches[index + 1].index : patch.length;
    const section = patch.slice(match.index, sectionEnd);
    const fileHeaders = [...section.matchAll(/^(---|\+\+\+) ([ab])\/(.+)$/gm)];
    const validHeaders = fileHeaders.length === 2 &&
      fileHeaders[0][1] === "---" && fileHeaders[0][2] === "a" &&
      fileHeaders[1][1] === "+++" && fileHeaders[1][2] === "b";
    const headerPaths = fileHeaders.map((header) => normalizeProjectPath(header[3]));
    if (!validHeaders || headerPaths.some((path) => path !== oldPath)) {
      throw new Error("Patch file headers must match the approved diff path exactly");
    }
    paths.push(oldPath);
  }
  return Object.freeze([...new Set(paths)]);
}

export function redactSourceForAI(source) {
  if (typeof source !== "string") return "";
  return redactUrlsInText(source)
    .replace(/(\b(?:api[_-]?key|client[_-]?secret|authorization|auth|access[_-]?token|refresh[_-]?token|auth(?:entication)?[_-]?token|bearer|token|jwt|credential|password|private[_-]?key|secret)\b\s*[:=]\s*["'])([^"']+)(["'])/gi, "$1[REDACTED]$3")
    .replace(/(\b(?:api[_-]?key|client[_-]?secret|authorization|auth|access[_-]?token|refresh[_-]?token|auth(?:entication)?[_-]?token|bearer|token|jwt|credential|password|private[_-]?key|secret)\b\s*[:=]\s*)(?:Bearer\s+)?(?!["'])([^\r\n,;#}\]]+)/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|AIza[0-9A-Za-z_-]{30,}|sk_live_[A-Za-z0-9]{16,})\b/g, "[REDACTED_TOKEN]");
}
