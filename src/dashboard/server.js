import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditEngineRegistry } from "../audit-engines/index.js";
import { buildDashboardAnalytics, buildConsolidatedReport } from "./analytics.js";
import { createDashboardPhase4Catalog } from "./phase4-catalog.js";
import { isDashboardPhase4ExecutionBoundTo } from "./phase4-execution.js";

export const DEFAULT_DASHBOARD_PORT = 4173;
export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_HISTORY_LIMIT = 50;
export const DEFAULT_DASHBOARD_BODY_LIMIT = 16 * 1024;
const PUBLIC_DIRECTORY = fileURLToPath(new URL("./public/", import.meta.url));
const HISTORY_BYTE_LIMIT = 12 * 1024 * 1024;
const FINDING_LIMIT = 100;

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function cleanText(value, limit = 700) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}
function targetLabel(target) {
  if (Object.hasOwn(target, "path")) return "Project: " + (basename(resolve(target.path)) || "project");
  const url = new URL(target.url);
  return "Website: " + url.origin + url.pathname.slice(0, 180);
}
function targetHash(engineId, target) {
  const value = Object.hasOwn(target, "path") ? resolve(target.path) : target.url;
  return createHash("sha256").update(engineId + "\n" + value).digest("hex");
}
function normalizeFindings(report) {
  const entries = [];
  if (Array.isArray(report?.diagnostics)) {
    for (const item of report.diagnostics) entries.push({ item, viewport: "", theme: "" });
  } else if (Array.isArray(report?.viewports)) {
    for (const viewport of report.viewports) {
      for (const item of viewport.findings ?? []) entries.push({ item, viewport: viewport.name ?? "", theme: viewport.theme ?? "" });
    }
  }
  return entries.map(({ item, viewport, theme }) => ({
    id: cleanText(item.id, 120),
    ruleId: cleanText(item.ruleId, 160),
    title: cleanText(item.title || "QA finding", 240),
    description: cleanText(item.description, 700),
    severity: cleanText(item.severity || "info", 24).toLowerCase(),
    recommendation: cleanText(item.recommendation, 700),
    location: cleanText(item.location, 240),
    viewport: cleanText(viewport, 60),
    theme: cleanText(theme, 20)
  }));
}
function issueKey(item) {
  return [item.ruleId || item.id || item.title, item.location, item.viewport, item.theme].join("|").toLowerCase();
}
function reference(item) {
  return { title: item.title, severity: item.severity, location: item.location, viewport: item.viewport, theme: item.theme };
}
function makeComparison(history, record) {
  const previous = history.find((entry) => entry.engineId === record.engineId && entry.targetHash === record.targetHash);
  if (!previous) return null;
  const oldMap = new Map(previous.findings.map((item) => [issueKey(item), item]));
  const newMap = new Map(record.findings.map((item) => [issueKey(item), item]));
  const added = [...newMap.entries()].filter(([key]) => !oldMap.has(key)).map(([, item]) => reference(item));
  const resolved = [...oldMap.entries()].filter(([key]) => !newMap.has(key)).map(([, item]) => reference(item));
  return {
    previousRunId: previous.id,
    previousCreatedAt: previous.createdAt,
    scoreDelta: Number.isFinite(record.score) && Number.isFinite(previous.score) ? record.score - previous.score : null,
    findingsDelta: record.findingsCount - previous.findingsCount,
    newFindingsCount: added.length,
    resolvedFindingsCount: resolved.length,
    newFindings: added.slice(0, 10),
    resolvedFindings: resolved.slice(0, 10)
  };
}
function summarize(engineId, report) {
  const findings = normalizeFindings(report);
  const summary = isRecord(report?.summary) ? report.summary : {};
  const scores = (report?.viewports ?? []).map((item) => item.score).filter(Number.isFinite);
  const score = Number.isFinite(report?.scoring?.score) ? report.scoring.score :
    scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const count = Number.isFinite(summary.totalFindings) ? summary.totalFindings :
    Number.isFinite(summary.findings) ? summary.findings : findings.length;
  const passed = (typeof report?.passed === "boolean" ? report.passed : report?.scoring?.passed === true) &&
    Number(summary.rulesWithErrors ?? 0) === 0;
  return {
    engineId,
    score,
    findingsCount: count,
    outcome: !passed ? "not_passed" : count ? "passed_with_observations" : "passed",
    findings: findings.slice(0, FINDING_LIMIT),
    findingsOmitted: Math.max(0, findings.length - FINDING_LIMIT),
    summary: {
      rulesExecuted: Number.isFinite(summary.rulesExecuted) ? summary.rulesExecuted : null,
      rulesWithErrors: Number.isFinite(summary.rulesWithErrors) ? summary.rulesWithErrors : 0,
      viewportsChecked: Number.isFinite(summary.viewportsChecked) ? summary.viewportsChecked : null,
      passedViewports: Number.isFinite(summary.passedViewports) ? summary.passedViewports : null,
      failedViewports: Number.isFinite(summary.failedViewports) ? summary.failedViewports : null
    },
    screenshots: engineId === "visual"
      ? [...new Set((report?.viewports ?? []).map((item) => typeof item.screenshotPath === "string" ? basename(item.screenshotPath) : null)
          .filter((name) => name && /^[a-z0-9_-]+\.png$/i.test(name)))]
      : []
  };
}
function compactRecord(record) {
  return {
    id: record.id, createdAt: record.createdAt, engineId: record.engineId, engineName: record.engineName,
    targetLabel: record.targetLabel, outcome: record.outcome, score: record.score,
    findingsCount: record.findingsCount, durationMs: record.durationMs,
    comparison: record.comparison, screenshots: record.screenshots
  };
}
function markdown(value) {
  return cleanText(value, 240).replace(/\|/g, "\\|");
}
function certificate(record) {
  const lines = [
    "# JB Expert QA — Internal QA Certification Report", "",
    "- **Run ID:** " + record.id,
    "- **Engine:** " + record.engineName + " (" + record.engineId + ")",
    "- **Target:** " + record.targetLabel,
    "- **Executed:** " + record.createdAt,
    "- **Duration:** " + record.durationMs + " ms",
    "- **Outcome:** " + record.outcome.replace(/_/g, " ").toUpperCase(),
    "- **Score:** " + (Number.isFinite(record.score) ? record.score + "/100" : "Not reported"),
    "- **Findings:** " + record.findingsCount, "",
    "## Findings", "",
    "| Severity | Finding | Location | Viewport |",
    "| --- | --- | --- | --- |"
  ];
  if (!record.findings.length) lines.push("| — | No findings recorded | — | — |");
  for (const item of record.findings) {
    lines.push("| " + markdown(item.severity) + " | " + markdown(item.title) + " | " +
      markdown(item.location || "—") + " | " + markdown(item.viewport || "—") + " |");
  }
  if (record.findingsOmitted) lines.push("", record.findingsOmitted + " additional findings were omitted.");
  if (record.comparison) {
    lines.push("", "## Comparison with previous run", "",
      "- Previous run: " + record.comparison.previousRunId,
      "- Score change: " + (record.comparison.scoreDelta === null ? "Not available" : record.comparison.scoreDelta),
      "- Findings change: " + record.comparison.findingsDelta,
      "- New findings: " + record.comparison.newFindingsCount,
      "- Resolved findings: " + record.comparison.resolvedFindingsCount);
  }
  lines.push("", "## Scope and limitations", "",
    "This is an internal report for the selected checks. It is not independent third-party certification, a penetration test, an accessibility conformance statement, or proof of production readiness.",
    "Static rules are heuristic. Browser audits are bounded observations of the supplied target. Absence of findings does not prove absence of defects.", "");
  return lines.join("\n");
}
function send(response, status, body, type = "application/json; charset=utf-8", headers = {}) {
  if (response.headersSent || response.writableEnded) return response.destroy();
  response.statusCode = status;
  response.setHeader("Content-Type", type);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.end(body);
}
function json(response, status, value, headers) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8", headers);
}
function fail(response, status, code, message) {
  json(response, status, { error: code, message });
}
async function readBody(request, maxBytes) {
  const type = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    const error = new Error("Content-Type must be application/json"); error.statusCode = 415; throw error;
  }
  const length = request.headers["content-length"];
  if (length !== undefined) {
    if (!/^\d+$/.test(String(length))) { const error = new Error("Invalid Content-Length"); error.statusCode = 400; throw error; }
    if (Number(length) > maxBytes) { const error = new Error("Request body exceeds the dashboard limit"); error.statusCode = 413; throw error; }
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) { const error = new Error("Request body exceeds the dashboard limit"); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { const error = new Error("Request body must contain valid JSON"); error.statusCode = 400; throw error; }
  if (!isRecord(value)) { const error = new Error("Request body must be a JSON object"); error.statusCode = 400; throw error; }
  return value;
}
function validateRun(body, registry) {
  if (Object.keys(body).some((key) => !["engineId", "target"].includes(key)) ||
      !Object.hasOwn(body, "engineId") || !Object.hasOwn(body, "target")) {
    throw new TypeError("Run request must contain only engineId and target");
  }
  if (typeof body.engineId !== "string" || !registry.get(body.engineId)) throw new TypeError("Select a supported QA engine");
  if (!isRecord(body.target)) throw new TypeError("Target must be an object");
  const definition = registry.get(body.engineId);
  const keys = Object.keys(body.target);
  if (definition.target === "path-or-url") {
    if (keys.length !== 1 || !["path", "url"].includes(keys[0])) throw new TypeError("Security QA requires one local path or website URL");
  } else {
    const required = definition.target === "path" ? "path" : "url";
    if (keys.length !== 1 || keys[0] !== required) throw new TypeError("This engine requires target." + required);
  }
  return { engineId: body.engineId, target: body.target };
}
async function ensureStorage(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Dashboard storage must be a real directory");
  await chmod(directory, 0o700).catch(() => {});
}
async function loadHistory(directory, limit) {
  await ensureStorage(directory);
  const file = join(directory, "history.json");
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Dashboard history must be a regular file");
    const entries = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(entries)) throw new Error("Dashboard history is malformed");
    return entries.filter((entry) => isRecord(entry) && typeof entry.id === "string" &&
      typeof entry.engineId === "string" && typeof entry.targetHash === "string").slice(0, limit);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
async function saveHistory(directory, entries, limit) {
  await ensureStorage(directory);
  const file = join(directory, "history.json");
  const retained = entries.slice(0, limit);
  let serialized = JSON.stringify(retained);
  while (Buffer.byteLength(serialized) > HISTORY_BYTE_LIMIT && retained.length > 1) {
    retained.pop();
    serialized = JSON.stringify(retained);
  }
  if (Buffer.byteLength(serialized) > HISTORY_BYTE_LIMIT) throw new Error("Dashboard history limit reached");
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temp, file);
  await chmod(file, 0o600).catch(() => {});
  return retained;
}
function validateHost(request, port) {
  const value = String(request.headers.host ?? "").toLowerCase();
  return value === "127.0.0.1:" + port || value === "localhost:" + port;
}
function sameOrigin(request) {
  return typeof request.headers.origin === "string" && request.headers.origin === "http://" + request.headers.host;
}
function rateAllowed(requests, limit = 15) {
  const now = Date.now();
  while (requests.length && now - requests[0] > 60_000) requests.shift();
  if (requests.length >= limit) return false;
  requests.push(now);
  return true;
}
async function publicAsset(pathname) {
  const assets = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/assets/app.css": ["app.css", "text/css; charset=utf-8"],
    "/assets/app.js": ["app.js", "text/javascript; charset=utf-8"]
  };
  const item = assets[pathname];
  return item ? { body: await readFile(join(PUBLIC_DIRECTORY, item[0])), type: item[1] } : null;
}

export function createDashboardServer({
  registry = createAuditEngineRegistry(),
  storageDirectory = resolve(process.cwd(), ".jb-expert-qa", "dashboard"),
  maximumHistoryRecords = DEFAULT_DASHBOARD_HISTORY_LIMIT,
  maximumBodyBytes = DEFAULT_DASHBOARD_BODY_LIMIT,
  phase4Registry = createDashboardPhase4Catalog(),
  phase4Execution = null
} = {}) {
  if (!registry || typeof registry.list !== "function" || typeof registry.get !== "function" || typeof registry.run !== "function") {
    throw new TypeError("A valid QA audit engine registry is required");
  }
  if (!Number.isInteger(maximumHistoryRecords) || maximumHistoryRecords < 1 || maximumHistoryRecords > 200) {
    throw new TypeError("maximumHistoryRecords must be between 1 and 200");
  }
  if (!Number.isInteger(maximumBodyBytes) || maximumBodyBytes < 1024 || maximumBodyBytes > 65_536) {
    throw new TypeError("maximumBodyBytes must be between 1024 and 65536");
  }
  if (!phase4Registry || typeof phase4Registry.list !== "function" ||
      typeof phase4Registry.isSealed !== "function" || phase4Registry.isSealed() !== true) {
    throw new TypeError("phase4Registry must be a sealed JB QA engine registry");
  }
  if (phase4Execution !== null && !isDashboardPhase4ExecutionBoundTo(phase4Execution, phase4Registry)) {
    throw new TypeError("phase4Execution must be created for the same sealed phase4Registry");
  }
  const dataDir = resolve(storageDirectory);
  const rateWindow = [];
  const phase4ExecutionRateWindow = [];
  let busy = false;

  const server = createServer(async (request, response) => {
    try {
      const port = server.address()?.port;
      if (!port || !validateHost(request, port)) {
        fail(response, 421, "misdirected_request", "Use the loopback dashboard address printed by the server"); return;
      }
      const fetchSite = request.headers["sec-fetch-site"];
      if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
        fail(response, 403, "cross_origin_blocked", "Cross-origin dashboard requests are not allowed"); return;
      }
      const requestUrl = new URL(request.url ?? "/", "http://" + request.headers.host);
      const pathname = requestUrl.pathname;

      if (request.method === "GET") {
        const asset = await publicAsset(pathname);
        if (asset) { send(response, 200, asset.body, asset.type); return; }
        if (pathname === "/api/engines") { json(response, 200, { engines: registry.list() }); return; }
        if (pathname === "/api/phase4/engines") {
          const engines = phase4Registry.list();
          json(response, 200, { engines: engines.map((engine) => ({
            id: engine.id, name: engine.name, version: engine.version, category: engine.category,
            targetType: engine.targetType, executionMode: engine.executionMode,
            capabilities: [...engine.capabilities], description: engine.description
          })), executionEnabled: Boolean(phase4Execution), approvalRequired: true }); return;
        }
        if (pathname === "/api/phase4/execution") {
          json(response, 200, phase4Execution ? phase4Execution.getStatus() : {
            enabled: false, policyId: null, approvalRequired: true,
            permission: "qa:engine-execute", allowedEngineIds: [],
            reason: "Host policy and external approval provider are not configured"
          }); return;
        }
        if (pathname === "/api/phase4/audit") {
          if (!phase4Execution) {
            json(response, 200, {
              enabled: false,
              approvalRequired: true,
              reason: "Execution ledger is unavailable until the host configures the Phase 4 policy and approval provider",
              integrity: null,
              pagination: { limit: 50, total: 0, hasMore: false, nextBeforeSequence: null },
              records: []
            });
            return;
          }
          const limitValues = requestUrl.searchParams.getAll("limit");
          const cursorValues = requestUrl.searchParams.getAll("before");
          if (limitValues.length > 1 || cursorValues.length > 1) {
            fail(response, 400, "invalid_audit_query", "Audit pagination parameters must not be repeated"); return;
          }
          const limitText = limitValues[0] ?? "50";
          const limit = /^(?:[1-9][0-9]?|100)$/u.test(limitText) ? Number(limitText) : NaN;
          const beforeText = cursorValues[0];
          const beforeSequence = beforeText === undefined ? undefined :
            (/^[1-9][0-9]*$/u.test(beforeText) ? Number(beforeText) : NaN);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
              (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 2))) {
            fail(response, 400, "invalid_audit_query", "Use limit 1–100 and an optional before cursor of 2 or greater"); return;
          }
          try {
            json(response, 200, await phase4Execution.getAuditTrail({
              limit,
              ...(beforeSequence === undefined ? {} : { beforeSequence })
            }));
          } catch {
            fail(response, 500, "audit_unavailable", "The Phase 4 execution evidence could not be read safely"); 
          }
          return;
        }
        if (pathname === "/api/analytics") {
          const history = await loadHistory(dataDir, maximumHistoryRecords);
          json(response, 200, buildDashboardAnalytics(history, registry.list())); return;
        }
        if (pathname === "/api/reports/consolidated") {
          const history = await loadHistory(dataDir, maximumHistoryRecords);
          const report = buildConsolidatedReport(history, registry.list());
          send(response, 200, report, "text/markdown; charset=utf-8", {
            "Content-Disposition": "attachment; filename=\"jb-expert-qa-consolidated-report.md\""
          });
          return;
        }
        if (pathname === "/api/history") {
          const history = await loadHistory(dataDir, maximumHistoryRecords);
          json(response, 200, { history: history.map(compactRecord), count: history.length }); return;
        }

        const screenshot = /^\/api\/history\/([0-9a-f-]{36})\/screenshots\/([a-z0-9_-]+\.png)$/i.exec(pathname);
        if (screenshot) {
          const history = await loadHistory(dataDir, maximumHistoryRecords);
          const record = history.find((item) => item.id === screenshot[1]);
          const filename = screenshot[2];
          if (!record || record.engineId !== "visual" || !record.screenshots?.includes(filename)) {
            fail(response, 404, "not_found", "Screenshot not found"); return;
          }
          const filePath = join(dataDir, "screenshots", record.id, filename);
          const info = await lstat(filePath);
          if (info.isSymbolicLink() || !info.isFile()) { fail(response, 404, "not_found", "Screenshot not found"); return; }
          send(response, 200, await readFile(filePath), "image/png"); return;
        }

        const certificateMatch = /^\/api\/certificates\/([0-9a-f-]{36})$/i.exec(pathname);
        if (certificateMatch) {
          const history = await loadHistory(dataDir, maximumHistoryRecords);
          const record = history.find((item) => item.id === certificateMatch[1]);
          if (!record) { fail(response, 404, "not_found", "Audit record not found"); return; }
          send(response, 200, certificate(record), "text/markdown; charset=utf-8", {
            "Content-Disposition": "attachment; filename=\"jb-expert-qa-" + record.engineId + "-" + record.id + ".md\""
          });
          return;
        }

        const detail = /^\/api\/history\/([0-9a-f-]{36})$/i.exec(pathname);
        if (detail) {
          const history = await loadHistory(dataDir, maximumHistoryRecords);
          const record = history.find((item) => item.id === detail[1]);
          if (!record) { fail(response, 404, "not_found", "Audit record not found"); return; }
          json(response, 200, {
            record,
            screenshotUrls: (record.screenshots ?? []).map((name) => "/api/history/" + record.id + "/screenshots/" + name)
          }); return;
        }
        fail(response, 404, "not_found", "Route not found"); return;
      }

      if (request.method === "POST" && pathname === "/api/phase4/execute") {
        if (!sameOrigin(request)) { fail(response, 403, "origin_blocked", "Dashboard actions must originate from this local dashboard"); return; }
        if (!phase4Execution) { fail(response, 503, "phase4_execution_disabled", "Phase 4 execution is disabled until the host supplies an explicit policy and external approval provider"); return; }
        if (!rateAllowed(phase4ExecutionRateWindow, 5)) { fail(response, 429, "phase4_rate_limited", "The Phase 4 execution request limit was reached"); return; }
        if (busy) { fail(response, 409, "audit_in_progress", "Another QA operation is already running"); return; }
        const body = await readBody(request, maximumBodyBytes);
        if (Object.keys(body).some((key) => !["engineId", "input"].includes(key)) ||
            !Object.hasOwn(body, "engineId") || !Object.hasOwn(body, "input") ||
            typeof body.engineId !== "string" || body.engineId.length > 128 || !isRecord(body.input)) {
          fail(response, 400, "invalid_execution_request", "Request must contain only an engineId and a JSON object input"); return;
        }
        const engine = phase4Execution.listAllowedEngines().find((item) => item.id === body.engineId);
        if (!engine) { fail(response, 403, "engine_not_allowlisted", "The requested engine is not enabled by the host policy"); return; }
        busy = true;
        try {
          const result = await phase4Execution.executeEngine(body.engineId, body.input);
          const ledgerVerification = await phase4Execution.verifyLedger();
          const actions = Array.isArray(result.actions) ? result.actions.map((action) => ({
            id: cleanText(action.id, 100),
            type: cleanText(action.type, 160),
            status: cleanText(action.status, 24),
            reason: cleanText(action.reason, 360),
            durationMs: Number.isFinite(action.durationMs) ? Math.max(0, action.durationMs) : null,
            ...(Object.hasOwn(action, "output") ? { output: action.output } : {})
          })) : [];
          json(response, 200, {
            executionId: cleanText(result.executionId, 100),
            planId: cleanText(result.planId, 100),
            status: cleanText(result.status, 24),
            durationMs: Number.isFinite(result.durationMs) ? Math.max(0, result.durationMs) : null,
            actions,
            ledgerIntegrity: ledgerVerification?.valid === true
          });
        } catch {
          fail(response, 422, "phase4_execution_failed", "Policy-gated engine execution failed or was rejected; inspect the host-side approval and audit records");
        } finally {
          busy = false;
        }
        return;
      }

      if (request.method === "POST" && pathname === "/api/runs") {
        if (!sameOrigin(request)) { fail(response, 403, "origin_blocked", "Dashboard actions must originate from this local dashboard"); return; }
        if (!rateAllowed(rateWindow)) { fail(response, 429, "rate_limited", "The local dashboard run limit was reached"); return; }
        if (busy) { fail(response, 409, "audit_in_progress", "Another QA audit is already running"); return; }
        const body = await readBody(request, maximumBodyBytes);
        const { engineId, target } = validateRun(body, registry);
        const engine = registry.get(engineId);
        const runId = randomUUID();
        const startedAt = Date.now();
        busy = true;
        try {
          const history = await loadHistory(dataDir, maximumHistoryRecords);
          const options = engineId === "visual"
            ? { screenshotDir: join(dataDir, "screenshots", runId), themes: ["light", "dark"] }
            : {};
          const report = await registry.run(engineId, target, options);
          const normalized = summarize(engineId, report);
          const record = {
            id: runId,
            createdAt: new Date().toISOString(),
            engineId,
            engineName: cleanText(engine.name || engineId, 100),
            targetLabel: targetLabel(target),
            targetHash: targetHash(engineId, target),
            outcome: normalized.outcome,
            score: normalized.score,
            findingsCount: normalized.findingsCount,
            findingsOmitted: normalized.findingsOmitted,
            findings: normalized.findings,
            durationMs: Math.max(0, Date.now() - startedAt),
            summary: normalized.summary,
            screenshots: normalized.screenshots,
            comparison: null
          };
          record.comparison = makeComparison(history, record);
          const saved = await saveHistory(dataDir, [record, ...history], maximumHistoryRecords);
          json(response, 201, { record, historyCount: saved.length });
        } catch (error) {
          fail(response, 422, "audit_failed", cleanText(error?.message || "The QA audit failed", 420));
        } finally {
          busy = false;
        }
        return;
      }
      if (request.method === "POST") { fail(response, 404, "not_found", "Route not found"); return; }
      fail(response, 405, "method_not_allowed", "Method not allowed");
    } catch (error) {
      if (response.headersSent || response.writableEnded) return response.destroy();
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : error instanceof TypeError ? 400 : 500;
      fail(response, status, status >= 500 ? "dashboard_error" : "invalid_request",
        status >= 500 ? "The dashboard could not complete this request" : cleanText(error.message, 300));
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 130_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

export async function startDashboard({ port = DEFAULT_DASHBOARD_PORT, storageDirectory, registry, phase4Registry, phase4Execution } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("port must be an integer between 0 and 65535");
  const server = createDashboardServer({ storageDirectory, registry, phase4Registry, phase4Execution });
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => { server.off("listening", onListening); rejectListen(error); };
    const onListening = () => { server.off("error", onError); resolveListen(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, DEFAULT_DASHBOARD_HOST);
  });
  const address = server.address();
  const url = "http://" + DEFAULT_DASHBOARD_HOST + ":" + address.port;
  return Object.freeze({
    server, url, host: DEFAULT_DASHBOARD_HOST, port: address.port,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  });
}
