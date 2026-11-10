import path from "node:path";
import { parse } from "acorn";

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const INDEX_NAMES = new Set(["index.js", "index.mjs", "index.cjs"]);

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value === "object") {
      walk(value, visit);
    }
  }
}

function identifierNames(pattern, output = []) {
  if (!pattern) return output;
  if (pattern.type === "Identifier") output.push(pattern.name);
  else if (pattern.type === "RestElement") identifierNames(pattern.argument, output);
  else if (pattern.type === "AssignmentPattern") identifierNames(pattern.left, output);
  else if (pattern.type === "ArrayPattern") {
    for (const item of pattern.elements) identifierNames(item, output);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      identifierNames(property.type === "RestElement" ? property.argument : property.value, output);
    }
  }
  return output;
}

function declarationNames(declaration) {
  if (!declaration) return [];
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.flatMap((item) => identifierNames(item.id));
  }
  if (["FunctionDeclaration", "ClassDeclaration"].includes(declaration.type) && declaration.id) {
    return [declaration.id.name];
  }
  return [];
}

function literalModuleSource(node) {
  return node && (node.type === "Literal" || node.type === "StringLiteral") &&
    typeof node.value === "string" ? node.value : null;
}

function resolveRelativeModule(importerPath, specifier, files) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
  const candidates = [joined];
  if (!path.posix.extname(joined)) {
    for (const extension of [".js", ".mjs", ".cjs"]) candidates.push(joined + extension);
    for (const extension of [".js", ".mjs", ".cjs"]) candidates.push(path.posix.join(joined, "index" + extension));
  }
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function packageEntrypoints(manifests) {
  const entrypoints = new Set();
  const addTarget = (manifestPath, target) => {
    if (typeof target !== "string" || !target.startsWith("./")) return;
    const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(manifestPath), target));
    entrypoints.add(candidate);
  };
  const visitTargets = (manifestPath, value) => {
    if (typeof value === "string") addTarget(manifestPath, value);
    else if (Array.isArray(value)) value.forEach((item) => visitTargets(manifestPath, item));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => visitTargets(manifestPath, item));
  };

  for (const manifest of manifests ?? []) {
    if (!manifest.data || manifest.parseError) continue;
    for (const key of ["main", "module", "browser"]) addTarget(manifest.path, manifest.data[key]);
    if (manifest.data.exports !== undefined) visitTargets(manifest.path, manifest.data.exports);
  }
  return entrypoints;
}

function exportedDeclarations(ast) {
  const exports = new Map();
  const add = (name, node) => {
    if (typeof name === "string" && name) exports.set(name, node);
  };
  for (const node of ast.body ?? []) {
    if (node.type === "ExportDefaultDeclaration") {
      add("default", node);
    } else if (node.type === "ExportNamedDeclaration") {
      for (const name of declarationNames(node.declaration)) add(name, node.declaration);
      for (const specifier of node.specifiers ?? []) {
        const exported = specifier.exported?.name ?? specifier.exported?.value;
        if (!node.source) add(exported, specifier);
      }
    }
  }
  return exports;
}

function analyzeModule(file) {
  const ast = parse(file.content, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  const exports = exportedDeclarations(ast);
  const references = [];
  let dynamicModuleReference = false;
  let commonJsBoundary = false;
  let reExportsAll = false;

  walk(ast, (node) => {
    if (node.type === "ExportAllDeclaration") {
      reExportsAll = true;
      references.push({ source: literalModuleSource(node.source), names: null, all: true });
    } else if (node.type === "ExportNamedDeclaration" && node.source) {
      references.push({
        source: literalModuleSource(node.source),
        names: (node.specifiers ?? []).map((item) => item.local?.name ?? item.local?.value).filter(Boolean),
        all: false
      });
    } else if (node.type === "ImportDeclaration") {
      const names = (node.specifiers ?? []).map((item) => {
        if (item.type === "ImportDefaultSpecifier") return "default";
        if (item.type === "ImportSpecifier") return item.imported?.name ?? item.imported?.value;
        return null;
      }).filter(Boolean);
      references.push({ source: literalModuleSource(node.source), names, all: (node.specifiers ?? []).some((item) => item.type === "ImportNamespaceSpecifier") });
    } else if (node.type === "ImportExpression") {
      const source = literalModuleSource(node.source);
      if (source === null) dynamicModuleReference = true;
      else references.push({ source, names: null, all: true });
    } else if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") {
      const source = literalModuleSource(node.arguments?.[0]);
      if (source === null) dynamicModuleReference = true;
      else references.push({ source, names: null, all: true });
    } else if (node.type === "MemberExpression" && node.object?.type === "Identifier" &&
        (node.object.name === "exports" || (node.object.name === "module" && (node.property?.name === "exports" || node.property?.value === "exports")))) {
      commonJsBoundary = true;
    }
  });

  return { exports, references, dynamicModuleReference, commonJsBoundary, reExportsAll };
}

export const deadCodeRules = Object.freeze([
  {
    id: "code-quality.possibly-unused-exports",
    specialist: "code-quality",
    evaluate(context) {
      const files = new Map((context.projectFiles ?? [])
        .filter((file) => JS_EXTENSIONS.has(file.extension))
        .map((file) => [file.path, file]));
      const manifests = context.packageManifests ?? [];
      const entrypoints = packageEntrypoints(manifests);
      const modules = new Map();
      const parseSkipped = [];
      let dynamicResolutionPresent = false;

      for (const [modulePath, file] of files) {
        try {
          const analysis = analyzeModule(file);
          modules.set(modulePath, analysis);
          if (analysis.dynamicModuleReference) dynamicResolutionPresent = true;
        } catch {
          parseSkipped.push(modulePath);
        }
      }

      if (dynamicResolutionPresent) {
        return [{
          id: "CODE-DEAD-EXPORT-ANALYSIS-SKIPPED",
          title: "Unused-export analysis skipped because dynamic module loading is present",
          description: "At least one non-literal import() or require() prevents a reliable static module graph. No exports were labelled unused.",
          severity: "info",
          location: ".",
          recommendation: "Provide literal module specifiers where practical, or review export reachability manually.",
          evidence: { dynamicModuleLoadingDetected: true },
          metadata: { detector: "static-module-graph", confidence: "coverage-warning" }
        }];
      }
      const usedExports = new Map();
      for (const modulePath of files.keys()) usedExports.set(modulePath, new Set());
      for (const [importerPath, analysis] of modules) {
        for (const reference of analysis.references) {
          const target = resolveRelativeModule(importerPath, reference.source, files);
          if (!target) continue;
          const targetAnalysis = modules.get(target);
          if (!targetAnalysis) continue;
          const used = usedExports.get(target);
          if (reference.all) {
            for (const name of targetAnalysis.exports.keys()) used.add(name);
          } else {
            for (const name of reference.names ?? []) if (targetAnalysis.exports.has(name)) used.add(name);
          }
        }
      }

      const findings = [];
      if (parseSkipped.length) {
        findings.push({
          id: "CODE-DEAD-EXPORT-PARSE-SKIPPED",
          title: "Some modules could not be parsed for export reachability",
          description: parseSkipped.length + " JavaScript module(s) could not be parsed, so their exports were not assessed.",
          severity: "info",
          location: parseSkipped.slice(0, 8).join(", "),
          recommendation: "Resolve parse errors or use a compatible parser before treating export reachability as complete.",
          evidence: { parseSkippedCount: parseSkipped.length, paths: parseSkipped.slice(0, 20) },
          metadata: { detector: "static-module-graph", confidence: "coverage-warning" }
        });
      }
      for (const [modulePath, analysis] of modules) {
        if (!analysis.exports.size || analysis.commonJsBoundary || analysis.reExportsAll ||
            INDEX_NAMES.has(path.posix.basename(modulePath)) || entrypoints.has(modulePath)) continue;
        for (const [name, node] of analysis.exports) {
          if (usedExports.get(modulePath)?.has(name)) continue;
          const line = node.loc?.start?.line ?? 1;
          const slug = modulePath.replace(/[^a-z0-9]+/gi, "-");
          findings.push({
            id: "CODE-DEAD-EXPORT-" + slug + "-" + name.replace(/[^a-z0-9]+/gi, "-"),
            title: "Export has no statically resolved in-repository importer",
            description: "No statically resolvable import or re-export inside the scanned project references export " + name + ". External consumers, framework conventions, dynamic loading, reflection, and runtime entrypoints may use it; this is a review candidate, not proof of dead code.",
            severity: "info",
            location: modulePath + ":" + line,
            recommendation: "Check package entrypoints, dynamic imports, framework conventions, and external consumers before removing this export. If it is intentionally public, document that contract.",
            evidence: { path: modulePath, exportName: name, staticallyResolvedImporters: 0 },
            metadata: { detector: "static-module-graph", confidence: "review-only", safeToDeleteAutomatically: false }
          });
        }
      }
      return findings;
    }
  }
]);