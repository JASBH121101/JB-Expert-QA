import { auditProject } from "../adapters/filesystem/audit-project.js";
import { auditSecurityProject } from "../adapters/filesystem/audit-security-project.js";
import { auditSecurityUrl } from "../adapters/filesystem/audit-security-url.js";
import { auditUrl, auditViewports } from "../adapters/playwright/audit-url.js";

const DEFINITIONS = Object.freeze([
  {
    id: "static",
    name: "Static QA",
    mode: "local-static",
    target: "path",
    description: "Read-only source, dependency-manifest, dead-code and language audit.",
    capabilities: Object.freeze(["source", "dependencies", "dead-code", "language"])
  },
  {
    id: "live-site",
    name: "Live Site QA",
    mode: "browser-runtime",
    target: "url",
    description: "Browser-based navigation, runtime, HTTP, form, accessibility and UI audit.",
    capabilities: Object.freeze(["navigation", "http", "runtime", "forms", "accessibility", "ui"])
  },
  {
    id: "responsive",
    name: "Responsive QA",
    mode: "viewport-matrix",
    target: "url",
    description: "Runs the browser audit across the configured mobile, tablet and desktop viewport matrix.",
    capabilities: Object.freeze(["mobile", "tablet", "desktop", "overflow"])
  },
  {
    id: "accessibility",
    name: "Accessibility QA",
    mode: "specialist-browser",
    target: "url",
    specialist: "accessibility",
    description: "Runs the browser accessibility specialist and axe-core checks.",
    capabilities: Object.freeze(["axe-core", "labels", "alternative-text", "wcag"])
  },
  {
    id: "performance",
    name: "Performance QA",
    mode: "specialist-browser",
    target: "url",
    specialist: "performance",
    description: "Runs browser resource, image-dimension and DOM-size performance rules.",
    capabilities: Object.freeze(["resource-size", "resource-duration", "image-dimensions", "dom-size"])
  },
  {
    id: "security",
    name: "Security QA",
    mode: "static-or-runtime",
    target: "path-or-url",
    description: "Runs the existing static project or runtime website security auditor.",
    capabilities: Object.freeze(["static-security", "runtime-headers", "transport", "cookies"])
  },
  {
    id: "visual",
    name: "Visual QA",
    mode: "visual-viewport-matrix",
    target: "url",
    description: "Runs the visual/layout viewport audit; pixel-baseline comparison is enabled only when baseline and screenshot directories are supplied.",
    capabilities: Object.freeze(["layout-integrity", "theme", "screenshots", "pixel-baselines"])
  }
]);

const DEFINITION_BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

function readPlainRecord(value, name) {
  if (value === undefined || value === null) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " must be a plain object");
  }
  return Object.freeze({ ...value });
}

function readTargetString(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(name + " must be a non-empty string");
  }
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(name + " exceeds its safe input boundary");
  }
  return normalized;
}

function normalizeTarget(engineId, input) {
  const definition = DEFINITION_BY_ID.get(engineId);
  if (!definition) throw new TypeError("Unknown audit engine: " + engineId);
  const target = readPlainRecord(input, "Audit target");
  const keys = Object.keys(target);
  const allowed = definition.target === "path-or-url" ? ["path", "url"] :
    definition.target === "path" ? ["path"] : ["url"];
  if (keys.some((key) => !allowed.includes(key))) {
    throw new TypeError("Unexpected target field for " + engineId + " audit");
  }

  if (definition.target === "path-or-url") {
    const hasPath = Object.hasOwn(target, "path");
    const hasUrl = Object.hasOwn(target, "url");
    if (hasPath === hasUrl) {
      throw new TypeError("Security audit requires exactly one of target.path or target.url");
    }
    return Object.freeze(hasPath
      ? { path: readTargetString(target.path, "target.path", 4096) }
      : { url: readTargetString(target.url, "target.url", 2048) });
  }
  const field = definition.target;
  return Object.freeze({
    [field]: readTargetString(target[field], "target." + field, field === "path" ? 4096 : 2048)
  });
}

const DEFAULT_ADAPTERS = Object.freeze({
  static: (target, options) => auditProject(target.path, options),
  "live-site": (target, options) => auditUrl(target.url, options),
  responsive: (target, options) => auditViewports(target.url, options),
  accessibility: (target, options) => auditUrl(target.url, options),
  performance: (target, options) => auditUrl(target.url, options),
  security: (target, options) => Object.hasOwn(target, "path")
    ? auditSecurityProject(target.path, options)
    : auditSecurityUrl(target.url, options),
  visual: (target, options) => auditViewports(target.url, options)
});

export const AUDIT_ENGINE_IDS = Object.freeze(DEFINITIONS.map((definition) => definition.id));

/**
 * Creates the built-in QA audit adapter registry.
 *
 * Adapter overrides are intended for controlled host integration and tests.
 * Production callers should use the built-in implementations unless they own
 * and independently validate the replacement handlers.
 */
export function createAuditEngineRegistry({ adapters = {} } = {}) {
  const suppliedAdapters = readPlainRecord(adapters, "adapters");
  const runners = { ...DEFAULT_ADAPTERS };
  for (const [id, runner] of Object.entries(suppliedAdapters)) {
    if (!DEFINITION_BY_ID.has(id)) throw new TypeError("Unknown audit adapter: " + id);
    if (typeof runner !== "function") throw new TypeError("Audit adapter " + id + " must be a function");
    runners[id] = runner;
  }

  return Object.freeze({
    list() {
      return Object.freeze(DEFINITIONS.map((definition) => definition));
    },
    get(engineId) {
      return DEFINITION_BY_ID.get(engineId) ?? null;
    },
    async run(engineId, input, options = {}) {
      if (typeof engineId !== "string" || !DEFINITION_BY_ID.has(engineId)) {
        throw new TypeError("Unknown audit engine: " + String(engineId));
      }
      const target = normalizeTarget(engineId, input);
      const safeOptions = readPlainRecord(options, "Audit options");
      const requiredSpecialist = DEFINITION_BY_ID.get(engineId).specialist;
      const effectiveOptions = requiredSpecialist
        ? Object.freeze({ ...safeOptions, specialist: requiredSpecialist })
        : safeOptions;
      return runners[engineId](target, effectiveOptions);
    }
  });
}
