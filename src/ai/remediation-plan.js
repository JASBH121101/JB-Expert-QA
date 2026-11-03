import { createGeminiProvider } from "./gemini-provider.js";

const VALID_RISKS = new Set(["low", "medium", "high"]);

function cleanText(value, limit = 400) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

export function validateRemediationPlan(value, { maxTasks = 8 } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("AI remediation plan must be a JSON object");
  }
  if (!Array.isArray(value.tasks)) throw new TypeError("AI remediation plan tasks must be an array");

  const tasks = value.tasks.slice(0, maxTasks).map((task, index) => {
    if (!task || typeof task !== "object" || !VALID_RISKS.has(task.risk)) {
      throw new TypeError("Each plan task needs a valid risk level");
    }
    const paths = Array.isArray(task.target_files)
      ? [...new Set(task.target_files.map((path) => cleanText(path, 240)).filter(Boolean))].slice(0, 5)
      : [];
    return Object.freeze({
      id: cleanText(task.id, 64) || "task-" + (index + 1),
      title: cleanText(task.title, 160),
      rationale: cleanText(task.rationale, 500),
      expectedOutcome: cleanText(task.expected_outcome, 300),
      targetFiles: Object.freeze(paths),
      risk: task.risk,
      requiresHumanApproval: true
    });
  });

  return Object.freeze({
    summary: cleanText(value.summary, 700),
    tasks: Object.freeze(tasks),
    requiresHumanApproval: true,
    autoExecutionAllowed: false
  });
}

export async function createRemediationPlan(auditReport, {
  provider = createGeminiProvider({ model: process.env.GEMINI_TEXT_MODEL }),
  maxTasks = 8,
  projectContext = {}
} = {}) {
  if (!auditReport || typeof auditReport !== "object" ||
      !Array.isArray(auditReport.diagnostics)) {
    throw new TypeError("A valid JB Expert QA audit report is required");
  }
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 20) {
    throw new TypeError("maxTasks must be between 1 and 20");
  }
  if (!provider || typeof provider.generateJson !== "function") {
    throw new TypeError("A compatible AI provider is required");
  }

  const findings = auditReport.diagnostics.slice(0, 60).map((finding) => ({
    id: cleanText(finding.id, 100),
    specialist: cleanText(finding.specialist, 80),
    title: cleanText(finding.title, 180),
    description: cleanText(finding.description, 400),
    severity: finding.severity,
    location: cleanText(finding.location, 220),
    recommendation: cleanText(finding.recommendation, 400),
    metadata: finding.metadata || {}
  }));

  const raw = await provider.generateJson({
    systemInstruction: [
      "You are the planning component of JB Expert QA, a supervised software maintenance agent.",
      "Convert deterministic audit findings into a short ordered remediation plan.",
      "Do not invent files, facts or vulnerabilities. Refer only to paths in the audit evidence.",
      "Never plan changes to secrets, authentication, authorization, payments, production data, database migrations, infrastructure, deployment workflows or billing.",
      "High-risk work must be marked high and must never be auto-executed.",
      "Every task requires human approval, even when risk is low.",
      "Do not generate code or patches in this planning step.",
      "Return JSON only with summary and tasks. Each task requires id, title, rationale, expected_outcome, target_files and risk."
    ].join(" "),
    prompt: [
      "Create a remediation plan for this JB Expert QA audit.",
      "Project context (metadata only): " + JSON.stringify(projectContext),
      "Audit status: " + JSON.stringify({
        passed: auditReport.scoring ? auditReport.scoring.passed : null,
        score: auditReport.scoring ? auditReport.scoring.score : null,
        analysisScope: auditReport.analysisScope || null
      }),
      "Findings: " + JSON.stringify(findings),
      "Return at most " + maxTasks + " ordered tasks. Group related findings where useful.",
      "Do not include source code. Do not claim a recommendation has been applied."
    ].join("\n"),
    maxOutputTokens: 1600
  });

  return Object.freeze({
    provider: provider.provider || "configured-provider",
    model: provider.model || null,
    plan: validateRemediationPlan(raw, { maxTasks })
  });
}
