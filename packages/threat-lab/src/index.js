const LAB_SCHEMA = "jb.threat-lab.report/v1";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,79}$/i;

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(label + " must be a 2-80 character stable identifier");
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeScenario(scenario) {
  return scenario?.safety?.safe === true
    && scenario.safety.network === false
    && scenario.safety.destructive === false
    && scenario.safety.executesSample === false;
}

function normalizeOutcome(outcome) {
  if (!outcome || !["pass", "fail", "skip"].includes(outcome.status)) {
    throw new TypeError("Adapter must return status: pass, fail, or skip");
  }
  return {
    status: outcome.status,
    summary: typeof outcome.summary === "string" ? outcome.summary.slice(0, 1000) : "",
    findings: Array.isArray(outcome.findings) ? cloneJson(outcome.findings) : [],
    metrics: outcome.metrics && typeof outcome.metrics === "object" ? cloneJson(outcome.metrics) : {}
  };
}

/**
 * Creates an isolated orchestration registry. The lab never executes samples,
 * sends network traffic, mutates targets, or interprets a pass as a clean bill
 * of security; adapters own those boundaries and must declare safe scenarios.
 */
export function createThreatLab({ name = "JB Threat Lab", version = "0.1.0", clock = () => new Date() } = {}) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("name is required");
  if (typeof version !== "string" || !version.trim()) throw new TypeError("version is required");

  const targets = new Map();
  const scenarios = new Map();

  function registerTarget({ id, kind, version: targetVersion = "unknown", adapter, capabilities = [] } = {}) {
    assertId(id, "target id");
    if (targets.has(id)) throw new Error("Target already registered: " + id);
    if (typeof kind !== "string" || !kind.trim()) throw new TypeError("target kind is required");
    if (!adapter || typeof adapter.runScenario !== "function") {
      throw new TypeError("target adapter must implement runScenario({ scenario, context })");
    }
    if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== "string")) {
      throw new TypeError("capabilities must be an array of strings");
    }
    targets.set(id, Object.freeze({
      id, kind, version: String(targetVersion), adapter, capabilities: Object.freeze([...capabilities])
    }));
    return { id, kind, version: String(targetVersion), capabilities: [...capabilities] };
  }

  function registerScenario(scenario) {
    assertId(scenario?.id, "scenario id");
    if (scenarios.has(scenario.id)) throw new Error("Scenario already registered: " + scenario.id);
    if (!safeScenario(scenario)) {
      throw new Error("Scenario rejected: only explicitly safe, offline, non-destructive, non-executing scenarios are allowed");
    }
    if (typeof scenario.category !== "string" || !scenario.category.trim()) {
      throw new TypeError("scenario category is required");
    }
    if (typeof scenario.description !== "string" || !scenario.description.trim()) {
      throw new TypeError("scenario description is required");
    }
    const appliesTo = scenario.appliesTo ?? [];
    if (!Array.isArray(appliesTo) || appliesTo.some((item) => typeof item !== "string" || !item.trim())) {
      throw new TypeError("scenario.appliesTo must be an array of target ids or kinds");
    }
    scenarios.set(scenario.id, Object.freeze({
      id: scenario.id,
      category: scenario.category,
      description: scenario.description.slice(0, 500),
      appliesTo: Object.freeze([...appliesTo]),
      safety: Object.freeze({ safe: true, network: false, destructive: false, executesSample: false }),
      tags: Object.freeze(Array.isArray(scenario.tags) ? [...scenario.tags] : [])
    }));
    return scenario.id;
  }

  async function run({ targetIds = [...targets.keys()], scenarioIds = [...scenarios.keys()], metadata = {} } = {}) {
    if (!Array.isArray(targetIds) || !Array.isArray(scenarioIds)) throw new TypeError("targetIds and scenarioIds must be arrays");
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
            scenario: cloneJson(scenario),
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
      metadata: cloneJson(metadata),
      totals,
      results
    };
  }

  return Object.freeze({
    registerTarget,
    registerScenario,
    run,
    listTargets: () => [...targets.values()].map(({ adapter, ...target }) => ({ ...target, capabilities: [...target.capabilities] })),
    listScenarios: () => [...scenarios.values()].map((scenario) => cloneJson(scenario))
  });
}

export const THREAT_LAB_REPORT_SCHEMA = LAB_SCHEMA;
