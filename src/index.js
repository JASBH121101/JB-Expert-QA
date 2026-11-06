export { ExpertQAEngine } from "./core/engine.js";
export { RuleRegistry, isValidSpecialistId } from "./core/rule-registry.js";
export { validateEngineConfig } from "./core/config.js";
export { createDiagnostic } from "./core/diagnostic.js";
export { calculateScore } from "./core/scoring.js";
export { SEVERITIES, DEFAULT_SEVERITY_PENALTIES } from "./core/severities.js";
export {
  responsiveRules,
  uiUxRules,
  accessibilityRules,
  performanceRules,
  functionalRules,
  consistencyRules,
  SPECIALIST_IDS
} from "./specialists/index.js";
export {
  codeQualityRules,
  securityRules,
  dependencyRules,
  databaseRules,
  projectRules
} from "./specialists/project-rules.js";
export { securityDefenseRules } from "./specialists/security-rules.js";
export { securityRuntimeRules } from "./specialists/runtime-security-rules.js";
export { scanProject } from "./adapters/filesystem/scan-project.js";
export { auditProject } from "./adapters/filesystem/audit-project.js";
export { auditSecurityProject } from "./adapters/filesystem/audit-security-project.js";
export { auditSecurityUrl } from "./adapters/filesystem/audit-security-url.js";
export { formatReport, formatMarkdownReport, formatHtmlReport } from "./reporters/index.js";

export { auditUrl, auditViewports, DEFAULT_VIEWPORTS } from "./adapters/playwright/audit-url.js";
export { comparePngBuffers, comparePngFiles } from "./adapters/visual/png-diff.js";
export { createGeminiProvider } from "./ai/gemini-provider.js";
export {
  createCloudflareProvider,
  CLOUDFLARE_TEXT_MODEL,
  CLOUDFLARE_VISION_MODEL
} from "./ai/cloudflare-provider.js";
export { createAiProviderRouter } from "./ai/provider-router.js";
export { reviewScreenshot, reviewViewportScreenshots, validateVisualReview } from "./ai/visual-review.js";
export { createRemediationPlan, validateRemediationPlan } from "./ai/remediation-plan.js";
export { runAutopilot } from "./agent/autopilot.js";
export { evaluatePatchPaths, normalizeProjectPath, redactSourceForAI, validateUnifiedPatch } from "./agent/policy.js";
export {
  SECURITY_BRIDGE_PROTOCOL,
  SECURITY_BRIDGE_DECISION_SCHEMA,
  SECURITY_BRIDGE_PRODUCERS,
  SecurityBridgeError,
  createSecurityAssessment,
  validateSecurityAssessment,
  signSecurityAssessment,
  verifySecurityAssessmentEnvelope,
  signSecurityBridgeDecision,
  verifySecurityBridgeDecisionResponse,
  createSecurityBridgeCoordinator,
  createSecurityBridgeServer
} from "./security-bridge/index.js";
