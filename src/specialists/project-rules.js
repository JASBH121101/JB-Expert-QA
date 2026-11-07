import { parse } from "acorn";

function finding(id, title, description, severity, path, recommendation, metadata = {}, line = null) {
  return {
    id, title, description, severity,
    location: line ? path + ":" + line : path,
    recommendation,
    evidence: { path, line, redacted: metadata.valueRedacted === true },
    metadata
  };
}
function commentLine(line) { return /^\s*(?:\/\/|\/\*|\*|#|--)/.test(line); }
function placeholder(value) {
  const text = value.trim().toLowerCase();
  return text.length < 12 ||
    /^(?:example|sample|dummy|fake|test|placeholder|changeme|change_me|redacted|<.*>|\*+|x+)$/i.test(text) ||
    /^(?:your|replace)[_-].+/i.test(text) ||
    /(?:process\.env|import\.meta\.env|env\.[a-z_]+)/i.test(text);
}

const HTML_ESCAPE_CALL = /\b(?:esc|escapeHtml|escapeHTML|escapeAttribute|escapeHtmlAttribute|sanitizeHtml|sanitizeHTML|sanitizeHTMLString)\s*\(|\bDOMPurify\s*\.\s*sanitize\s*\(/i;
const HTML_ESCAPE_CALL_GLOBAL = /\b(?:esc|escapeHtml|escapeHTML|escapeAttribute|escapeHtmlAttribute|sanitizeHtml|sanitizeHTML|sanitizeHTMLString)\s*\(|\bDOMPurify\s*\.\s*sanitize\s*\(/gi;
const UNTRUSTED_HTML_SOURCE = /\b(?:event|evt)\s*\.\s*target\s*\.\s*(?:value|innerHTML|textContent)\b|\b(?:input|textarea|select)\s*\.\s*value\b|\b(?:userInput|untrustedInput|rawHtml|htmlFromUser)\b|\b(?:req|request)\s*\.\s*(?:body|query|params)\b|\bURLSearchParams\b|\blocation\s*\.\s*(?:hash|search)\b/i;

function balancedClose(source, openIndex, openChar, closeChar) {
  let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i], next = source[i + 1];
    if (lineComment) { if (char === "\n" || char === "\r") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (char === "'" || char === '"' || char === "\x60") { quote = char; continue; }
    if (char === openChar) depth += 1;
    else if (char === closeChar && --depth === 0) return i;
  }
  return -1;
}

function statementEnd(source, start) {
  let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
  const limit = Math.min(source.length, start + 16000);
  for (let i = start; i < limit; i += 1) {
    const char = source[i], next = source[i + 1];
    if (lineComment) { if (char === "\n" || char === "\r") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (char === "'" || char === '"' || char === "\x60") { quote = char; continue; }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) return i;
  }
  return limit;
}

function maskNonCode(source) {
  const output = source.split("");
  let quote = null, escaped = false, lineComment = false, blockComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i], next = source[i + 1];
    if (lineComment) { if (char === "\n" || char === "\r") lineComment = false; else output[i] = " "; continue; }
    if (blockComment) {
      output[i] = char === "\n" || char === "\r" ? char : " ";
      if (char === "*" && next === "/") { output[i + 1] = " "; blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      output[i] = char === "\n" || char === "\r" ? char : " ";
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { output[i] = " "; output[i + 1] = " "; lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { output[i] = " "; output[i + 1] = " "; blockComment = true; i += 1; continue; }
    if (char === "'" || char === '"' || char === "\x60") { output[i] = " "; quote = char; }
  }
  return output.join("");
}

function expressionCode(expression) {
  const templateExpressions = [];
  const withoutTemplates = expression.replace(/\x60(?:\\.|[^\x60\\])*\x60/gs, (literal) => {
    for (const match of literal.matchAll(/\$\{([\s\S]*?)\}/g)) templateExpressions.push(match[1]);
    return " ";
  });
  return withoutTemplates
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\r\n]*/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .concat(" ", templateExpressions.join(" "));
}

function removeEscapedCalls(code) {
  const ranges = [];
  HTML_ESCAPE_CALL_GLOBAL.lastIndex = 0;
  for (const match of code.matchAll(HTML_ESCAPE_CALL_GLOBAL)) {
    const open = match.index + match[0].lastIndexOf("(");
    const close = balancedClose(code, open, "(", ")");
    if (close >= 0) ranges.push([match.index, close + 1]);
  }
  let result = "", cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    result += code.slice(cursor, start) + " ";
    cursor = end;
  }
  return result + code.slice(cursor);
}

function localRendererUsesEscaping(code, fullSource) {
  const calls = [...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((item) => item[1]);
  for (const name of new Set(calls)) {
    if (["if", "for", "while", "switch", "catch", "function"].includes(name)) continue;
    const declaration = new RegExp("\\bfunction\\s+" + name + "\\s*\\(");
    const match = declaration.exec(fullSource);
    if (!match) continue;
    const nextFunction = fullSource.indexOf("\n  function ", match.index + match[0].length);
    const body = fullSource.slice(match.index, nextFunction < 0 ? fullSource.length : nextFunction);
    if (HTML_ESCAPE_CALL.test(body) || (name === "svg" && /\biconPaths\b/.test(body))) return true;
  }
  return false;
}

function classifyHtmlSink(expression, fullSource) {
  const code = expressionCode(expression);
  if (!(code.match(/[A-Za-z_$][\w$]*/g) ?? []).length) {
    return { skip: true, classification: "static-markup" };
  }
  const hasEscapingCall = HTML_ESCAPE_CALL.test(code);
  const residual = removeEscapedCalls(code);
  if (UNTRUSTED_HTML_SOURCE.test(residual)) {
    return { severity: "high", classification: "unescaped-untrusted-source", helperDetected: hasEscapingCall };
  }
  if (hasEscapingCall || localRendererUsesEscaping(code, fullSource)) {
    return { severity: "info", classification: "recognized-escape-or-local-renderer", helperDetected: true };
  }
  return { severity: "medium", classification: "dynamic-sink-manual-review", helperDetected: false };
}

function collectHtmlSinks(source) {
  const masked = maskNonCode(source);
  const patterns = [
    { regex: /\.innerHTML\s*=/g, kind: "innerHTML", call: false },
    { regex: /\.insertAdjacentHTML\s*\(/g, kind: "insertAdjacentHTML", call: true },
    { regex: /\bdangerouslySetInnerHTML\s*[:=]/g, kind: "dangerouslySetInnerHTML", call: false }
  ];
  const sinks = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of masked.matchAll(pattern.regex)) {
      let expression;
      if (pattern.call) {
        const open = masked.indexOf("(", match.index);
        const close = balancedClose(masked, open, "(", ")");
        expression = source.slice(open + 1, close < 0 ? statementEnd(source, open + 1) : close);
      } else {
        const start = match.index + match[0].length;
        expression = source.slice(start, statementEnd(source, start));
      }
      const line = source.slice(0, match.index).split(/\r\n|\n|\r/).length;
      sinks.push({ line, kind: pattern.kind, expression });
    }
  }
  return sinks.sort((a, b) => a.line - b.line);
}

const SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".sql", ".prisma",
  ".sh", ".ps1", ".py", ".rb", ".php", ".java", ".kt", ".go", ".rs",
  ".cs", ".graphql", ".gql"
]);

export const codeQualityRules = [
  {
    id: "code-quality.scan-completeness",
    specialist: "code-quality",
    evaluate(context) {
      const summary = context.projectScan?.summary;
      if (!summary) return [];
      const reasons = [];
      if (summary.truncated) reasons.push("file-count or directory-depth limit reached");
      if ((summary.oversizedFiles ?? 0) > 0) reasons.push(summary.oversizedFiles + " oversized file(s) skipped");
      if ((summary.unreadableFiles ?? 0) > 0) reasons.push(summary.unreadableFiles + " unreadable file(s) skipped");
      if (!reasons.length) return [];
      return [finding(
        "CODE-SCAN-001",
        "Project scan incomplete",
        "This audit did not inspect the full supported project scope: " + reasons.join("; ") + ". A passing result cannot be issued.",
        "critical",
        ".",
        "Increase scan limits, resolve file-access problems, and rerun the audit until the scan is complete.",
        {
          truncated: Boolean(summary.truncated),
          oversizedFiles: summary.oversizedFiles ?? 0,
          unreadableFiles: summary.unreadableFiles ?? 0,
          blocksPass: true
        }
      )];
    }
  },
  {
    id: "code-quality.file-size",
    specialist: "code-quality",
    evaluate(context) {
      const limit = context.thresholds?.maxFileLines ?? 800;
      return (context.projectFiles ?? [])
        .filter((file) => SOURCE_EXTENSIONS.has(file.extension) && file.lineCount > limit).map((file) =>
        finding("CODE-SIZE-" + file.path.replace(/[^a-z0-9]+/gi, "-"),
          "Large source file",
          "This file contains " + file.lineCount + " lines, above the configured review threshold of " + limit + ".",
          "medium", file.path,
          "Consider separating unrelated responsibilities into smaller modules.",
          { lineCount: file.lineCount, threshold: limit }));
    }
  },
  {
    id: "code-quality.test-presence",
    specialist: "code-quality",
    evaluate(context) {
      const files = context.projectFiles ?? [];
      const sourceCount = files.filter((file) =>
        /\.(?:[cm]?[jt]sx?|vue|svelte|py|php|java|kt|go|rs)$/i.test(file.path) &&
        !/(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)/i.test(file.path)).length;
      const testCount = files.filter((file) =>
        /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file.path)).length;
      if (!sourceCount || testCount) return [];
      return [finding("CODE-TESTS-001", "No test files detected",
        "The scanned source tree contains code files but no recognizable test or spec files.",
        "low", ".", "Add automated tests for critical business rules, calculations, authentication, and data persistence.",
        { sourceFiles: sourceCount, testFiles: testCount })];
    }
  }
];

export const securityRules = [
  {
    id: "security.hardcoded-credentials",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      const assignment = /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth(?:entication)?[_-]?token|bearer|token|jwt|credential|password|private[_-]?key|secret)\b\s*[:=]\s*["']([^"']{12,})["']/i;
      const tokenPattern = /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|AIza[0-9A-Za-z_-]{30,}|sk_live_[A-Za-z0-9]{16,})\b/;
      for (const file of context.projectFiles ?? []) {
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (commentLine(line)) continue;
          const assigned = assignment.exec(line);
          const token = tokenPattern.exec(line);
          if ((assigned && !placeholder(assigned[1])) || token) {
            findings.push(finding("SEC-SECRET-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + (index + 1),
              "Possible hardcoded credential",
              "A credential-like value was detected. Its contents are intentionally excluded from this report.",
              "critical", file.path,
              "Remove the value from source control, rotate the credential if it was real, and load it from a managed environment secret.",
              { detector: token ? "known-token-format" : "sensitive-assignment", valueRedacted: true }, index + 1));
          }
        }
      }
      return findings;
    }
  },

  {
    id: "security.dynamic-code",
    specialist: "security",
    evaluate(context) {
      const patterns = [
        { regex: /\beval\s*\(/, label: "Dynamic eval execution", severity: "high" },
        { regex: /\bnew\s+Function\s*\(/, label: "Dynamic Function constructor", severity: "high" },
        { regex: /\brejectUnauthorized\s*:\s*false\b/, label: "TLS certificate verification disabled", severity: "high" }
      ];
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (commentLine(line)) continue;
          for (const pattern of patterns) {
            if (!pattern.regex.test(line)) continue;
            findings.push(finding(
              "SEC-CODE-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + (index + 1) + "-" + pattern.label.replace(/[^a-z0-9]+/gi, "-"),
              pattern.label,
              "A potentially unsafe code pattern was detected and requires source-level review.",
              pattern.severity, file.path,
              "Review the data flow and trust boundary. Avoid dynamic code execution and keep TLS certificate verification enabled.",
              { detector: pattern.label, requiresManualReview: true }, index + 1));
          }
        }
        for (const sink of collectHtmlSinks(file.content)) {
          const classification = classifyHtmlSink(sink.expression, file.content);
          if (classification.skip) continue;
          const title = classification.severity === "high"
            ? "Unescaped dynamic HTML injection sink"
            : classification.severity === "info"
              ? "HTML sink uses a recognized escaping or rendering helper"
              : "Dynamic HTML sink requires manual review";
          const description = classification.severity === "high"
            ? "A common untrusted-input source appears to reach an HTML sink without a recognized escaping helper. Verify the data flow and remediate before release."
            : classification.severity === "info"
              ? "A recognized escaping helper or local renderer is present. This heuristic cannot prove that every interpolation is context-safe, so retain human review."
              : "Dynamic markup reaches an HTML sink, but the static analyzer cannot trace every value to a trusted source or escaping helper.";
          const recommendation = classification.severity === "high"
            ? "Remove the raw untrusted value from the HTML string. Prefer textContent or DOM node APIs; otherwise apply context-appropriate escaping to every dynamic text and attribute value."
            : "Review every dynamic interpolation, especially attributes and URLs. Prefer DOM node APIs or a vetted sanitizer; do not rely on a helper name alone as proof of safety.";
          findings.push(finding(
            "SEC-HTML-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + sink.line + "-" + sink.kind,
            title, description, classification.severity, file.path, recommendation,
            {
              detector: "html-sink-context",
              sink: sink.kind,
              classification: classification.classification,
              escapingHelperDetected: classification.helperDetected,
              requiresManualReview: true
            },
            sink.line
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "security.local-secret-files",
    specialist: "security",
    evaluate(context) {
      const paths = [...(context.projectScan?.environmentFiles ?? []), ...(context.projectScan?.sensitiveFiles ?? [])];
      return paths.map((path) => finding(
        "SEC-LOCAL-FILE-" + path.replace(/[^a-z0-9]+/gi, "-"),
        "Sensitive local file present",
        "A local environment or credential file was found. Its contents were not opened or copied into the audit report.",
        "medium", path,
        "Confirm the file is excluded from version control and use an example template containing placeholder values instead.",
        { contentsRead: false }));
    }
  }
];

export const dependencyRules = [
  {
    id: "dependencies.floating-versions",
    specialist: "dependencies",
    evaluate(context) {
      const findings = [];
      for (const manifest of context.packageManifests ?? []) {
        if (!manifest.data) continue;
        for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
          for (const [name, version] of Object.entries(manifest.data[section] ?? {})) {
            if (typeof version !== "string" || !/^(?:\*|latest|x)$/i.test(version.trim())) continue;
            findings.push(finding(
              "DEP-FLOAT-" + manifest.path.replace(/[^a-z0-9]+/gi, "-") + "-" + name.replace(/[^a-z0-9]+/gi, "-"),
              "Dependency version is not constrained",
              "Package \"" + name + "\" uses the version specifier \"" + version + "\".",
              "medium", manifest.path,
              "Use a deliberate version range and commit the package manager lockfile for reproducible installs.",
              { packageName: name, specifier: version, section }));
          }
        }
      }
      return findings;
    }
  },
  {
    id: "dependencies.lockfile",
    specialist: "dependencies",
    evaluate(context) {
      const manifests = (context.packageManifests ?? []).filter((item) => item.path === "package.json");
      if (!manifests.length) return [];
      const lockNames = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]);
      const rootLock = (context.projectScan?.lockFiles ?? []).some((path) => lockNames.has(path.split("/").pop()));
      if (rootLock) return [];
      return [finding("DEP-LOCK-001", "No root JavaScript lockfile detected",
        "A root package.json exists, but no npm, pnpm, Yarn, or Bun lockfile was found at the project root.",
        "medium", "package.json",
        "Commit the lockfile for the package manager used by CI and production deployments.",
        { packageManagersChecked: ["npm", "pnpm", "yarn", "bun"] })];
    }
  },
  {
    id: "dependencies.lifecycle-scripts",
    specialist: "dependencies",
    evaluate(context) {
      const findings = [];
      const risky = /(?:\bcurl\b|\bwget\b|powershell|invoke-webrequest|\bbash\s+-c\b|\bsh\s+-c\b|\bnode\s+-e\b)/i;
      for (const manifest of context.packageManifests ?? []) {
        if (!manifest.data?.scripts) continue;
        for (const hook of ["preinstall", "install", "postinstall"]) {
          const command = manifest.data.scripts[hook];
          if (typeof command !== "string" || !risky.test(command)) continue;
          findings.push(finding("DEP-LIFECYCLE-" + hook + "-" + manifest.path.replace(/[^a-z0-9]+/gi, "-"),
            "Review package installation script",
            "The " + hook + " lifecycle script invokes a shell or download utility and should be reviewed before dependency installation.",
            "high", manifest.path,
            "Inspect every command and downloaded artifact; avoid executing remote scripts without pinning and integrity verification.",
            { hook, commandRedacted: true }));
        }
      }
      return findings;
    }
  },
  {
    id: "dependencies.osv-advisories",
    specialist: "dependencies",
    evaluate(context) {
      const scan = context.dependencyAdvisoryScan;
      if (!scan?.enabled) return [];
      const findings = [];

      if (scan.status === "unavailable") {
        findings.push(finding(
          "DEP-OSV-001",
          "Dependency advisory lookup unavailable",
          "OSV.dev could not complete the dependency advisory lookup. " + (scan.error || "No additional error details are available."),
          scan.required ? "critical" : "info",
          "package.json",
          scan.required
            ? "Restore advisory service connectivity and rerun the audit before accepting this release."
            : "Retry the online advisory lookup; this run must not be interpreted as proof that dependencies are vulnerability-free.",
          { provider: "OSV.dev", required: scan.required === true, networkRequests: scan.networkRequests ?? 0 }
        ));
      } else if (scan.status !== "complete") {
        const directOnly = scan.directOnly === true;
        const statusDescription = scan.message || "A complete resolved dependency graph was not available.";
        findings.push(finding(
          "DEP-OSV-COVERAGE-001",
          directOnly ? "Transitive dependency coverage is incomplete" : "Dependency advisory coverage is incomplete",
          statusDescription,
          scan.required ? "critical" : "info",
          "package.json",
          directOnly
            ? "Commit a supported npm lockfile to let the auditor check resolved direct and transitive package versions."
            : "Add or repair a supported lockfile, increase the configured safety limits, or resolve the advisory lookup issue, then rerun the audit.",
          {
            provider: "OSV.dev",
            status: scan.status,
            required: scan.required === true,
            packagesDiscovered: scan.packagesDiscovered ?? 0,
            packagesQueried: scan.packagesQueried ?? 0,
            packagesSkipped: scan.packagesSkipped ?? 0,
            truncated: scan.truncated === true
          }
        ));
      }

      for (const item of scan.findings ?? []) {
        const safeId = String(item.id || "unknown").replace(/[^a-z0-9]+/gi, "-");
        const packageId = String(item.packageName || "package").replace(/[^a-z0-9]+/gi, "-");
        const fixed = Array.isArray(item.fixedVersions) ? item.fixedVersions : [];
        const recommendation = fixed.length
          ? "Upgrade " + item.packageName + " to " + fixed.join(" or ") + " after checking compatibility, then rerun the audit and tests."
          : "Review OSV.dev advisory " + item.id + ", determine whether a patched release exists, and upgrade or mitigate the affected package.";
        const references = Array.isArray(item.references) ? item.references : [];
        findings.push(finding(
          "DEP-OSV-" + safeId + "-" + packageId,
          "Known dependency vulnerability: " + item.packageName,
          "OSV.dev reports " + item.packageName + "@" + item.installedVersion + " as affected by " + item.id + ". " + (item.summary || ""),
          item.severity || "medium",
          scan.supportedLockfiles?.[0] || "package.json",
          recommendation,
          {
            provider: "OSV.dev",
            advisoryId: item.id,
            packageName: item.packageName,
            installedVersion: item.installedVersion,
            fixedVersions: fixed,
            modified: item.modified ?? null,
            references,
            detailsUnavailable: item.detailsUnavailable === true
          }
        ));
      }
      return findings;
    }
  },
  {
    id: "dependencies.invalid-manifest",
    specialist: "dependencies",
    evaluate(context) {
      return (context.packageManifests ?? []).filter((item) => item.parseError).map((item) =>
        finding("DEP-MANIFEST-" + item.path.replace(/[^a-z0-9]+/gi, "-"),
          "Package manifest could not be parsed",
          "The package manifest is not valid JSON, so dependency metadata could not be analyzed.",
          "high", item.path, "Correct the JSON syntax and rerun the project audit."));
    }
  }
];

const AST_JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const UNSAFE_RAW_QUERY_METHODS = new Set(["$queryRawUnsafe", "$executeRawUnsafe"]);

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (value && typeof value === "object") walkAst(value, visit);
  }
}

function staticMemberProperty(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.computed && node.property?.type === "Literal" &&
      typeof node.property.value === "string") return node.property.value;
  return null;
}

function unsafeRawQueryAstFindings(file) {
  let ast;
  try {
    ast = parse(file.content, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowHashBang: true,
      allowReturnOutsideFunction: true
    });
  } catch {
    // Parse coverage is reported by the dedicated AST security analyzer.
    return [];
  }

  const findings = [];
  walkAst(ast, (node) => {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") return;
    const method = staticMemberProperty(node.callee);
    if (!UNSAFE_RAW_QUERY_METHODS.has(method)) return;

    const line = node.loc?.start?.line ?? 1;
    const column = node.loc?.start?.column ?? 0;
    const safePath = file.path.replace(/[^a-z0-9]+/gi, "-");
    findings.push(finding(
      "DB-RAW-AST-" + safePath + "-" + line + "-" + column,
      "Unsafe raw database query API",
      "An unsafe raw-query API was identified from the JavaScript AST. The call requires review because interpolated values can alter SQL structure; this API name alone does not prove that untrusted input reaches it.",
      "high",
      file.path,
      "Prefer parameterized query APIs. If a raw query is unavoidable, keep SQL structure static, bind values separately, and allowlist any dynamic identifiers.",
      {
        requiresManualReview: true,
        parser: "Acorn",
        detection: "AST call-expression sink identification",
        sink: method,
        column
      },
      line
    ));
  });
  return findings;
}

export const databaseRules = [
  {
    id: "database.destructive-sql",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const destructive = /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE(?:\s+TABLE)?)\b/i;
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          if (commentLine(lines[index]) || !destructive.test(lines[index])) continue;
          findings.push(finding("DB-DESTRUCTIVE-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + (index + 1),
            "Potentially destructive database migration",
            "A destructive SQL operation was found. The audit cannot determine whether the operation is intentional or whether data has been backed up.",
            "high", file.path,
            "Review the migration, require an explicit approval, verify backups, and test rollback or recovery procedures.",
            { operationReviewRequired: true }, index + 1));
        }
      }
      return findings;
    }
  },
  {
    id: "database.security-definer",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        for (const statement of sqlStatements(file.content)) {
          if (!/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.test(statement.text) ||
              !/\bSECURITY\s+DEFINER\b/i.test(statement.text)) continue;
          const asMatch = /\bAS\s+(?:\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$|')/i.exec(statement.text);
          const declaration = asMatch ? statement.text.slice(0, asMatch.index) : statement.text;
          if (/\bSET\s+search_path\b/i.test(declaration)) continue;
          const line = statementLine(file.content, statement);
          findings.push(finding("DB-POSTGRES-001-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "SECURITY DEFINER function without an explicit search_path",
            "This SECURITY DEFINER function declaration has no explicit SET search_path before its function body. Another function in the same file does not satisfy this check.",
            "high", file.path,
            "Set a trusted search_path on this function and schema-qualify referenced objects.",
            { database: "postgresql", requiresManualReview: true }, line));
        }
      }
      return findings;
    }
  },
  {
    id: "database.raw-query",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const unsafe = /\\$(?:query|execute)RawUnsafe\\s*\\(/;
      for (const file of context.projectFiles ?? []) {
        const extension = (file.extension || file.path.slice(file.path.lastIndexOf("."))).toLowerCase();
        if (AST_JAVASCRIPT_EXTENSIONS.has(extension)) {
          findings.push(...unsafeRawQueryAstFindings(file));
          continue;
        }

        // TypeScript/TSX remain on a conservative lexical fallback until a
        // TypeScript parser is introduced; their AST coverage is not claimed.
        if (!/\\.[cm]?[jt]sx?$/i.test(file.path)) continue;
        const sourceLines = file.content.split(/\\r\\n|\\n|\\r/);
        for (let index = 0; index < sourceLines.length; index += 1) {
          if (commentLine(sourceLines[index]) || !unsafe.test(sourceLines[index])) continue;
          findings.push(finding(
            "DB-RAW-LEXICAL-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + (index + 1),
            "Unsafe raw database query API",
            "An unsafe raw-query API was found by a line-based fallback because this source language is not parsed by the JavaScript AST rule.",
            "high",
            file.path,
            "Prefer parameterized query APIs and verify that untrusted values cannot alter SQL structure.",
            { requiresManualReview: true, parser: "line-based-fallback", parserCoverage: false },
            index + 1
          ));
        }
      }
      return findings;
    }
  }
];


function sqlStatements(content) {
  const statements = [];
  let start = 0;
  let index = 0;
  let text = "";

  const push = (end) => {
    if (text.trim()) statements.push({ text, offset: start });
    text = "";
    start = end;
  };

  while (index < content.length) {
    if (content.startsWith("--", index)) {
      while (index < content.length && content[index] !== "\n" && content[index] !== "\r") {
        text += " ";
        index += 1;
      }
      continue;
    }

    if (content.startsWith("/*", index)) {
      let depth = 1;
      text += "  ";
      index += 2;
      while (index < content.length && depth > 0) {
        if (content.startsWith("/*", index)) {
          depth += 1;
          text += "  ";
          index += 2;
        } else if (content.startsWith("*/", index)) {
          depth -= 1;
          text += "  ";
          index += 2;
        } else {
          const current = content[index++];
          text += current === "\n" || current === "\r" ? current : " ";
        }
      }
      continue;
    }

    const current = content[index];
    if (current === "'" || current === '"') {
      const quote = current;
      text += current;
      index += 1;
      while (index < content.length) {
        const value = content[index++];
        text += value;
        if (value === quote) {
          if (content[index] === quote) {
            text += content[index++];
            continue;
          }
          break;
        }
        if (value === "\\" && index < content.length) text += content[index++];
      }
      continue;
    }

    if (current === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(content.slice(index))?.[0];
      if (tag) {
        text += tag;
        index += tag.length;
        const closing = content.indexOf(tag, index);
        if (closing < 0) {
          text += content.slice(index);
          index = content.length;
        } else {
          text += content.slice(index, closing + tag.length);
          index = closing + tag.length;
        }
        continue;
      }
    }

    if (current === ";") {
      push(index + 1);
      index += 1;
      continue;
    }

    text += current;
    index += 1;
  }

  push(content.length);
  return statements;
}

function sqlIdentifier(value) {
  return value.trim().replace(/"/g, "").replace(/\s+/g, "").toLowerCase();
}

function sqlColumns(value) {
  return value.split(",").map((part) => {
    const match = part.trim().match(/^"?([A-Za-z_][A-Za-z0-9_$]*)"?/);
    return match?.[1]?.toLowerCase() ?? null;
  }).filter(Boolean);
}

function tableKeyFromStatement(statement) {
  const match = /\b(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:ONLY\s+)?)(("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?)/i.exec(statement);
  return match ? sqlIdentifier(match[1]) : null;
}

function sourceLine(content, offset) {
  return content.slice(0, offset).split(/\r\n|\n|\r/).length;
}

function statementLine(content, statement) {
  const leadingWhitespace = statement.text.match(/^\s*/)?.[0].length ?? 0;
  return sourceLine(content, statement.offset + leadingWhitespace);
}

export const postgresPrismaRules = [
  {
    id: "database.prisma-relation-index",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const modelPattern = /(?:^|\n)[ \t]*model[ \t]+([A-Za-z_]\w*)[ \t]*\{([\s\S]*?)^[ \t]*\}/gm;
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".prisma") continue;
        for (const modelMatch of file.content.matchAll(modelPattern)) {
          const modelName = modelMatch[1];
          const body = modelMatch[2];
          const modelStart = modelMatch.index + modelMatch[0].indexOf("{") + 1;
          const safeBody = body
            .replace(/\/\/[^\r\n]*/g, "")
            .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\r\n]/g, " "));
          const indexed = new Set();
          for (const indexMatch of safeBody.matchAll(/@@(?:index|unique)\s*\(\s*\[([^\]]+)\]/g)) {
            const firstField = indexMatch[1].split(",")[0].trim().match(/^[A-Za-z_]\w*/)?.[0];
            if (firstField) indexed.add(firstField);
          }
          const singleColumnUnique = new Set();
          for (const line of safeBody.split(/\r\n|\n|\r/)) {
            const field = line.match(/^\s*([A-Za-z_]\w*)\s+\S+[^@\r\n]*(?:@id|@unique)\b/);
            if (field) singleColumnUnique.add(field[1]);
          }
          const reported = new Set();
          const relationPattern = /@relation\s*\(([\s\S]*?)\)/g;
          for (const relationMatch of safeBody.matchAll(relationPattern)) {
            const fieldsMatch = relationMatch[1].match(/\bfields\s*:\s*\[([^\]]+)\]/);
            if (!fieldsMatch) continue;
            const foreignKeys = fieldsMatch[1].split(",").map((value) => value.trim()).filter(Boolean);
            for (const foreignKey of foreignKeys) {
              const fieldName = foreignKey.match(/^[A-Za-z_]\w*/)?.[0];
              if (!fieldName || reported.has(fieldName)) continue;
              if (indexed.has(fieldName) || singleColumnUnique.has(fieldName)) continue;
              reported.add(fieldName);
              const absoluteOffset = modelStart + relationMatch.index;
              const line = sourceLine(file.content, absoluteOffset);
              findings.push(finding(
                "DB-PRISMA-INDEX-" + modelName + "-" + fieldName,
                "Prisma relation field may lack a supporting index",
                "Model " + modelName + " uses " + fieldName + " as a relation scalar field, but no single-column unique constraint or index with that field as its leading column was detected.",
                "medium", file.path,
                "Review query patterns and add @@index([" + fieldName + "]) when appropriate. Composite indexes only support lookups efficiently when this field is a leading column.",
                { database: "postgresql", model: modelName, foreignKeyField: fieldName, heuristic: true }, line
              ));
            }
          }
        }
      }
      return findings;
    }
  },
  {
    id: "database.public-broad-grants",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        for (const statement of sqlStatements(file.content)) {
          const broadAll = /\bGRANT\s+ALL(?:\s+PRIVILEGES)?\b[\s\S]*?\bTO\s+PUBLIC\b/i.test(statement.text);
          const schemaCreate = /\bGRANT\s+CREATE\s+ON\s+SCHEMA\b[\s\S]*?\bTO\s+PUBLIC\b/i.test(statement.text);
          if (!broadAll && !schemaCreate) continue;
          const line = statementLine(file.content, statement);
          findings.push(finding(
            "DB-PUBLIC-GRANT-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "Broad PostgreSQL privileges granted to PUBLIC",
            "A SQL grant gives all privileges or schema creation rights to the PUBLIC role, potentially exposing database capabilities to every database role.",
            "high", file.path,
            "Restrict the grant to the minimum required application or maintenance role and verify the effective privileges after migration.",
            { database: "postgresql", grantee: "PUBLIC", requiresManualReview: true }, line
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "database.privileged-role-attributes",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const privileged = /\b(?:SUPERUSER|BYPASSRLS|CREATEROLE|REPLICATION)\b/i;
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        for (const statement of sqlStatements(file.content)) {
          if (!/\b(?:CREATE|ALTER)\s+(?:ROLE|USER)\b/i.test(statement.text) || !privileged.test(statement.text)) continue;
          const line = statementLine(file.content, statement);
          findings.push(finding(
            "DB-PRIVILEGED-ROLE-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "Privileged PostgreSQL role attribute detected",
            "A role definition changes a high-privilege attribute such as SUPERUSER, BYPASSRLS, CREATEROLE, or REPLICATION.",
            "high", file.path,
            "Verify that the role is a tightly controlled administrative identity and that application runtime roles do not receive unnecessary elevated attributes.",
            { database: "postgresql", requiresManualReview: true }, line
          ));
        }
      }
      return findings;
    }
  }
];

export const postgresMigrationRules = [
  {
    id: "database.foreign-key-index",
    specialist: "database",
    evaluate(context) {
      const sqlFiles = (context.projectFiles ?? []).filter((file) => file.extension === ".sql");
      const statements = sqlFiles.flatMap((file) =>
        sqlStatements(file.content).map((statement) => ({ ...statement, file })));
      const indexes = [];

      for (const item of statements) {
        const createIndex = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(?:ONLY\s+)?(("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?)\s*(?:USING\s+\w+\s*)?\(([^)]+)\)/i.exec(item.text);
        if (createIndex) {
          indexes.push({ table: sqlIdentifier(createIndex[1]), columns: sqlColumns(createIndex[4]) });
        }

        const table = tableKeyFromStatement(item.text);
        if (!table) continue;
        if (/^\s*CREATE\s+TABLE\b/i.test(item.text)) {
          for (const constraint of item.text.matchAll(/\b(?:PRIMARY\s+KEY|UNIQUE)\s*\(([^)]+)\)/gi)) {
            indexes.push({ table, columns: sqlColumns(constraint[1]) });
          }
        } else if (/^\s*ALTER\s+TABLE\b/i.test(item.text)) {
          for (const constraint of item.text.matchAll(/\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|UNIQUE)\s*\(([^)]+)\)/gi)) {
            indexes.push({ table, columns: sqlColumns(constraint[1]) });
          }
        }
      }

      const findings = [];
      for (const item of statements) {
        const table = tableKeyFromStatement(item.text);
        if (!table || !/^\s*(?:CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(item.text)) continue;
        const foreignKeys = [...item.text.matchAll(/\bFOREIGN\s+KEY\s*\(([^)]+)\)/gi)]
          .map((match) => ({ columns: sqlColumns(match[1]), offset: match.index }));
        if (/^\s*CREATE\s+TABLE\b/i.test(item.text)) {
          for (const match of item.text.matchAll(/^[ \t]*(?!(?:CONSTRAINT|FOREIGN|PRIMARY|UNIQUE|CHECK)\b)("?[\w$]+"?)[ \t]+[^,\r\n]*\bREFERENCES\b/gim)) {
            foreignKeys.push({ columns: sqlColumns(match[1]), offset: match.index });
          }
        }

        for (const foreignKey of foreignKeys) {
          const columns = foreignKey.columns;
          if (!columns.length) continue;
          const indexed = indexes.some((index) =>
            index.table === table &&
            index.columns.length >= columns.length &&
            columns.every((column, position) => index.columns[position] === column));
          if (indexed) continue;

          const line = sourceLine(item.file.content, item.offset + foreignKey.offset);
          findings.push(finding(
            "DB-FK-INDEX-" + item.file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "Foreign key may lack a supporting index",
            "The referencing columns (" + columns.join(", ") + ") have no matching index with the same leading column order among the scanned SQL files. PostgreSQL does not automatically create an index on referencing columns.",
            "medium", item.file.path,
            "Review join and delete/update patterns; add an index on the referencing columns in the same order when query workload and write costs justify it.",
            { database: "postgresql", table, foreignKeyColumns: columns, heuristic: true }, line
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "database.concurrent-index-transaction",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        const statements = sqlStatements(file.content);
        const hasExplicitTransaction = statements.some((item) =>
          /^\s*(?:BEGIN|START\s+TRANSACTION)\b/i.test(item.text));
        if (!hasExplicitTransaction) continue;

        for (const statement of statements) {
          if (!/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement.text)) continue;
          const line = statementLine(file.content, statement);
          findings.push(finding(
            "DB-CONCURRENT-INDEX-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "CREATE INDEX CONCURRENTLY appears inside an explicit transaction",
            "PostgreSQL does not allow CREATE INDEX CONCURRENTLY to run inside a transaction block, while this migration file contains an explicit transaction boundary.",
            "high", file.path,
            "Move the concurrent index operation into a migration step that runs outside a transaction, or use a regular index build only when the locking impact is acceptable.",
            { database: "postgresql", requiresMigrationReview: true }, line
          ));
        }
      }
      return findings;
    }
  }
];

export const projectRules = Object.freeze([
  ...codeQualityRules, ...securityRules, ...dependencyRules, ...databaseRules, ...postgresPrismaRules,
  ...postgresMigrationRules
]);
