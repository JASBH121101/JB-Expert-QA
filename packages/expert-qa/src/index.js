export { auditProject } from "./adapters/filesystem/audit-project.js";
export { scanProject } from "./adapters/filesystem/scan-project.js";
export { ExpertQAEngine } from "./core/engine.js";
export { RuleRegistry, isValidSpecialistId } from "./core/rule-registry.js";
export { validateEngineConfig } from "./core/config.js";
export { createDiagnostic } from "./core/diagnostic.js";
export { calculateScore } from "./core/scoring.js";
export { SEVERITIES, DEFAULT_SEVERITY_PENALTIES } from "./core/severities.js";
export { formatReport, formatHtmlReport, formatMarkdownReport } from "./reporters/index.js";
export { projectRules } from "./specialists/project-rules.js";
export { deadCodeRules } from "./specialists/dead-code-rules.js";
export { EXPERT_QA_PACKAGE_VERSION } from "./version.js";

export { createAuditEngineRegistry, AUDIT_ENGINE_IDS } from "./audit-engines/index.js";

export { createDashboardServer, startDashboard, DEFAULT_DASHBOARD_PORT, DEFAULT_DASHBOARD_HOST } from "./dashboard/server.js";

export { buildDashboardAnalytics, buildConsolidatedReport } from "./dashboard/analytics.js";

export {
  createAutonomousExecutionHostBootstrap,
  bootstrapAutonomousExecutionHost,
  AutonomousExecutionHostBootstrapError
} from "./agent/autonomous-execution-host-bootstrap.js";

export { createPhase4AutonomousHostBootstrap, Phase4AutonomousHostIntegrationError } from "./agent/phase4-autonomous-host-bootstrap.js";

export { createLocalApprovalGate, LocalApprovalGateError } from "./agent/local-approval-gate.js";

export { validateWindowsStorageSecurityReport, WindowsStorageSecurityError } from "./agent/windows-storage-security.js";
