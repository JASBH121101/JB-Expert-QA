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
      references.push({ source: literalModuleSource(node.source), names: null, all: true, line: node.loc?.start?.line ?? 1 });
    } else if (node.type === "ExportNamedDeclaration" && node.source) {
      references.push({
        source: literalModuleSource(node.source),
        names: (node.specifiers ?? []).map((item) => item.local?.name ?? item.local?.value).filter(Boolean),
        all: false,
        line: node.loc?.start?.line ?? 1
      });
    } else if (node.type === "ImportDeclaration") {
      const names = (node.specifiers ?? []).map((item) => {
        if (item.type === "ImportDefaultSpecifier") return "default";
        if (item.type === "ImportSpecifier") return item.imported?.name ?? item.imported?.value;
        return null;
      }).filter(Boolean);
      references.push({ source: literalModuleSource(node.source), names, all: (node.specifiers ?? []).some((item) => item.type === "ImportNamespaceSpecifier"), line: node.loc?.start?.line ?? 1 });
    } else if (node.type === "ImportExpression") {
      const source = literalModuleSource(node.source);
      if (source === null) dynamicModuleReference = true;
      else references.push({ source, names: null, all: true, line: node.loc?.start?.line ?? 1 });
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


function walkWithParents(node, visit, parent = null, grandparent = null) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parent, grandparent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const child of value) walkWithParents(child, visit, node, parent);
    else if (value && typeof value === "object") walkWithParents(value, visit, node, parent);
  }
}
function collectPatternNodes(pattern, output = []) {
  if (!pattern) return output;
  if (pattern.type === "Identifier") output.push(pattern);
  else if (pattern.type === "RestElement") collectPatternNodes(pattern.argument, output);
  else if (pattern.type === "AssignmentPattern") collectPatternNodes(pattern.left, output);
  else if (pattern.type === "ArrayPattern") for (const item of pattern.elements) collectPatternNodes(item, output);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) collectPatternNodes(property.type === "RestElement" ? property.argument : property.value, output);
  return output;
}
function isNonReferenceIdentifier(node, parent, declarationNodes, parameterNodes) {
  if (declarationNodes.has(node) || parameterNodes.has(node) || !parent) return true;
  if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(parent.type)) return true;
  if (parent.type === "ExportSpecifier" && node === parent.exported) return true;
  if (parent.type === "MemberExpression" && node === parent.property && !parent.computed) return true;
  if (parent.type === "Property" && node === parent.key && !parent.computed && !parent.shorthand) return true;
  if (parent.type === "MethodDefinition" && node === parent.key && !parent.computed) return true;
  if (parent.type === "PropertyDefinition" && node === parent.key && !parent.computed) return true;
  if (parent.type === "LabeledStatement" && node === parent.label) return true;
  if ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") && node === parent.label) return true;
  if (parent.type === "MetaProperty") return true;
  if (parent.type === "AssignmentExpression" && parent.left === node && parent.operator === "=") return true;
  if ((parent.type === "ForInStatement" || parent.type === "ForOfStatement") && parent.left === node) return true;
  return false;
}
function analyzeLocalBindings(file) {
  const ast = parse(file.content, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  const bindings = [];
  const declarationNodes = new Set();
  const parameterNodes = new Set();
  let dynamicScope = false;
  walkWithParents(ast, (node, parent, grandparent) => {
    if (node.type === "WithStatement" || (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "eval")) dynamicScope = true;
    if (node.type === "VariableDeclarator") for (const identifier of collectPatternNodes(node.id)) {
      declarationNodes.add(identifier);
      bindings.push({ name: identifier.name, node: identifier, kind: grandparent?.kind ?? "variable", exported: grandparent?.type === "ExportNamedDeclaration", imported: false });
    }
    if (parent?.type === "ImportDeclaration") {
      const local = node.type === "ImportSpecifier" ? node.local : ["ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(node.type) ? node.local : null;
      if (local?.type === "Identifier") {
        declarationNodes.add(local);
        bindings.push({ name: local.name, node: local, kind: "import", exported: false, imported: true });
      }
    }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      if (node.id?.type === "Identifier") parameterNodes.add(node.id);
      for (const parameter of node.params ?? []) for (const id of collectPatternNodes(parameter)) parameterNodes.add(id);
    }
    if (node.type === "CatchClause") for (const id of collectPatternNodes(node.param)) parameterNodes.add(id);
    if (["ClassDeclaration", "ClassExpression"].includes(node.type) && node.id?.type === "Identifier") parameterNodes.add(node.id);
  });
  if (dynamicScope) return { findings: [], skipped: true };
  const declarationsByName = new Map();
  for (const binding of bindings) {
    const list = declarationsByName.get(binding.name) ?? [];
    list.push(binding);
    declarationsByName.set(binding.name, list);
  }
  const readsByName = new Map();
  walkWithParents(ast, (node, parent) => {
    if (node.type !== "Identifier" || isNonReferenceIdentifier(node, parent, declarationNodes, parameterNodes)) return;
    readsByName.set(node.name, (readsByName.get(node.name) ?? 0) + 1);
  });
  const findings = [];
  for (const [name, declared] of declarationsByName) {
    if (declared.length !== 1 || name.startsWith("_") || (readsByName.get(name) ?? 0) > 0) continue;
    const binding = declared[0];
    if (binding.exported) continue;
    const line = binding.node.loc?.start?.line ?? 1;
    const slug = file.path.replace(/[^a-z0-9]+/gi, "-");
    findings.push({
      id: "CODE-DEAD-" + (binding.imported ? "IMPORT-" : "BINDING-") + slug + "-" + name.replace(/[^a-z0-9]+/gi, "-"),
      title: binding.imported ? "Imported binding has no static references" : "Local binding has no static reads",
      description: binding.imported ? "The imported local name " + name + " has no statically observed reads in this file. Side-effect behavior and framework conventions require manual review." : "The local binding " + name + " has no statically observed reads in this file. Its initializer may still have side effects; this is not proof that the declaration can be deleted.",
      severity: "info",
      location: file.path + ":" + line,
      recommendation: binding.imported ? "Confirm the import is not required by a build-time or framework convention before removing only the unused binding." : "Review the binding and initializer. Preserve required side effects and verify relevant tests before editing.",
      evidence: { path: file.path, bindingName: name, bindingKind: binding.kind, staticallyObservedReads: 0 },
      metadata: { detector: "conservative-identifier-reference-count", confidence: "review-only", lexicalScopeResolution: "duplicate-name declarations skipped", safeToDeleteAutomatically: false, bindingType: binding.imported ? "import" : "binding" }
    });
  }
  return { findings, skipped: false };
}
function walkWithAncestors(node, visit, ancestors = []) {
  if (!node || typeof node !== "object") return;
  const parent = ancestors.length ? ancestors[ancestors.length - 1] : null;
  if (typeof node.type === "string") visit(node, parent, ancestors);
  const next = typeof node.type === "string" ? [...ancestors, node] : ancestors;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const child of value) walkWithAncestors(child, visit, next);
    else if (value && typeof value === "object") walkWithAncestors(value, visit, next);
  }
}

function analyzeUnusedFunctionsAndClasses(file) {
  const ast = parse(file.content, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  const candidates = [];
  const declarationNodes = new Set();
  const parameterNodes = new Set();
  const boundCounts = new Map();
  let dynamicScope = false;
  const addBinding = (identifier) => {
    if (!identifier || identifier.type !== "Identifier" || declarationNodes.has(identifier)) return;
    declarationNodes.add(identifier);
    boundCounts.set(identifier.name, (boundCounts.get(identifier.name) ?? 0) + 1);
  };

  walkWithParents(ast, (node, parent) => {
    if (node.type === "WithStatement" ||
        (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "eval")) dynamicScope = true;
    if (node.type === "VariableDeclarator") {
      for (const identifier of collectPatternNodes(node.id)) addBinding(identifier);
    }
    if (parent?.type === "ImportDeclaration") {
      const local = node.type === "ImportSpecifier" ? node.local :
        ["ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(node.type) ? node.local : null;
      if (local?.type === "Identifier") addBinding(local);
    }
    if (["FunctionDeclaration", "FunctionExpression"].includes(node.type)) {
      if (node.id?.type === "Identifier") {
        addBinding(node.id);
        parameterNodes.add(node.id);
      }
      for (const parameter of node.params ?? []) {
        for (const identifier of collectPatternNodes(parameter)) {
          addBinding(identifier);
          parameterNodes.add(identifier);
        }
      }
      if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
        candidates.push({ name: node.id.name, node: node.id, declaration: node, parent });
      }
    }
    if (["ClassDeclaration", "ClassExpression"].includes(node.type) && node.id?.type === "Identifier") {
      addBinding(node.id);
      if (node.type === "ClassDeclaration") candidates.push({ name: node.id.name, node: node.id, declaration: node, parent });
    }
    if (node.type === "CatchClause") {
      for (const identifier of collectPatternNodes(node.param)) {
        addBinding(identifier);
        parameterNodes.add(identifier);
      }
    }
  });

  if (dynamicScope) return { findings: [], skipped: true };
  const findings = [];
  for (const candidate of candidates) {
    if (candidate.name.startsWith("_") || (boundCounts.get(candidate.name) ?? 0) !== 1) continue;
    if (candidate.parent?.type === "ExportNamedDeclaration" ||
        candidate.parent?.type === "ExportDefaultDeclaration") continue;

    let referencedOutsideDeclaration = false;
    walkWithAncestors(ast, (node, parent, ancestors) => {
      if (referencedOutsideDeclaration || node.type !== "Identifier" || node.name !== candidate.name) return;
      if (node === candidate.node || ancestors.includes(candidate.declaration)) return;
      if (!isNonReferenceIdentifier(node, parent, declarationNodes, parameterNodes)) referencedOutsideDeclaration = true;
    });
    if (referencedOutsideDeclaration) continue;

    const line = candidate.node.loc?.start?.line ?? 1;
    const slug = file.path.replace(/[^a-z0-9]+/gi, "-");
    findings.push({
      id: "CODE-DEAD-DECLARATION-" + slug + "-" + candidate.name.replace(/[^a-z0-9]+/gi, "-"),
      title: "Function or class declaration has no static external references",
      description: "The " + (candidate.declaration.type === "ClassDeclaration" ? "class " : "function ") +
        candidate.name + " has no statically observed references outside its own declaration. Reflection, string-based lookup, framework registration, and external consumers may still use it.",
      severity: "info",
      location: file.path + ":" + line,
      recommendation: "Check framework registration, reflection, external entrypoints, and runtime behavior before removing this declaration.",
      evidence: { path: file.path, declarationName: candidate.name, declarationKind: candidate.declaration.type, staticallyObservedExternalReferences: 0 },
      metadata: { detector: "conservative-function-class-reference-check", confidence: "review-only", lexicalScopeResolution: "duplicate binding names skipped", safeToDeleteAutomatically: false }
    });
  }
  return { findings, skipped: false };
}

const RESOLUTION_EXTENSIONS = [
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".css", ".scss",
  ".sass", ".less", ".vue", ".svelte", ".html", ".htm"
];

function candidateModulePaths(basePath) {
  const candidates = [basePath];
  const extension = path.posix.extname(basePath);
  if (extension) {
    if ([".js", ".mjs", ".cjs"].includes(extension)) {
      const stem = basePath.slice(0, -extension.length);
      for (const replacement of [".ts", ".tsx", ".jsx"]) candidates.push(stem + replacement);
    }
  } else {
    for (const item of RESOLUTION_EXTENSIONS) candidates.push(basePath + item);
    for (const item of RESOLUTION_EXTENSIONS.filter((value) => ![".json", ".html", ".htm"].includes(value))) {
      candidates.push(path.posix.join(basePath, "index" + item));
    }
  }
  return [...new Set(candidates)];
}

function collectManifestTargets(value, output = []) {
  if (typeof value === "string" && value.startsWith("./")) output.push(value);
  else if (Array.isArray(value)) for (const item of value) collectManifestTargets(item, output);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectManifestTargets(item, output);
  }
  return output;
}

function resolveRelativeProjectPath(importerPath, specifier, knownPaths, manifests = []) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return { relative: false, target: null };
  const cleanSpecifier = specifier.replace(/[?#].*$/, "");
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), cleanSpecifier));
  if (path.posix.isAbsolute(joined) || joined === ".." || joined.startsWith("../")) {
    return { relative: true, outside: true, target: null };
  }
  const directCandidates = candidateModulePaths(joined);
  const direct = directCandidates.find((candidate) => knownPaths.has(candidate));
  if (direct) return { relative: true, outside: false, target: direct, candidates: directCandidates };

  const manifestPath = path.posix.join(joined, "package.json");
  const manifest = manifests.find((item) => item.path === manifestPath && item.data && !item.parseError);
  if (manifest) {
    const targets = [manifest.data.module, manifest.data.main, manifest.data.browser, ...collectManifestTargets(manifest.data.exports)];
    for (const target of targets) {
      if (typeof target !== "string" || !target.startsWith("./")) continue;
      const targetPath = path.posix.normalize(path.posix.join(joined, target));
      const resolved = candidateModulePaths(targetPath).find((candidate) => knownPaths.has(candidate));
      if (resolved) return { relative: true, outside: false, target: resolved, candidates: directCandidates };
    }
  }
  return { relative: true, outside: false, target: null, candidates: directCandidates };
}

function parseProjectModules(projectFiles) {
  const modules = new Map();
  const parseSkipped = [];
  const dynamicFiles = [];
  for (const file of projectFiles) {
    if (!JS_EXTENSIONS.has(file.extension)) continue;
    try {
      const analysis = analyzeModule(file);
      modules.set(file.path, analysis);
      if (analysis.dynamicModuleReference) dynamicFiles.push(file.path);
    } catch { parseSkipped.push(file.path); }
  }
  return { modules, parseSkipped, dynamicFiles };
}

function analyzeUnresolvedRelativeImports(context) {
  const projectFiles = context.projectFiles ?? [];
  const knownPaths = new Set(projectFiles.map((file) => file.path));
  const { modules, parseSkipped, dynamicFiles } = parseProjectModules(projectFiles);
  const manifests = context.packageManifests ?? [];
  const findings = [];
  const seen = new Set();
  for (const [importerPath, analysis] of modules) {
    for (const reference of analysis.references) {
      if (typeof reference.source !== "string" || !reference.source.startsWith(".")) continue;
      const resolution = resolveRelativeProjectPath(importerPath, reference.source, knownPaths, manifests);
      if (resolution.outside || resolution.target) continue;
      const key = importerPath + "::" + reference.source;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        id: "CODE-IMPORT-UNRESOLVED-" + importerPath.replace(/[^a-z0-9]+/gi, "-") + "-" + reference.source.replace(/[^a-z0-9]+/gi, "-"),
        title: "Relative module import does not resolve inside the scanned project",
        description: "The relative module specifier " + reference.source + " from " + importerPath +
          " does not match a scanned file or supported directory entrypoint. Files outside the scan root and unscanned generated files are not validated.",
        severity: "warning",
        location: importerPath + ":" + (reference.line ?? 1),
        recommendation: "Verify the relative path, filename casing, extension, package entrypoint, and build aliases before running or building the project.",
        evidence: { importer: importerPath, specifier: reference.source, candidatePaths: (resolution.candidates ?? []).slice(0, 12) },
        metadata: { detector: "static-relative-module-resolution", confidence: "review-required", safeToDeleteAutomatically: false }
      });
    }
  }
  if (parseSkipped.length) findings.push({
    id: "CODE-IMPORT-RESOLUTION-PARSE-SKIPPED",
    title: "Some JavaScript modules could not be checked for unresolved relative imports",
    description: parseSkipped.length + " JavaScript module(s) could not be parsed, so their import paths were not validated.",
    severity: "info",
    location: parseSkipped.slice(0, 8).join(", "),
    recommendation: "Resolve syntax errors or inspect these modules with a parser matching their syntax.",
    evidence: { skippedFiles: parseSkipped.length, paths: parseSkipped.slice(0, 20) },
    metadata: { detector: "static-relative-module-resolution", confidence: "coverage-warning" }
  });
  if (dynamicFiles.length) findings.push({
    id: "CODE-IMPORT-RESOLUTION-DYNAMIC-SKIPPED",
    title: "Dynamic module loading limits import-resolution coverage",
    description: dynamicFiles.length + " JavaScript module(s) contain non-literal import() or require() calls that cannot be resolved statically.",
    severity: "info",
    location: dynamicFiles.slice(0, 8).join(", "),
    recommendation: "Review dynamic module names and build-time aliases manually; no missing path is inferred from a non-literal expression.",
    evidence: { dynamicFiles: dynamicFiles.length, paths: dynamicFiles.slice(0, 20) },
    metadata: { detector: "static-relative-module-resolution", confidence: "coverage-warning" }
  });
  return findings;
}

function findStronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  function visit(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
    }
    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  }
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return components;
}

function analyzeCircularDependencies(context) {
  const projectFiles = context.projectFiles ?? [];
  const modulePaths = new Set(projectFiles.filter((file) => JS_EXTENSIONS.has(file.extension)).map((file) => file.path));
  const { modules, parseSkipped, dynamicFiles } = parseProjectModules(projectFiles);
  const graph = new Map([...modules.keys()].map((modulePath) => [modulePath, new Set()]));
  for (const [importerPath, analysis] of modules) {
    for (const reference of analysis.references) {
      if (typeof reference.source !== "string") continue;
      const target = resolveRelativeModule(importerPath, reference.source, modulePaths);
      if (target && graph.has(target)) graph.get(importerPath).add(target);
    }
  }
  const findings = [];
  for (const component of findStronglyConnectedComponents(graph)) {
    const selfCycle = component.length === 1 && graph.get(component[0])?.has(component[0]);
    if (component.length < 2 && !selfCycle) continue;
    const members = component.slice().sort();
    const slug = members.join("--").replace(/[^a-z0-9]+/gi, "-");
    findings.push({
      id: "CODE-CYCLE-" + slug,
      title: "Circular module dependency detected across " + members.length + " module(s)",
      description: "The statically resolved module graph contains a strongly connected component: " + members.join(", ") +
        ". Cycles can create initialization-order and maintenance risks, but some project architectures intentionally use them.",
      severity: "warning",
      location: members.join(", "),
      recommendation: "Review whether the modules can depend on a lower-level shared module or one-way interface; verify initialization behavior before refactoring.",
      evidence: { modules: members, cycleSize: members.length, staticallyResolved: true },
      metadata: { detector: "static-module-graph-tarjan", confidence: "review-only", safeToDeleteAutomatically: false }
    });
  }
  if (parseSkipped.length || dynamicFiles.length) findings.push({
    id: "CODE-CYCLE-ANALYSIS-PARTIAL",
    title: "Circular dependency analysis has incomplete static coverage",
    description: (parseSkipped.length ? parseSkipped.length + " unparseable JavaScript module(s); " : "") +
      (dynamicFiles.length ? dynamicFiles.length + " module(s) with non-literal dynamic loading." : "") +
      " Dependencies hidden by unsupported syntax or runtime-computed paths may not appear in the graph.",
    severity: "info",
    location: [...parseSkipped, ...dynamicFiles].slice(0, 8).join(", "),
    recommendation: "Resolve parse gaps and review dynamic loading paths before treating the dependency graph as complete.",
    evidence: { parseSkippedFiles: parseSkipped.length, dynamicFiles: dynamicFiles.length },
    metadata: { detector: "static-module-graph-tarjan", confidence: "coverage-warning" }
  });
  return findings;
}

const CSS_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"]);
const DYNAMIC_CLASS_PATTERNS = [
  /\bclassName\s*=\s*\{/,
  /:class\s*=/,
  /\bngClass\s*=/,
  /\.className\s*=\s*[A-Za-z_$][\w$]*/,
  /\.classList\s*\.\s*(?:add|toggle|remove)\s*\(\s*[A-Za-z_$][\w$]*/,
  /\.setAttribute\s*\(\s*["']class["']\s*,\s*[A-Za-z_$][\w$]*/
];
function escapeRegExp(value) { return value; }
function cssSelectorNames(content) {
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, " ");
  const withoutStrings = withoutComments.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, " ");
  const names = new Map();
  for (const match of withoutStrings.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith("@")) continue;
    for (const token of selector.matchAll(/(^|[^\w-])([.#])([_a-zA-Z][\w-]*)/g)) {
      const kind = token[2] === "." ? "class" : "id";
      const name = token[3];
      names.set(kind + ":" + name, { kind, name });
    }
  }
  return [...names.values()];
}
function analyzeCssSelectors(projectFiles) {
  const styleFiles = projectFiles.filter((file) => CSS_EXTENSIONS.has(file.extension));
  if (!styleFiles.length) return [];
  const dynamicFiles = projectFiles.filter((file) => !CSS_EXTENSIONS.has(file.extension) && DYNAMIC_CLASS_PATTERNS.some((pattern) => pattern.test(file.content)));
  if (dynamicFiles.length) return [{
    id: "CODE-DEAD-CSS-ANALYSIS-SKIPPED",
    title: "CSS selector reachability skipped because dynamic class assignment is present",
    description: "At least one scanned source file builds or assigns classes dynamically. Static text matching cannot safely determine whether a stylesheet selector is unused.",
    severity: "info",
    location: dynamicFiles.slice(0, 8).map((file) => file.path).join(", "),
    recommendation: "Add explicit class-name inventories or run browser coverage across representative routes and states before evaluating unused selectors.",
    evidence: { dynamicClassFiles: dynamicFiles.length },
    metadata: { detector: "static-css-selector-reachability", confidence: "coverage-warning" }
  }];
  const findings = [];
  for (const styleFile of styleFiles) {
    if (/:global\s*\(|:deep\s*\(|::slotted\s*\(|:local\s*\(/.test(styleFile.content)) {
      findings.push({
        id: "CODE-DEAD-CSS-ANALYSIS-SKIPPED-" + styleFile.path.replace(/[^a-z0-9]+/gi, "-"),
        title: "Stylesheet uses scoped or global selector constructs",
        description: "The stylesheet contains framework-specific selector scoping. This static scanner does not resolve generated class names.",
        severity: "info",
        location: styleFile.path,
        recommendation: "Use framework build output or browser coverage to validate selector reachability.",
        evidence: { path: styleFile.path },
        metadata: { detector: "static-css-selector-reachability", confidence: "coverage-warning" }
      });
      continue;
    }
    for (const selector of cssSelectorNames(styleFile.content)) {
      const tokenPattern = new RegExp("\\b" + escapeRegExp(selector.name) + "\\b");
      const referenced = projectFiles.some((file) => file.path !== styleFile.path && tokenPattern.test(file.content));
      if (referenced) continue;
      findings.push({
        id: "CODE-DEAD-CSS-" + styleFile.path.replace(/[^a-z0-9]+/gi, "-") + "-" + selector.kind + "-" + selector.name,
        title: "CSS " + selector.kind + " selector has no scanned text reference",
        description: "No other scanned project text contains the selector name " + selector.name + ". Runtime-generated markup, external templates, and browser states are outside this static check; treat this as a review candidate.",
        severity: "info",
        location: styleFile.path,
        recommendation: "Check dynamic markup, framework conventions, external templates, and browser coverage before removing this selector.",
        evidence: { path: styleFile.path, selector: (selector.kind === "class" ? "." : "#") + selector.name },
        metadata: { detector: "static-css-selector-reachability", confidence: "review-only", safeToDeleteAutomatically: false }
      });
    }
  }
  return findings;
}

export const deadCodeRules = Object.freeze([
  {
    id: "code-quality.possibly-unused-bindings",
    specialist: "code-quality",
    evaluate(context) {
      const findings = [];
      const skipped = [];
      for (const file of context.projectFiles ?? []) {
        if (!JS_EXTENSIONS.has(file.extension)) continue;
        try {
          const result = analyzeLocalBindings(file);
          findings.push(...result.findings);
          if (result.skipped) skipped.push(file.path);
        } catch { skipped.push(file.path); }
      }
      if (skipped.length) findings.push({
        id: "CODE-DEAD-LOCAL-ANALYSIS-SKIPPED",
        title: "Local binding analysis skipped for files with unsupported or dynamic scope",
        description: skipped.length + " JavaScript file(s) could not be safely analyzed for unused imports and local bindings.",
        severity: "info",
        location: skipped.slice(0, 8).join(", "),
        recommendation: "Review unsupported syntax or dynamic scope manually; do not infer that declarations are unused.",
        evidence: { skippedFiles: skipped.length, paths: skipped.slice(0, 20) },
        metadata: { detector: "conservative-identifier-reference-count", confidence: "coverage-warning" }
      });
      return findings;
    }
  },
  {
    id: "code-quality.possibly-unused-css-selectors",
    specialist: "code-quality",
    evaluate(context) { return analyzeCssSelectors(context.projectFiles ?? []); }
  },
  {
    id: "code-quality.possibly-unused-declarations",
    specialist: "code-quality",
    evaluate(context) {
      const findings = [];
      const skipped = [];
      for (const file of context.projectFiles ?? []) {
        if (!JS_EXTENSIONS.has(file.extension)) continue;
        try {
          const result = analyzeUnusedFunctionsAndClasses(file);
          findings.push(...result.findings);
          if (result.skipped) skipped.push(file.path);
        } catch { skipped.push(file.path); }
      }
      if (skipped.length) findings.push({
        id: "CODE-DEAD-FUNCTION-CLASS-ANALYSIS-SKIPPED",
        title: "Function and class reachability skipped for some JavaScript files",
        description: skipped.length + " file(s) could not be safely analyzed because of parse failures or dynamic scope.",
        severity: "info",
        location: skipped.slice(0, 8).join(", "),
        recommendation: "Review unsupported syntax and dynamic scope manually; do not infer that declarations are unused.",
        evidence: { skippedFiles: skipped.length, paths: skipped.slice(0, 20) },
        metadata: { detector: "conservative-function-class-reference-check", confidence: "coverage-warning" }
      });
      return findings;
    }
  },
  {
    id: "code-quality.unresolved-relative-imports",
    specialist: "code-quality",
    evaluate(context) { return analyzeUnresolvedRelativeImports(context); }
  },
  {
    id: "code-quality.circular-dependencies",
    specialist: "code-quality",
    evaluate(context) { return analyzeCircularDependencies(context); }
  },
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