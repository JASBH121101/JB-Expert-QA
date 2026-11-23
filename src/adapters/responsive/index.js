import { auditViewports, DEFAULT_VIEWPORTS } from "../playwright/audit-url.js";

export const RESPONSIVE_QA_LIMITS = Object.freeze({
  maxViewports: 9,
  maxThemes: 2,
  maxResults: 18,
  maxFindingsPerViewport: 25,
  maxInteractionActions: 8
});

function validateMatrix(viewports, themes) {
  if (!Array.isArray(viewports) || viewports.length < 1 ||
      viewports.length > RESPONSIVE_QA_LIMITS.maxViewports) {
    throw new TypeError("Responsive QA supports 1 to 9 viewports");
  }
  if (!Array.isArray(themes) || themes.length < 1 ||
      themes.length > RESPONSIVE_QA_LIMITS.maxThemes ||
      themes.some((theme) => !["light", "dark"].includes(theme)) ||
      new Set(themes).size !== themes.length) {
    throw new TypeError("Responsive QA themes must contain light, dark, or both without duplicates");
  }
  if (viewports.length * themes.length > RESPONSIVE_QA_LIMITS.maxResults) {
    throw new TypeError("Responsive QA result matrix exceeds the 18-result limit");
  }
}

function boundedResult(item) {
  const findings = Array.isArray(item.findings) ? item.findings : [];
  return Object.freeze({
    name: item.name,
    theme: item.theme,
    viewport: item.viewport,
    passed: item.passed === true,
    score: item.score,
    findings: Object.freeze(findings.slice(0, RESPONSIVE_QA_LIMITS.maxFindingsPerViewport)),
    findingsTruncated: findings.length > RESPONSIVE_QA_LIMITS.maxFindingsPerViewport,
    summary: item.summary,
    execution: item.execution,
    screenshotPath: item.screenshotPath ?? null,
    visualComparison: item.visualComparison ?? null
  });
}

export function createResponsiveQaAdapter({ audit = auditViewports } = {}) {
  if (typeof audit !== "function") {
    throw new TypeError("Responsive QA audit implementation must be a function");
  }

  return async function runResponsiveQa(target, options = {}) {
    if (!target || typeof target.url !== "string" || !target.url.trim()) {
      throw new TypeError("Responsive QA target.url must be a non-empty string");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Responsive QA options must be an object");
    }

    const viewports = options.viewports ?? DEFAULT_VIEWPORTS;
    const themes = options.themes ?? ["light"];
    validateMatrix(viewports, themes);

    const interactionExploration = options.interactionExploration === true;
    const maxInteractionActions = options.maxInteractionActions ?? RESPONSIVE_QA_LIMITS.maxInteractionActions;
    if (!Number.isInteger(maxInteractionActions) || maxInteractionActions < 1 ||
        maxInteractionActions > RESPONSIVE_QA_LIMITS.maxInteractionActions) {
      throw new TypeError("Responsive QA maxInteractionActions must be between 1 and 8");
    }

    // No implicit expansion: max 9 x 2 viewport/theme captures. Interaction
    // exploration is opt-in and capped. Baseline writes require explicit true.
    const report = await audit(target.url, {
      ...options,
      viewports,
      themes,
      interactionExploration,
      maxInteractionActions,
      updateBaselines: options.updateBaselines === true,
      screenshotFullPage: options.screenshotFullPage === true
    });

    const viewportsReport = Array.isArray(report.viewports) ? report.viewports : [];
    return Object.freeze({
      engine: "responsive",
      limits: RESPONSIVE_QA_LIMITS,
      summary: report.summary ?? null,
      passed: report.passed === true,
      themeComparisons: Object.freeze((report.themeComparisons ?? []).slice(0, 9)),
      viewports: Object.freeze(viewportsReport.slice(0, RESPONSIVE_QA_LIMITS.maxResults).map(boundedResult))
    });
  };
}

export const runResponsiveQa = createResponsiveQaAdapter();
