const LAB_SCHEMA = "jb.threat-lab.report/v1";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,79}$/i;

const LIMITS = Object.freeze({
  targets: 50,
  scenarios: 100,
  matrixRuns: 2500,
  capabilities: 50,
  scenarioTags: 50,
  appliesTo: 100,
  metadataBytes: 16 * 1024,
  outcomeBytes: 64 * 1024,
  findings: 100,
  findingsBytes: 48 * 1024,
  metricKeys: 50,
  metricsBytes: 16 * 1024
});

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(label + " must be a 2-80 character stable identifier");
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, label, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(label + " must contain only serializable JSON values");
  }
  if (typeof serialized !== "string") {
    throw new TypeError(label + " must contain a serializable JSON value");
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new RangeError(label + " exceeds the " + maxBytes + "-byte laboratory limit");
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw new TypeError(label + " could not be normalized as JSON");
  }
}

function cloneJsonObject(value, label, maxBytes) {
  if (!isPlainObject(value)) {
    throw new TypeError(label + " must be a plain JSON object");
  }
  return cloneJson(value, label, maxBytes);
}

function safeScenario(scenario) {
  return scenario?.safety?.safe === true
    && scenario.safety.network === false
    && scenario.safety.destructive === false
    && scenario.safety.executesSample === false;
}

function normalizeOutcome(outcome) {
  const normalized = cloneJson(outcome, "Adapter outcome", LIMITS.outcomeBytes);
  if (!isPlainObject(normalized) || !["pass", "fail", "skip"].includes(normalized.status)) {
    throw new TypeError("Adapter must return a JSON object with status: pass, fail, or skip");
  }

  const findings = normalized.findings ?? [];
  if (!Array.isArray(findings)) {
    throw new TypeError("Adapter findings must be an array");
  }
  if (findings.length > LIMITS.findings) {
    throw new RangeError("Adapter returned more than " + LIMITS.findings + " findings");
  }

  const metrics = normalized.metrics ?? {};
  if (!isPlainObject(metrics)) {
    throw new TypeError("Adapter metrics must be a plain JSON object");
  }
  if (Object.keys(metrics).length > LIMITS.metricKeys) {
    throw new RangeError("Adapter returned more than " + LIMITS.metricKeys + " metric keys");
  }

  return {
    status: normalized.status,
    summary: typeof normalized.summary === "string" ? normalized.summary.slice(0, 1000) : "",
    findings: cloneJson(findings, "Adapter findings", LIMITS.findingsBytes),
    metrics: cloneJsonObject(metrics, "Adapter metrics", LIMITS.metricsBytes)
  };
}

/**
 * Creates an isolated orchestration registry. The lab never executes samples,
 * sends network traffic, mutates targets, or interprets a pass as a clean bill
 * of security; adapters own those boundaries and must declare safe scenarios.
 */
export function createThreatLab({ name = "JB Threat Lab", version = "0.1.0", clock = () => new Date() } = {}) {
  if (typeof name !== "string" || !name.trim() || name.length > 100) {
    throw new TypeError("name must be a non-empty string of at most 100 characters");
  }
  if (typeof version !== "string" || !version.trim() || version.length > 80) {
    throw new TypeError("version must be a non-empty string of at most 80 characters");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const targets = new Map();
  const scenarios = new Map();

  function registerTarget({ id, kind, version: targetVersion = "unknown", adapter, capabilities = [] } = {}) {
    assertId(id, "target id");
    if (targets.has(id)) throw new Error("Target already registered: " + id);
    if (targets.size >= LIMITS.targets) throw new RangeError("The laboratory supports at most " + LIMITS.targets + " targets");
    if (typeof kind !== "string" || !kind.trim() || kind.length > 80) {
      throw new TypeError("target kind must be a non-empty string of at most 80 characters");
    }
    if (typeof targetVersion !== "string" || targetVersion.length > 80) {
      throw new TypeError("target version must be a string of at most 80 characters");
    }
    if (!adapter || typeof adapter.runScenario !== "function") {
      throw new TypeError("target adapter must implement runScenario({ scenario, context })");
    }
    if (!Array.isArray(capabilities) || capabilities.length > LIMITS.capabilities ||
        capabilities.some((item) => typeof item !== "string" || !item.trim() || item.length > 80)) {
      throw new TypeError("capabilities must contain at most " + LIMITS.capabilities + " non-empty strings of at most 80 characters");
    }
    const safeCapabilities = Object.freeze([...new Set(capabilities)]);
    targets.set(id, Object.freeze({
      id, kind, version: targetVersion, adapter, capabilities: safeCapabilities
    }));
    return { id, kind, version: targetVersion, capabilities: [...safeCapabilities] };
  }

  function registerScenario(scenario) {
    assertId(scenario?.id, "scenario id");
    if (scenarios.has(scenario.id)) throw new Error("Scenario already registered: " + scenario.id);
    if (scenarios.size >= LIMITS.scenarios) throw new RangeError("The laboratory supports at most " + LIMITS.scenarios + " scenarios");
    if (!safeScenario(scenario)) {
      throw new Error("Scenario rejected: only explicitly safe, offline, non-destructive, non-executing scenarios are allowed");
    }
    if (typeof scenario.category !== "string" || !scenario.category.trim() || scenario.category.length > 80) {
      throw new TypeError("scenario category must be a non-empty string of at most 80 characters");
    }
    if (typeof scenario.description !== "string" || !scenario.description.trim()) {
      throw new TypeError("scenario description is required");
    }
    const appliesTo = scenario.appliesTo ?? [];
    if (!Array.isArray(appliesTo) || appliesTo.length > LIMITS.appliesTo ||
        appliesTo.some((item) => typeof item !== "string" || !item.trim() || item.length > 80)) {
      throw new TypeError("scenario.appliesTo must contain at most " + LIMITS.appliesTo + " target ids or kinds of at most 80 characters");
    }
    const tags = scenario.tags ?? [];
    if (!Array.isArray(tags) || tags.length > LIMITS.scenarioTags ||
        tags.some((item) => typeof item !== "string" || !item.trim() || item.length > 80)) {
      throw new TypeError("scenario.tags must contain at most " + LIMITS.scenarioTags + " non-empty strings of at most 80 characters");
    }
    scenarios.set(scenario.id, Object.freeze({
      id: scenario.id,
      category: scenario.category,
      description: scenario.description.slice(0, 500),
      appliesTo: Object.freeze([...new Set(appliesTo)]),
      safety: Object.freeze({ safe: true, network: false, destructive: false, executesSample: false }),
      tags: Object.freeze([...new Set(tags)])
    }));
    return scenario.id;
  }

  async function run({ targetIds = [...targets.keys()], scenarioIds = [...scenarios.keys()], metadata = {} } = {}) {
    if (!Array.isArray(targetIds) || !Array.isArray(scenarioIds)) {
      throw new TypeError("targetIds and scenarioIds must be arrays");
    }
    if (targetIds.length > LIMITS.targets || scenarioIds.length > LIMITS.scenarios) {
      throw new RangeError("The requested matrix exceeds the laboratory target or scenario limit");
    }
    if (new Set(targetIds).size !== targetIds.length || new Set(scenarioIds).size !== scenarioIds.length) {
      throw new TypeError("targetIds and scenarioIds must not contain duplicates");
    }
    if (targetIds.length * scenarioIds.length > LIMITS.matrixRuns) {
      throw new RangeError("The requested matrix exceeds " + LIMITS.matrixRuns + " target-scenario executions");
    }
    const safeMetadata = cloneJsonObject(metadata, "Run metadata", LIMITS.metadataBytes);
    const selectedTargets = targetIds.map((id) => {
      const target = targets.get(id);
      if (!target) throw new Error("Unknown target: " + id);
      return target;
    });
    const selectedScenarios = scenarioIds.map((id) => {
      const scenario = scenarios.get(id);
      if (!scenario) throw new Error("Unknown scenario: " + id);
      return scenario;
    });
    const startedAt = clock().toISOString();
    const results = [];

    for (const target of selectedTargets) {
      for (const scenario of selectedScenarios) {
        if (scenario.appliesTo.length > 0 &&
            !scenario.appliesTo.includes(target.id) &&
            !scenario.appliesTo.includes(target.kind)) {
          results.push({
            target: { id: target.id, kind: target.kind, version: target.version },
            scenario: { id: scenario.id, category: scenario.category },
            status: "skip",
            summary: "Scenario is not assigned to this target",
            findings: [],
            metrics: {},
            durationMs: 0
          });
          continue;
        }
        const started = clock().getTime();
        try {
          const raw = await target.adapter.runScenario({
            scenario: cloneJson(scenario, "Registered scenario", 16 * 1024),
            context: Object.freeze({ lab: name, labVersion: version, targetId: target.id })
          });
          const outcome = normalizeOutcome(raw);
          results.push({
            target: { id: target.id, kind: target.kind, version: target.version },
            scenario: { id: scenario.id, category: scenario.category },
            ...outcome,
            durationMs: Math.max(0, clock().getTime() - started)
          });
        } catch (error) {
          results.push({
            target: { id: target.id, kind: target.kind, version: target.version },
            scenario: { id: scenario.id, category: scenario.category },
            status: "fail",
            summary: "Adapter execution failed",
            findings: [{ code: "LAB_ADAPTER_ERROR", message: String(error?.message ?? "Unknown adapter error").slice(0, 500) }],
            metrics: {},
            durationMs: Math.max(0, clock().getTime() - started)
          });
        }
      }
    }

    const totals = results.reduce((acc, result) => {
      acc[result.status] += 1;
      return acc;
    }, { pass: 0, fail: 0, skip: 0 });
    return {
      schema: LAB_SCHEMA,
      lab: { name, version },
      startedAt,
      completedAt: clock().toISOString(),
      metadata: safeMetadata,
      totals,
      results
    };
  }

  return Object.freeze({
    registerTarget,
    registerScenario,
    run,
    listTargets: () => [...targets.values()].map(({ adapter, ...target }) => ({ ...target, capabilities: [...target.capabilities] })),
    listScenarios: () => [...scenarios.values()].map((scenario) => cloneJson(scenario, "Registered scenario", 16 * 1024))
  });
}

export const THREAT_LAB_REPORT_SCHEMA = LAB_SCHEMA;
