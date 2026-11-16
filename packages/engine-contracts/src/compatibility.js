import { assertEngineManifest } from "./manifest.js";
import { isVersionWithinCompatibilityRange } from "./semver.js";

function findCycle(manifests) {
  const graph = new Map(manifests.map((manifest) => [
    manifest.engineId,
    manifest.dependencies.filter((dependency) =>
      manifests.some((candidate) => candidate.engineId === dependency.engineId))
      .map((dependency) => dependency.engineId)
  ]));
  const visiting = new Set();
  const visited = new Set();
  function visit(engineId, trail) {
    if (visiting.has(engineId)) return [...trail, engineId];
    if (visited.has(engineId)) return null;
    visiting.add(engineId);
    for (const next of graph.get(engineId) ?? []) {
      const cycle = visit(next, [...trail, engineId]);
      if (cycle) return cycle;
    }
    visiting.delete(engineId);
    visited.add(engineId);
    return null;
  }
  for (const engineId of graph.keys()) {
    const cycle = visit(engineId, []);
    if (cycle) return cycle;
  }
  return null;
}

export function evaluateEngineCompatibility(input) {
  const errors = [];
  const warnings = [];
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.engines)) {
    return Object.freeze({
      compatible: false,
      errors: Object.freeze(["engines must be an array"]),
      warnings: Object.freeze([])
    });
  }
  if (input.engines.length > 64) {
    return Object.freeze({
      compatible: false,
      errors: Object.freeze(["engines exceeds the 64-entry limit"]),
      warnings: Object.freeze([])
    });
  }

  const manifests = [];
  for (const [index, manifest] of input.engines.entries()) {
    try {
      assertEngineManifest(manifest);
      manifests.push(manifest);
    } catch (error) {
      errors.push("engines[" + index + "]: " + error.message);
    }
  }
  const ids = manifests.map((manifest) => manifest.engineId);
  if (new Set(ids).size !== ids.length) errors.push("duplicate engineId in integration set");

  const byId = new Map(manifests.map((manifest) => [manifest.engineId, manifest]));
  for (const consumer of manifests) {
    for (const dependency of consumer.dependencies) {
      const provider = byId.get(dependency.engineId);
      if (!provider) {
        if (dependency.optional) warnings.push(consumer.engineId + " optional dependency missing: " + dependency.engineId);
        else errors.push(consumer.engineId + " required dependency missing: " + dependency.engineId);
        continue;
      }
      if (!isVersionWithinCompatibilityRange(provider.version, dependency)) {
        errors.push(consumer.engineId + " requires " + dependency.engineId +
          " in [" + dependency.minVersion + ", major " + dependency.maxMajor + "]");
      }
    }

    for (const requirement of consumer.contractsConsumed) {
      const providers = manifests.flatMap((manifest) =>
        manifest.contractsProvided
          .filter((contract) => contract.id === requirement.id)
          .map((contract) => ({ engineId: manifest.engineId, version: contract.version })));
      const compatibleProvider = providers.find((provider) =>
        isVersionWithinCompatibilityRange(provider.version, requirement));
      if (!compatibleProvider) {
        errors.push(consumer.engineId + " has no compatible provider for contract " + requirement.id);
      }
    }
  }

  const cycle = findCycle(manifests);
  if (cycle) errors.push("dependency cycle detected: " + cycle.join(" -> "));

  return Object.freeze({
    compatible: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings)
  });
}
