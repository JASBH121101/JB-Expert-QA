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
export { deadCodeRules } from "./specialists/dead-code-rules.js";
export { securityDefenseRules } from "./specialists/security-rules.js";
export { securityRuntimeRules } from "./specialists/runtime-security-rules.js";
export { scanProject } from "./adapters/filesystem/scan-project.js";
export { auditProject } from "./adapters/filesystem/audit-project.js";
export { auditSecurityProject } from "./adapters/filesystem/audit-security-project.js";
export { auditSecurityUrl } from "./adapters/filesystem/audit-security-url.js";
export { formatReport, formatMarkdownReport, formatHtmlReport } from "./reporters/index.js";

export { auditUrl, auditViewports, DEFAULT_VIEWPORTS, FULL_VIEWPORTS } from "./adapters/playwright/audit-url.js";
export { collectVisualIntegrity, DEFAULT_PRESERVED_TERMS } from "./adapters/playwright/visual-integrity.js";
export { classifyUpdate, evaluateHybridUpdate, HYBRID_UPDATE_POLICY, ENGINE_PACKAGES } from "./update-manager/policy.js";
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
export { createAutonomousExecutionEngine } from "./agent/autonomous-execution.js";
export { createAutonomousExecutionRuntime, AutonomousExecutionRuntimeError } from "./agent/execution-runtime.js";
export { createExecutionJobQueue, ExecutionJobQueueError } from "./agent/execution-job-queue.js";
export {
  createJsonFileExecutionJobStore,
  createPersistentExecutionJobQueue,
  ExecutionJobStoreError
} from "./agent/execution-job-persistence.js";
export { createExecutionWorker, ExecutionWorkerError } from "./agent/execution-worker.js";
export { createExecutionLifecycleSupervisor, ExecutionLifecycleSupervisorError } from "./agent/execution-supervisor.js";
export { createExecutionEventJournal, ExecutionEventJournalError } from "./agent/execution-event-journal.js";
export { createPersistentExecutionEventJournal } from "./agent/execution-event-journal-persistence.js";
export { createLocalProcessEngineRunner, LocalProcessEngineRunnerError } from "./agent/execution-process-runner.js";
export { createLinuxCgroupV2ResourceController, LinuxCgroupV2ResourceControllerError } from "./agent/linux-cgroup-v2-resource-controller.js";
export { createInMemoryExecutionLedger, createJsonlExecutionLedger, verifyExecutionLedger, digestExecutionValue } from "./agent/execution-ledger.js";
export { evaluatePatchPaths, normalizeProjectPath, redactSourceForAI, validateUnifiedPatch } from "./agent/policy.js";
export {
  SECURITY_BRIDGE_PROTOCOL,
  SECURITY_BRIDGE_DECISION_SCHEMA,
  SECURITY_BRIDGE_PRODUCERS,
  SecurityBridgeError,
  createSecurityAssessment,
  createExpertQAAssessment,
  validateSecurityAssessment,
  signSecurityAssessment,
  verifySecurityAssessmentEnvelope,
  signSecurityBridgeDecision,
  verifySecurityBridgeDecisionResponse,
  createSecurityBridgeCoordinator,
  createSecurityBridgeServer
} from "./security-bridge/index.js";

export { auditDatabaseProject } from "./adapters/filesystem/audit-database.js";
export { databaseSpecialistRules, existingDatabaseRules, operationalDatabaseRules } from "./specialists/database/index.js";

export { auditPostgresDatabase, createPostgresClient } from "./adapters/database/postgres.js";
export { auditLanguageFiles } from "./adapters/filesystem/audit-language.js";
export * from "./language/index.js";
export { languageRules } from "./specialists/language/index.js";

export { createAuditEngineRegistry, AUDIT_ENGINE_IDS } from "./audit-engines/index.js";
export { runResponsiveQa, RESPONSIVE_QA_LIMITS } from "./adapters/responsive/index.js";

export { createDashboardServer, startDashboard, DEFAULT_DASHBOARD_PORT, DEFAULT_DASHBOARD_HOST } from "./dashboard/server.js";

export { buildDashboardAnalytics, buildConsolidatedReport } from "./dashboard/analytics.js";

export { createQaEngineRegistry, QaEngineRegistryError, QA_ENGINE_ADAPTER_CONTRACT } from "./engine-registry/index.js";

export { createApiTestingEngineAdapter, registerApiTestingEngine, ApiTestingAdapterError, API_TESTING_ADAPTER_ID, API_TESTING_ADAPTER_VERSION, API_TESTING_ADAPTER_OPERATIONS } from "./engine-registry/adapters/api-testing.js";

export {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QaEngineOrchestratorError,
  QA_ENGINE_ACTION_PREFIX,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "./engine-registry/orchestrator.js";

export {
  createStaticQaEngineAdapter,
  registerStaticQaEngine,
  StaticQaAdapterError,
  STATIC_QA_ADAPTER_ID,
  STATIC_QA_ADAPTER_VERSION,
  STATIC_QA_ADAPTER_CAPABILITIES
} from "./engine-registry/adapters/static-qa.js";

export {
  createStaticSecurityQaEngineAdapter,
  registerStaticSecurityQaEngine,
  StaticSecurityQaAdapterError,
  STATIC_SECURITY_QA_ADAPTER_ID,
  STATIC_SECURITY_QA_ADAPTER_VERSION,
  STATIC_SECURITY_QA_ADAPTER_CAPABILITIES
} from "./engine-registry/adapters/static-security-qa.js";

export {
  createRuntimeSecurityQaEngineAdapter,
  registerRuntimeSecurityQaEngine,
  RuntimeSecurityQaAdapterError,
  RUNTIME_SECURITY_QA_ADAPTER_ID,
  RUNTIME_SECURITY_QA_ADAPTER_VERSION,
  RUNTIME_SECURITY_QA_ADAPTER_CAPABILITIES
} from "./engine-registry/adapters/runtime-security-qa.js";

export {
  createAccessibilityQaEngineAdapter,
  registerAccessibilityQaEngine,
  AccessibilityQaAdapterError,
  ACCESSIBILITY_QA_ADAPTER_ID,
  ACCESSIBILITY_QA_ADAPTER_VERSION,
  ACCESSIBILITY_QA_ADAPTER_CAPABILITIES
} from "./engine-registry/adapters/accessibility-qa.js";

export {
  createPerformanceQaEngineAdapter,
  registerPerformanceQaEngine,
  PerformanceQaAdapterError,
  PERFORMANCE_QA_ADAPTER_ID,
  PERFORMANCE_QA_ADAPTER_VERSION,
  PERFORMANCE_QA_ADAPTER_CAPABILITIES
} from "./engine-registry/adapters/performance-qa.js";

export {
  createVisualQaEngineAdapter,
  registerVisualQaEngine,
  VisualQaAdapterError,
  VISUAL_QA_ADAPTER_ID,
  VISUAL_QA_ADAPTER_VERSION,
  VISUAL_QA_ADAPTER_CAPABILITIES,
  VISUAL_QA_LIMITS
} from "./engine-registry/adapters/visual-qa.js";

export {
  createReportCertificationEngineAdapter,
  registerReportCertificationEngine,
  ReportCertificationAdapterError,
  REPORT_CERTIFICATION_ADAPTER_ID,
  REPORT_CERTIFICATION_ADAPTER_VERSION,
  REPORT_CERTIFICATION_ADAPTER_CAPABILITIES,
  REPORT_CERTIFICATION_LIMITS
} from "./engine-registry/adapters/report-certification.js";

export {
  createDashboardPhase4Execution,
  DashboardPhase4ExecutionError
} from "./dashboard/phase4-execution.js";

export { createDashboardPhase4Catalog } from "./dashboard/phase4-catalog.js";

export { createWindowsJobObjectResourceController, WindowsJobObjectResourceControllerError } from "./agent/windows-job-object-resource-controller.js";

export { detectContainmentCapabilities } from "./agent/containment-capability-detection.js";
export { createContainmentPolicy, ContainmentPolicyError } from "./agent/containment-policy.js";

export { createContainmentControllerDispatcher, ContainmentControllerDispatchError } from "./agent/containment-controller-dispatch.js";

export { createContainedLocalProcessEngineRunner, ContainedProcessEngineRunnerError } from "./agent/contained-process-runner.js";
