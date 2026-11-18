const LEVELS = Object.freeze(["ecosystem", "engine", "branch", "subbranch", "module", "component"]);
const PARENT_LEVEL = Object.freeze({
  ecosystem: null,
  engine: "ecosystem",
  branch: "engine",
  subbranch: "branch",
  module: "subbranch",
  component: "module"
});
const STATUSES = new Set(["PASS", "FAIL", "PENDING"]);
const EVIDENCE_KINDS = new Set([
  "workflow-run", "test-suite", "security-scan", "database-integration",
  "package-validation", "manual-review"
]);
const ID_PATTERN = /^[a-z][a-z0-9.-]{2,95}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const actual = ownKeys.sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return actual.every((key) => descriptors[key]?.enumerable === true &&
    Object.hasOwn(descriptors[key], "value"));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validIsoDate(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function addError(errors, message) {
  errors.push(message);
}

export function validateSccmInventory(inventory) {
  const errors = [];
  if (!exactKeys(inventory, ["schema", "inventoryVersion", "generatedAt", "sources", "nodes"])) {
    return Object.freeze({ valid: false, errors: Object.freeze(["inventory has missing or unknown fields"]) });
  }
  if (inventory.schema !== "jb.sccm.inventory/v1") addError(errors, "schema must be jb.sccm.inventory/v1");
  if (typeof inventory.inventoryVersion !== "string" || !VERSION_PATTERN.test(inventory.inventoryVersion)) {
    addError(errors, "inventoryVersion must use MAJOR.MINOR.PATCH syntax");
  }
  if (!validIsoDate(inventory.generatedAt)) addError(errors, "generatedAt must be a UTC ISO timestamp");
  if (!Array.isArray(inventory.sources) || inventory.sources.length < 1 || inventory.sources.length > 100) {
    addError(errors, "sources must contain between 1 and 100 entries");
  }
  if (!Array.isArray(inventory.nodes) || inventory.nodes.length < 1 || inventory.nodes.length > 2000) {
    addError(errors, "nodes must contain between 1 and 2000 entries");
  }
  if (!Array.isArray(inventory.sources) || !Array.isArray(inventory.nodes)) {
    return Object.freeze({ valid: false, errors: Object.freeze(errors) });
  }

  const sourceIds = new Set();
  for (const [index, source] of inventory.sources.entries()) {
    if (!exactKeys(source, ["id", "repository", "ref", "commitSha"])) {
      addError(errors, "sources[" + index + "] has missing or unknown fields");
      continue;
    }
    if (typeof source.id !== "string" || !ID_PATTERN.test(source.id) || sourceIds.has(source.id)) {
      addError(errors, "sources[" + index + "].id is invalid or duplicated");
    } else sourceIds.add(source.id);
    if (typeof source.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)) {
      addError(errors, "sources[" + index + "].repository must be owner/repository");
    }
    if (typeof source.ref !== "string" || !source.ref.trim() || source.ref.length > 256) {
      addError(errors, "sources[" + index + "].ref is invalid");
    }
    if (typeof source.commitSha !== "string" || !SHA_PATTERN.test(source.commitSha)) {
      addError(errors, "sources[" + index + "].commitSha must be a full 40-character SHA");
    }
  }

  const nodeById = new Map();
  const expectedNodeKeys = ["id", "name", "level", "parentId", "sourceId", "version", "critical", "dependencies"];
  for (const [index, node] of inventory.nodes.entries()) {
    if (!exactKeys(node, expectedNodeKeys)) {
      addError(errors, "nodes[" + index + "] has missing or unknown fields");
      continue;
    }
    if (typeof node.id !== "string" || !ID_PATTERN.test(node.id) || nodeById.has(node.id)) {
      addError(errors, "nodes[" + index + "].id is invalid or duplicated");
    } else nodeById.set(node.id, node);
    if (typeof node.name !== "string" || !node.name.trim() || node.name.length > 160) {
      addError(errors, "nodes[" + index + "].name is invalid");
    }
    if (!LEVELS.includes(node.level)) addError(errors, "nodes[" + index + "].level is invalid");
    if (node.parentId !== null && (typeof node.parentId !== "string" || !ID_PATTERN.test(node.parentId))) {
      addError(errors, "nodes[" + index + "].parentId is invalid");
    }
    if (typeof node.sourceId !== "string" || !sourceIds.has(node.sourceId)) {
      addError(errors, "nodes[" + index + "].sourceId does not identify a registered source");
    }
    if (typeof node.version !== "string" || !VERSION_PATTERN.test(node.version)) {
      addError(errors, "nodes[" + index + "].version is invalid");
    }
    if (typeof node.critical !== "boolean") addError(errors, "nodes[" + index + "].critical must be boolean");
    if (!Array.isArray(node.dependencies) || node.dependencies.length > 100) {
      addError(errors, "nodes[" + index + "].dependencies must be an array with at most 100 entries");
    } else if (node.dependencies.some((dependency) => typeof dependency !== "string" || !ID_PATTERN.test(dependency))) {
      addError(errors, "nodes[" + index + "].dependencies contains an invalid node ID");
    } else if (new Set(node.dependencies).size !== node.dependencies.length) {
      addError(errors, "nodes[" + index + "].dependencies contains duplicates");
    }
  }

  let rootCount = 0;
  for (const node of nodeById.values()) {
    if (!LEVELS.includes(node.level)) continue;
    const expectedParent = PARENT_LEVEL[node.level];
    if (expectedParent === null) {
      if (node.parentId !== null) addError(errors, node.id + " must not have a parent");
      else rootCount += 1;
      continue;
    }
    const parent = nodeById.get(node.parentId);
    if (!parent) addError(errors, node.id + " references a missing parent");
    else if (parent.level !== expectedParent) {
      addError(errors, node.id + " must have a " + expectedParent + " parent");
    }
  }
  if (rootCount < 1) addError(errors, "inventory must contain at least one ecosystem root");

  const graph = new Map([...nodeById.keys()].map((id) => [id, []]));
  for (const node of nodeById.values()) {
    for (const dependency of (Array.isArray(node.dependencies) ? node.dependencies : [])) {
      if (!nodeById.has(dependency)) addError(errors, node.id + " references missing dependency " + dependency);
      else graph.get(node.id).push(dependency);
      if (dependency === node.id) addError(errors, node.id + " cannot depend on itself");
    }
    for (const child of nodeById.values()) {
      if (child.parentId === node.id) graph.get(node.id).push(child.id);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      addError(errors, "hierarchy/dependency cycle detected at " + id);
      return;
    }
    if (visited.has(id) || !graph.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id)) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function assertSccmInventory(inventory) {
  const result = validateSccmInventory(inventory);
  if (!result.valid) throw new TypeError("Invalid SCCM inventory: " + result.errors.join("; "));
  return inventory;
}

const ASSESSMENT_KEYS = ["assessmentId", "nodeId", "version", "commitSha", "status", "assessedAt", "evidence", "findings"];
const EVIDENCE_KEYS = ["kind", "reference", "commitSha", "outcome", "summary"];

export function validateSccmAssessment(inventory, assessment) {
  const errors = [];
  const inventoryResult = validateSccmInventory(inventory);
  if (!inventoryResult.valid) return Object.freeze({ valid: false, errors: Object.freeze(["inventory is invalid", ...inventoryResult.errors]) });
  if (!exactKeys(assessment, ASSESSMENT_KEYS)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["assessment has missing or unknown fields"]) });
  }
  const node = inventory.nodes.find((item) => item.id === assessment.nodeId);
  if (typeof assessment.assessmentId !== "string" || !ID_PATTERN.test(assessment.assessmentId)) {
    addError(errors, "assessmentId is invalid");
  }
  if (!node) addError(errors, "assessment references an unknown node");
  if (typeof assessment.version !== "string" || !VERSION_PATTERN.test(assessment.version)) {
    addError(errors, "assessment version is invalid");
  } else if (node && assessment.version !== node.version) {
    addError(errors, "assessment version does not match the inventory node version");
  }
  if (typeof assessment.commitSha !== "string" || !SHA_PATTERN.test(assessment.commitSha)) {
    addError(errors, "assessment commitSha must be a full 40-character SHA");
  } else if (node) {
    const source = inventory.sources.find((item) => item.id === node.sourceId);
    if (source && assessment.commitSha !== source.commitSha) {
      addError(errors, "assessment commitSha does not match the registered source snapshot");
    }
  }
  if (!STATUSES.has(assessment.status)) addError(errors, "assessment status must be PASS, FAIL or PENDING");
  if (!validIsoDate(assessment.assessedAt)) addError(errors, "assessedAt must be a UTC ISO timestamp");
  if (!Array.isArray(assessment.evidence) || assessment.evidence.length > 100) {
    addError(errors, "evidence must be an array with at most 100 entries");
  } else {
    for (const [index, evidence] of assessment.evidence.entries()) {
      if (!exactKeys(evidence, EVIDENCE_KEYS)) {
        addError(errors, "evidence[" + index + "] has missing or unknown fields");
        continue;
      }
      if (!EVIDENCE_KINDS.has(evidence.kind)) addError(errors, "evidence[" + index + "].kind is invalid");
      if (typeof evidence.reference !== "string" || !/^https:\/\//.test(evidence.reference) || evidence.reference.length > 2048) {
        addError(errors, "evidence[" + index + "].reference must be an HTTPS evidence URL");
      }
      if (typeof evidence.commitSha !== "string" || evidence.commitSha !== assessment.commitSha) {
        addError(errors, "evidence[" + index + "].commitSha must match the assessed commit");
      }
      if (!["success", "failure", "incomplete"].includes(evidence.outcome)) {
        addError(errors, "evidence[" + index + "].outcome is invalid");
      }
      if (typeof evidence.summary !== "string" || !evidence.summary.trim() || evidence.summary.length > 1000) {
        addError(errors, "evidence[" + index + "].summary is invalid");
      }
    }
  }
  if (!Array.isArray(assessment.findings) || assessment.findings.length > 200 ||
      assessment.findings.some((finding) => typeof finding !== "string" || !finding.trim() || finding.length > 1000)) {
    addError(errors, "findings must be an array of non-empty strings");
  }
  if (assessment.status === "PASS") {
    if (!Array.isArray(assessment.evidence) || assessment.evidence.length === 0) {
      addError(errors, "PASS requires reproducible evidence");
    } else if (assessment.evidence.some((item) => !isRecord(item) || item.outcome !== "success")) {
      addError(errors, "PASS evidence must all have success outcome");
    }
    if (Array.isArray(assessment.findings) && assessment.findings.length > 0) {
      addError(errors, "PASS cannot contain unresolved findings");
    }
  }
  if (assessment.status === "FAIL" &&
      (!Array.isArray(assessment.evidence) || !assessment.evidence.some((item) => isRecord(item) && item.outcome === "failure"))) {
    addError(errors, "FAIL requires at least one failure evidence item");
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function appendSccmAssessment(inventory, history, assessment) {
  assertSccmInventory(inventory);
  if (!Array.isArray(history)) throw new TypeError("assessment history must be an array");
  const historyValidation = validateSccmHistory(inventory, history);
  if (!historyValidation.valid) throw new TypeError("Invalid existing SCCM history: " + historyValidation.errors.join("; "));
  const validation = validateSccmAssessment(inventory, assessment);
  if (!validation.valid) throw new TypeError("Invalid SCCM assessment: " + validation.errors.join("; "));
  if (history.some((entry) => entry.assessmentId === assessment.assessmentId)) {
    throw new TypeError("assessmentId already exists; history is append-only");
  }
  const previous = [...history].reverse().find((entry) => entry.nodeId === assessment.nodeId);
  if (previous && Date.parse(assessment.assessedAt) < Date.parse(previous.assessedAt)) {
    throw new TypeError("assessment timestamp cannot move backwards for a node");
  }
  return deepFreeze([...history.map((entry) => structuredClone(entry)), structuredClone(assessment)]);
}

export function validateSccmHistory(inventory, history) {
  const errors = [];
  if (!Array.isArray(history) || history.length > 100_000) {
    return Object.freeze({ valid: false, errors: Object.freeze(["history must be an array with at most 100000 assessments"]) });
  }
  const seen = new Set();
  const lastTimestamp = new Map();
  for (const [index, assessment] of history.entries()) {
    const result = validateSccmAssessment(inventory, assessment);
    if (!result.valid) errors.push(...result.errors.map((error) => "history[" + index + "]: " + error));
    if (!exactKeys(assessment, ASSESSMENT_KEYS)) continue;
    if (typeof assessment.assessmentId === "string") {
      if (seen.has(assessment.assessmentId)) errors.push("history contains duplicate assessmentId " + assessment.assessmentId);
      seen.add(assessment.assessmentId);
    }
    if (typeof assessment.nodeId !== "string" || !validIsoDate(assessment.assessedAt)) continue;
    const previous = lastTimestamp.get(assessment.nodeId);
    if (previous !== undefined && Date.parse(assessment.assessedAt) < previous) {
      errors.push("history timestamps move backwards for " + assessment.nodeId);
    }
    lastTimestamp.set(assessment.nodeId, Date.parse(assessment.assessedAt));
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function evaluateSccmNode(inventory, history, nodeId) {
  assertSccmInventory(inventory);
  const historyValidation = validateSccmHistory(inventory, history);
  if (!historyValidation.valid) throw new TypeError("Invalid SCCM history: " + historyValidation.errors.join("; "));
  const nodeById = new Map(inventory.nodes.map((node) => [node.id, node]));
  if (!nodeById.has(nodeId)) throw new TypeError("Unknown SCCM node: " + nodeId);
  const childrenByParent = new Map();
  for (const node of inventory.nodes) {
    if (node.parentId === null) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  const latestByNode = new Map();
  for (const assessment of history) latestByNode.set(assessment.nodeId, assessment);

  const cache = new Map();
  function evaluate(id, stack = new Set()) {
    if (cache.has(id)) return cache.get(id);
    if (stack.has(id)) throw new TypeError("SCCM dependency cycle detected during evaluation");
    const node = nodeById.get(id);
    const nextStack = new Set(stack).add(id);
    const assessment = latestByNode.get(id) ?? null;
    const ownStatus = assessment?.status ?? "PENDING";
    const children = (childrenByParent.get(id) ?? []).map((child) => evaluate(child.id, nextStack));
    const dependencies = node.dependencies.map((dependency) => evaluate(dependency, nextStack));

    const criticalChildFailure = children.some((child) => child.criticalFailure);
    const criticalChildPending = children.some((child) => child.criticalPending);
    const dependencyFailure = dependencies.some((dependency) => dependency.status === "FAIL");
    const dependencyPending = dependencies.some((dependency) => dependency.status !== "PASS");
    const status = ownStatus === "FAIL" || criticalChildFailure || dependencyFailure
      ? "FAIL"
      : ownStatus !== "PASS" || criticalChildPending || dependencyPending
        ? "PENDING"
        : "PASS";

    const result = deepFreeze({
      id: node.id,
      name: node.name,
      level: node.level,
      critical: node.critical,
      status,
      ownStatus,
      version: assessment?.version ?? node.version,
      commitSha: assessment?.commitSha ?? inventory.sources.find((source) => source.id === node.sourceId).commitSha,
      lastAssessmentId: assessment?.assessmentId ?? null,
      evidenceCount: assessment?.evidence.length ?? 0,
      blockingChildren: children.filter((child) => child.critical && child.status !== "PASS").map((child) => ({ id: child.id, status: child.status })),
      blockingDependencies: dependencies.filter((dependency) => dependency.status !== "PASS").map((dependency) => ({ id: dependency.id, status: dependency.status })),
      warnings: children.filter((child) => !child.critical && child.status !== "PASS").map((child) => ({ id: child.id, status: child.status })),
      children,
      criticalFailure: (node.critical && ownStatus === "FAIL") || criticalChildFailure || dependencyFailure,
      criticalPending: (node.critical && ownStatus === "PENDING") || criticalChildPending || dependencyPending
    });
    cache.set(id, result);
    return result;
  }
  return evaluate(nodeId);
}

export function buildSccmReport(inventory, history) {
  assertSccmInventory(inventory);
  const historyValidation = validateSccmHistory(inventory, history);
  if (!historyValidation.valid) throw new TypeError("Invalid SCCM history: " + historyValidation.errors.join("; "));
  const roots = inventory.nodes.filter((node) => node.parentId === null);
  const evaluatedRoots = roots.map((node) => evaluateSccmNode(inventory, history, node.id));
  const counts = Object.fromEntries(LEVELS.map((level) => [level, { PASS: 0, FAIL: 0, PENDING: 0, total: 0 }]));
  function count(node) {
    const bucket = counts[node.level];
    bucket[node.status] += 1;
    bucket.total += 1;
    for (const child of node.children) count(child);
  }
  for (const root of evaluatedRoots) count(root);
  const allNodes = LEVELS.reduce((total, level) => total + counts[level].total, 0);
  const passed = LEVELS.reduce((total, level) => total + counts[level].PASS, 0);
  return deepFreeze({
    schema: "jb.sccm.report/v1",
    inventoryVersion: inventory.inventoryVersion,
    generatedAt: new Date().toISOString(),
    status: evaluatedRoots.every((root) => root.status === "PASS") ? "PASS" :
      evaluatedRoots.some((root) => root.status === "FAIL") ? "FAIL" : "PENDING",
    progress: { total: allNodes, passed, pending: allNodes - passed - LEVELS.reduce((total, level) => total + counts[level].FAIL, 0), failed: LEVELS.reduce((total, level) => total + counts[level].FAIL, 0) },
    counts,
    roots: evaluatedRoots,
    historyEntries: history.length
  });
}

export const SCCM_LEVELS = LEVELS;
export const SCCM_STATUSES = Object.freeze([...STATUSES]);
