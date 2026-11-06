import { parse } from "acorn";

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const UNSUPPORTED_CODE_EXTENSIONS = new Set([".jsx", ".ts", ".tsx", ".vue", ".svelte"]);

function slug(value) {
  return String(value).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function memberPath(node) {
  const parts = [];
  let current = node;
  while (current?.type === "MemberExpression") {
    const part = current.computed
      ? (current.property?.type === "Literal" ? String(current.property.value) : null)
      : current.property?.name;
    if (!part) return null;
    parts.unshift(part);
    current = current.object;
  }
  if (current?.type !== "Identifier") return null;
  parts.unshift(current.name);
  return parts;
}

function isRequestSource(node) {
  const parts = memberPath(node);
  if (!parts) return false;
  const joined = parts.join(".").toLowerCase();
  return (
    /^(?:req|request)\.(?:query|body|params|headers|cookies)(?:\.|$)/.test(joined) ||
    /^(?:ctx|context)\.request\.(?:query|body|params|headers|cookies)(?:\.|$)/.test(joined)
  );
}

function propertyName(node) {
  if (!node) return null;
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.computed && node.property?.type === "Literal") return String(node.property.value);
  return null;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (value && typeof value === "object") walk(value, visit);
  }
}

function expressionIsTainted(node, tainted, taintedMembers = new Set()) {
  if (!node || typeof node !== "object") return false;
  if (isRequestSource(node)) return true;
  switch (node.type) {
    case "Identifier":
      return tainted.has(node.name);
    case "MemberExpression": {
      const parts = memberPath(node);
      if (parts) {
        for (let index = 1; index <= parts.length; index += 1) {
          if (taintedMembers.has(parts.slice(0, index).join("."))) return true;
        }
      }
      return expressionIsTainted(node.object, tainted, taintedMembers);
    }
    case "TemplateLiteral":
      return node.expressions.some((item) => expressionIsTainted(item, tainted, taintedMembers));
    case "BinaryExpression":
    case "LogicalExpression":
      return expressionIsTainted(node.left, tainted, taintedMembers) || expressionIsTainted(node.right, tainted, taintedMembers);
    case "ConditionalExpression":
      return expressionIsTainted(node.test, tainted, taintedMembers) ||
        expressionIsTainted(node.consequent, tainted, taintedMembers) ||
        expressionIsTainted(node.alternate, tainted, taintedMembers);
    case "AssignmentExpression":
      return expressionIsTainted(node.right, tainted, taintedMembers);
    case "SequenceExpression":
      return node.expressions.some((item) => expressionIsTainted(item, tainted, taintedMembers));
    case "ArrayExpression":
      return node.elements.some((item) => expressionIsTainted(item, tainted, taintedMembers));
    case "ObjectExpression":
      return node.properties.some((item) => expressionIsTainted(item.value ?? item.argument, tainted, taintedMembers));
    case "CallExpression":
    case "NewExpression":
      return node.arguments.some((item) => expressionIsTainted(item, tainted, taintedMembers));
    case "AwaitExpression":
    case "UnaryExpression":
    case "UpdateExpression":
      return expressionIsTainted(node.argument, tainted, taintedMembers);
    case "ChainExpression":
      return expressionIsTainted(node.expression, tainted, taintedMembers);
    default:
      return false;
  }
}

function callName(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return memberPath(node)?.join(".") ?? "";
  return "";
}

function patternIdentifiers(pattern) {
  if (!pattern || typeof pattern !== "object") return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return patternIdentifiers(pattern.argument);
  if (pattern.type === "AssignmentPattern") return patternIdentifiers(pattern.left);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(patternIdentifiers);
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      property.type === "RestElement" ? patternIdentifiers(property.argument) : patternIdentifiers(property.value)
    );
  }
  return [];
}

function makeFinding(file, node, kind, title, description, recommendation, severity = "high", metadata = {}) {
  const line = node.loc?.start?.line ?? null;
  return {
    id: "AST-" + kind + "-" + slug(file.path) + "-" + (line ?? 0),
    title,
    description,
    severity,
    location: line ? file.path + ":" + line : file.path,
    recommendation,
    evidence: { path: file.path, line },
    metadata: {
      detector: "ast-taint-analysis",
      analysis: "intra-file variable alias tracking",
      requiresManualReview: true,
      ...metadata
    }
  };
}

function analyzeFile(file) {
  if (!JS_EXTENSIONS.has(file.extension)) return [];
  let ast;
  try {
    ast = parse(file.content, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowHashBang: true,
      allowReturnOutsideFunction: true
    });
  } catch (error) {
    return [makeFinding(
      file,
      { loc: { start: { line: error.loc?.line ?? 1 } } },
      "PARSE",
      "AST analysis could not parse this JavaScript file",
      "The parser skipped this file, so AST-based data-flow checks were not applied. Syntax extensions or unsupported source forms may be present.",
      "Confirm the file uses supported standard JavaScript syntax or add a parser for its language before treating the analysis as complete.",
      "low",
      { parserError: String(error.message).slice(0, 160) }
    )];
  }

  const tainted = new Set();
  const taintedMembers = new Set();
  let declarationCount = 0;
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" || node.type === "AssignmentExpression") declarationCount += 1;
  });
  const maxPasses = Math.min(128, Math.max(8, declarationCount + 1));
  let taintStillChanging = false;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    walk(ast, (node) => {
      if (node.type === "VariableDeclarator" &&
          expressionIsTainted(node.init, tainted, taintedMembers)) {
        for (const name of patternIdentifiers(node.id)) {
          if (!tainted.has(name)) {
            tainted.add(name);
            changed = true;
          }
        }
      }
      if (node.type === "AssignmentExpression" &&
          expressionIsTainted(node.right, tainted, taintedMembers)) {
        if (node.left?.type === "Identifier" && !tainted.has(node.left.name)) {
          tainted.add(node.left.name);
          changed = true;
        } else if (node.left?.type === "MemberExpression") {
          const parts = memberPath(node.left);
          if (parts) {
            const key = parts.join(".");
            if (!taintedMembers.has(key)) {
              taintedMembers.add(key);
              changed = true;
            }
          }
        }
      }
    });
    taintStillChanging = changed;
    if (!changed) break;
  }

  const findings = [];
  const seen = new Set();
  const add = (finding) => {
    if (seen.has(finding.id)) return;
    seen.add(finding.id);
    findings.push(finding);
  };

  walk(ast, (node) => {
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const name = callName(node.callee);
      const first = node.arguments?.[0];
      const firstTainted = expressionIsTainted(first, tainted, taintedMembers);
      const second = node.arguments?.[1];
      const secondTainted = expressionIsTainted(second, tainted, taintedMembers);
      const anyArgumentTainted = node.arguments.some((argument) => expressionIsTainted(argument, tainted, taintedMembers));

      if (name.endsWith(".insertAdjacentHTML") && secondTainted) {
        add(makeFinding(
          file, node, "DOM-XSS", "Request-controlled data reaches an HTML insertion sink",
          "A request-derived value flows into insertAdjacentHTML, which parses the value as markup and may enable DOM-based cross-site scripting.",
          "Use textContent or a maintained HTML sanitizer with a restrictive allowlist when rich HTML is required.",
          "high",
          { sink: name }
        ));
      } else if (firstTainted && !isRequestSource(first) && /^(?:fetch|axios\.(?:get|post|put|patch|delete|request)|got|request|http\.request|https\.request|http\.(?:get|post)|https\.(?:get|post)|WebSocket)$/.test(name)) {
        add(makeFinding(
          file, node, "SSRF", "Request-controlled data reaches an outbound HTTP client",
          "A value originating from request query, body, route, header, or cookie data reaches an outbound HTTP request through a direct expression or variable alias. This may permit server-side request forgery.",
          "Validate destinations against a strict hostname allowlist, resolve and reject private/link-local IP ranges, re-check every redirect, and constrain protocols and ports.",
          "critical",
          { sink: name, taintedVariables: [...tainted].slice(0, 12) }
        ));
      } else if (firstTainted && !isRequestSource(first) && (name === "redirect" || name.endsWith(".redirect"))) {
        add(makeFinding(
          file, node, "REDIRECT", "Request-controlled data reaches a redirect sink",
          "A value derived from request input flows through a variable into a redirect destination, which may enable an open redirect.",
          "Resolve redirects only to approved relative paths or explicitly allowlisted origins; reject arbitrary absolute URLs.",
          "high",
          { sink: name, taintedVariables: [...tainted].slice(0, 12) }
        ));
      } else if (anyArgumentTainted && /^(?:eval|Function|vm\.runInNewContext|vm\.runInThisContext|runInNewContext|runInThisContext)$/.test(name)) {
        add(makeFinding(
          file, node, "CODE", "Request-controlled data reaches dynamic code execution",
          "A value derived from request input reaches eval or the Function constructor. This can enable arbitrary code execution.",
          "Remove dynamic code evaluation. Use explicit parsers, fixed dispatch tables, and validated data structures instead.",
          "critical",
          { sink: name }
        ));
      } else if (firstTainted && /^(?:open|readFile|readFileSync|createReadStream|writeFile|writeFileSync|unlink|unlinkSync|rm|rmSync)$/.test(name.split(".").at(-1))) {
        add(makeFinding(
          file, node, "PATH", "Request-controlled data reaches a filesystem path operation",
          "A value derived from request input reaches a filesystem path argument. Without strict path confinement this may permit path traversal or unauthorized file access.",
          "Resolve paths against a fixed trusted root, reject traversal and symlink escapes, and enforce authorization independently of the requested filename.",
          "high",
          { sink: name }
        ));
      } else if (anyArgumentTainted && /^(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|child_process\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync))$/.test(name)) {
        add(makeFinding(
          file, node, "COMMAND", "Request-controlled data reaches a process execution sink",
          "A value derived from request input reaches a process execution API. Shell interpretation can turn this into command injection.",
          "Avoid shell command construction. Prefer fixed executables with separately validated argument arrays and shell disabled.",
          "critical",
          { sink: name }
        ));
      } else if (firstTainted && /^(?:query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe)$/.test(name.split(".").at(-1))) {
        add(makeFinding(
          file, node, "SQL", "Request-controlled data reaches a database query string",
          "A request-derived value flows into a query-like API. If it is interpolated into SQL rather than passed as a bound parameter, SQL injection may result.",
          "Use parameterized queries or prepared statements. Keep values separate from SQL syntax and allowlist identifiers that cannot be bound.",
          "high",
          { sink: name, reviewRequired: "confirm parameterized binding" }
        ));
      }
    }

    if (node.type === "AssignmentExpression" && node.left?.type === "MemberExpression") {
      const property = propertyName(node.left);
      if (["innerHTML", "outerHTML"].includes(property) &&
          expressionIsTainted(node.right, tainted, taintedMembers)) {
        add(makeFinding(
          file, node, "DOM-XSS", "Request-controlled data is assigned to an HTML DOM sink",
          "A request-derived value flows through a variable into innerHTML or outerHTML, where it is interpreted as markup.",
          "Use textContent for text, or sanitize rich HTML with a maintained library and a strict allowlist.",
          "high",
          { sink: property }
        ));
      }
    }
  });

  if (taintStillChanging) {
    add(makeFinding(
      file,
      { loc: { start: { line: 1 } } },
      "TAINT-LIMIT",
      "AST data-flow propagation reached its safety limit",
      "The analyzer stopped alias propagation at its configured pass limit. This file may contain additional tainted flows that were not resolved.",
      "Split complex data flows into clearer local assignments or extend the analyzer's bounded propagation strategy; do not treat this file as fully covered.",
      "low",
      { maxPasses, taintedIdentifierCount: tainted.size, taintedMemberCount: taintedMembers.size }
    ));
  }

  return findings;
}

export const astSecurityRules = Object.freeze([{
  id: "security.ast-taint-analysis",
  specialist: "security",
  evaluate(context) {
    const findings = [];
    for (const file of context.projectFiles ?? []) {
      if (JS_EXTENSIONS.has(file.extension)) {
        findings.push(...analyzeFile(file));
      } else if (UNSUPPORTED_CODE_EXTENSIONS.has(file.extension)) {
        findings.push(makeFinding(
          file,
          { loc: { start: { line: 1 } } },
          "UNSUPPORTED",
          "AST data-flow analysis does not support this source language",
          "This code file was included in the project scan but is not parsed by the JavaScript AST analyzer.",
          "Add a language-specific parser and data-flow rules before treating this file as covered by AST security analysis.",
          "low",
          { extension: file.extension, parserCoverage: false }
        ));
      }
    }
    return findings;
  }
}]);
