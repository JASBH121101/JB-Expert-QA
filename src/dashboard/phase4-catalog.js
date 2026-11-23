import { createQaEngineRegistry } from "../engine-registry/index.js";
import { registerApiTestingEngine } from "../engine-registry/adapters/api-testing.js";
import { registerStaticQaEngine } from "../engine-registry/adapters/static-qa.js";
import { registerStaticSecurityQaEngine } from "../engine-registry/adapters/static-security-qa.js";
import { registerRuntimeSecurityQaEngine } from "../engine-registry/adapters/runtime-security-qa.js";
import { registerAccessibilityQaEngine } from "../engine-registry/adapters/accessibility-qa.js";
import { registerPerformanceQaEngine } from "../engine-registry/adapters/performance-qa.js";
import { registerVisualQaEngine } from "../engine-registry/adapters/visual-qa.js";
import { registerReportCertificationEngine } from "../engine-registry/adapters/report-certification.js";

/**
 * Builds the built-in Phase 4 catalog. Registration is metadata-only; the
 * dashboard catalog route never calls these runners. Hosts must separately
 * construct policy/approval-bound orchestration before enabling execution.
 */
export function createDashboardPhase4Catalog(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) {
    throw new TypeError("Dashboard Phase 4 catalog options must be a plain object");
  }
  const allowedKeys = new Set(["apiAllowedOrigins"]);
  const config = Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new TypeError("Dashboard Phase 4 catalog options contain an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Dashboard Phase 4 catalog options cannot contain accessors");
    }
    config[key] = descriptor.value;
  }
  const apiAllowedOrigins = config.apiAllowedOrigins ?? ["https://catalog.invalid"];
  const registry = createQaEngineRegistry();
  registerApiTestingEngine(registry, { allowedOrigins: apiAllowedOrigins });
  registerStaticQaEngine(registry);
  registerStaticSecurityQaEngine(registry);
  registerRuntimeSecurityQaEngine(registry);
  registerAccessibilityQaEngine(registry);
  registerPerformanceQaEngine(registry);
  registerVisualQaEngine(registry);
  registerReportCertificationEngine(registry);
  registry.seal();
  return registry;
}
