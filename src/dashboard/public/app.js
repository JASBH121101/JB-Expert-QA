const state = {
  engines: [],
  selected: new Set(["live-site"]),
  targetMode: "website",
  history: [],
  analytics: null,
  running: false,
  activity: [],
  toastTimer: null,
  phase4Audit: null,
  phase5EventStatus: null,
  phase5Events: [],
  phase5EventPagination: null,
  phase5EventLoading: false,
  phase5EventError: null,
  phase5Host: null,
  phase5HostLoading: false,
  phase5Approvals: null,
  phase5ApprovalLoading: false
};

const $ = (id) => document.getElementById(id);
const engineGrid = $("engine-grid");
const runButton = $("run-button");
const runMessage = $("run-message");
const targetInput = $("target-input");

function setMessage(message, isError = false) {
  runMessage.textContent = message || "";
  runMessage.classList.toggle("error", isError);
}
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}
function outcomeText(value) {
  return value === "passed" ? "PASSED" :
    value === "passed_with_observations" ? "OBSERVATIONS" : "NOT PASSED";
}
function outcomeClass(value) {
  return value === "passed" ? "pass" :
    value === "passed_with_observations" ? "warn" : "fail";
}
function formatScore(value) {
  return Number.isFinite(value) ? String(Math.round(value)) + "/100" : "—";
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" :
    date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function currentTarget() {
  const value = targetInput.value.trim();
  if (!value) throw new Error(state.targetMode === "project"
    ? "Enter a local project directory path."
    : "Enter a website URL.");
  if (state.targetMode === "project") return { path: value };
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid absolute website URL."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS website URLs are supported.");
  }
  if (url.username || url.password) throw new Error("URLs containing embedded credentials are not accepted.");
  return { url: url.href };
}
function engineCanRun(engine) {
  return state.targetMode === "project"
    ? engine.target === "path" || engine.target === "path-or-url"
    : engine.target === "url" || engine.target === "path-or-url";
}
function updateSelectionUi() {
  const valid = [...state.selected].filter((id) => {
    const engine = state.engines.find((item) => item.id === id);
    return engine && engineCanRun(engine);
  });
  state.selected = new Set(valid);
  document.querySelectorAll("[data-engine-id]").forEach((label) => {
    const engine = state.engines.find((item) => item.id === label.dataset.engineId);
    const checkbox = label.querySelector("input");
    const disabled = !engine || !engineCanRun(engine) || state.running;
    checkbox.disabled = disabled;
    checkbox.checked = state.selected.has(label.dataset.engineId);
    label.classList.toggle("selected", checkbox.checked);
    label.classList.toggle("disabled", disabled);
    label.querySelector(".engine-checkbox").textContent = checkbox.checked ? "✓" : "";
  });
  $("selection-count").textContent = state.selected.size + " SELECTED";
  runButton.disabled = state.running || state.selected.size === 0;
}
function renderPhase4Execution() {
  const status = state.phase4Execution || { enabled: false, allowedEngineIds: [] };
  const enabled = status.enabled === true && Array.isArray(status.allowedEngineIds) && status.allowedEngineIds.length > 0;
  const select = $("phase4-execution-engine");
  const input = $("phase4-execution-input");
  const button = $("phase4-execute-button");
  select.replaceChildren();
  if (enabled) {
    state.phase4Engines.filter((engine) => status.allowedEngineIds.includes(engine.id)).forEach((engine) => {
      const option = document.createElement("option");
      option.value = engine.id;
      option.textContent = engine.name + " · " + engine.id;
      select.append(option);
    });
  }
  if (!select.options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Execution disabled";
    select.append(option);
  }
  select.disabled = !enabled;
  input.disabled = !enabled;
  button.disabled = !enabled;
  const tag = $("phase4-execution-state");
  tag.textContent = enabled ? "POLICY ENABLED · APPROVAL REQUIRED" : "DISABLED";
  tag.className = "assessment-tag " + (enabled ? "warn" : "");
  $("phase4-execution-policy").textContent = enabled
    ? "Policy: " + status.policyId + " · Permission: " + status.permission + " · High-risk execution requires external approval."
    : (status.reason || "Execution is disabled. Configure an exact host policy and external approval provider.");
  if (!enabled) $("phase4-execution-message").textContent = "No execution request can be submitted from this Dashboard instance.";
}
function renderPhase4Audit() {
  const audit = state.phase4Audit || { enabled: false, records: [] };
  const tag = $("phase4-audit-state");
  const view = $("phase4-audit-result");
  const refresh = $("phase4-audit-refresh");
  const enabled = audit.enabled === true;
  const integrityValid = audit.integrity?.valid === true;
  tag.textContent = !enabled ? "UNAVAILABLE" : (integrityValid ? "CHAIN VERIFIED" : "INTEGRITY WARNING");
  tag.className = "assessment-tag " + (enabled && integrityValid ? "pass" : (enabled ? "fail" : ""));
  view.textContent = JSON.stringify(audit, null, 2);
  refresh.disabled = false;
}
async function refreshPhase4Audit() {
  const response = await fetch("/api/phase4/audit?limit=50");
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Could not load Phase 4 execution evidence.");
  state.phase4Audit = data;
  renderPhase4Audit();
}
function renderPhase5Events() {
  const stateTag = $("phase5-events-state");
  const feed = $("phase5-event-feed");
  const count = $("phase5-event-count");
  const refresh = $("phase5-events-refresh");
  const older = $("phase5-events-load-older");
  const status = state.phase5EventStatus;
  const journal = status?.journal ?? null;
  const enabled = status?.enabled === true;

  stateTag.textContent = !enabled ? "UNAVAILABLE" :
    journal?.closed === true ? "JOURNAL CLOSED" :
    journal?.persistent === true ? "DURABLE JOURNAL" : "MEMORY JOURNAL";
  stateTag.className = "assessment-tag " + (enabled && journal?.closed !== true ? "pass" : "");
  count.textContent = enabled
    ? state.phase5Events.length + " EVENTS · " + String(journal?.retainedEvents ?? 0) + " RETAINED"
    : "0 EVENTS";

  feed.replaceChildren();
  if (state.phase5EventError) {
    const error = document.createElement("p");
    error.className = "empty-insight";
    error.textContent = state.phase5EventError;
    feed.append(error);
  } else if (!enabled) {
    const empty = document.createElement("p");
    empty.className = "empty-insight";
    empty.textContent = status?.reason || "Connect a Phase 5 supervisor to inspect operational events.";
    feed.append(empty);
  } else if (!state.phase5Events.length) {
    const empty = document.createElement("p");
    empty.className = "empty-insight";
    empty.textContent = "No operational events match the selected filters.";
    feed.append(empty);
  } else {
    state.phase5Events.slice().reverse().forEach((event) => {
      const card = document.createElement("article");
      card.className = "phase5-event-card";

      const heading = document.createElement("div");
      heading.className = "phase5-event-head";
      const title = document.createElement("div");
      title.className = "phase5-event-title";
      const sequence = document.createElement("span");
      sequence.className = "phase5-event-sequence";
      sequence.textContent = "#" + event.sequence;
      const name = document.createElement("strong");
      name.textContent = event.eventType;
      const severity = document.createElement("span");
      severity.className = "assessment-tag " +
        (event.severity === "error" ? "fail" : event.severity === "warning" ? "warn" : "pass");
      severity.textContent = String(event.severity || "info").toUpperCase();
      title.append(sequence, name);
      heading.append(title, severity);

      const timestamp = document.createElement("time");
      timestamp.className = "phase5-event-time";
      timestamp.dateTime = event.timestamp;
      timestamp.textContent = formatDate(event.timestamp);

      const metadata = document.createElement("div");
      metadata.className = "phase5-event-meta";
      for (const [label, value] of [
        ["ENGINE", event.engineId],
        ["JOB", event.jobId],
        ["EXECUTION", event.executionId],
        ["WORKER", event.workerId],
        ["SUPERVISOR", event.supervisorId],
        ["STAGE", event.stage],
        ["CODE", event.code]
      ]) {
        if (value === undefined) continue;
        const item = document.createElement("span");
        item.textContent = label + " · " + String(value);
        metadata.append(item);
      }

      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "View sanitized event fields";
      const record = document.createElement("pre");
      record.textContent = JSON.stringify(event, null, 2);
      details.append(summary, record);
      card.append(heading, timestamp, metadata, details);
      feed.append(card);
    });
  }

  refresh.disabled = state.phase5EventLoading;
  older.disabled = state.phase5EventLoading || !enabled || state.phase5EventPagination?.hasMore !== true;
  older.textContent = state.phase5EventLoading ? "Loading…" : "Load older events";
}

async function refreshPhase5Events({ beforeSequence, appendOlder = false } = {}) {
  if (state.phase5EventLoading) return;
  state.phase5EventLoading = true;
  state.phase5EventError = null;
  renderPhase5Events();
  try {
    if (!appendOlder) {
      const statusResponse = await fetch("/api/phase5/events/status");
      const statusData = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(statusData.message || "Could not load event journal status.");
      state.phase5EventStatus = statusData;
      state.phase5Events = [];
      state.phase5EventPagination = null;
      if (statusData.enabled !== true) return;
    }

    const params = new URLSearchParams({ limit: "50" });
    if (beforeSequence !== undefined) params.set("before", String(beforeSequence));
    const eventType = $("phase5-event-type").value;
    const engineId = $("phase5-event-engine").value.trim();
    const jobId = $("phase5-event-job").value.trim();
    const executionId = $("phase5-event-execution").value.trim();
    if (eventType) params.set("eventType", eventType);
    if (engineId) params.set("engineId", engineId);
    if (jobId) params.set("jobId", jobId);
    if (executionId) params.set("executionId", executionId);

    const response = await fetch("/api/phase5/events?" + params.toString(), {
      headers: { "Accept": "application/json" }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Could not load operational events.");
    state.phase5EventStatus = { enabled: data.enabled === true, journal: data.journal };
    state.phase5Events = appendOlder
      ? [...data.events, ...state.phase5Events]
      : data.events;
    state.phase5EventPagination = data.pagination;
  } catch (error) {
    state.phase5EventError = error.message || "Could not load operational events.";
  } finally {
    state.phase5EventLoading = false;
    renderPhase5Events();
  }
}

async function loadOlderPhase5Events() {
  const beforeSequence = state.phase5EventPagination?.nextBeforeSequence;
  if (!Number.isSafeInteger(beforeSequence)) return;
  await refreshPhase5Events({ beforeSequence, appendOlder: true });
}

async function refreshPhase4Execution() {
  const response = await fetch("/api/phase4/execution");
  if (!response.ok) throw new Error("Could not load Phase 4 execution policy status.");
  state.phase4Execution = await response.json();
  renderPhase4Execution();
}
async function runPhase4Engine() {
  if (state.running) return;
  const engineId = $("phase4-execution-engine").value;
  if (!engineId) return;
  let input;
  try {
    input = JSON.parse($("phase4-execution-input").value);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Input must be a JSON object.");
    }
  } catch (error) {
    $("phase4-execution-message").textContent = error.message || "Enter valid JSON.";
    $("phase4-execution-message").classList.add("error");
    return;
  }
  const button = $("phase4-execute-button");
  const message = $("phase4-execution-message");
  const resultView = $("phase4-execution-result");
  button.disabled = true;
  message.classList.remove("error");
  message.textContent = "Execution request submitted. Waiting for the host approval provider and policy-bound result…";
  resultView.hidden = true;
  state.running = true;
  try {
    const response = await fetch("/api/phase4/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engineId, input })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Policy-gated execution request failed.");
    resultView.textContent = JSON.stringify(data, null, 2);
    resultView.hidden = false;
    message.textContent = "Execution result: " + String(data.status || "unknown").toUpperCase() +
      " · Audit ledger integrity: " + (data.ledgerIntegrity === true ? "verified" : "not verified");
    addActivity(engineId, data.status === "succeeded" ? "PASSED" : "BLOCKED",
      "Policy-gated Phase 4 engine execution · " + String(data.status || "unknown"));
  } catch (error) {
    message.textContent = error.message || "Execution request failed.";
    message.classList.add("error");
  } finally {
    state.running = false;
    renderPhase4Execution();
  }
}

function renderPhase4Engines() {
  const grid = $("phase4-engine-grid");
  if (!grid) return;
  grid.replaceChildren();
  $("phase4-engine-count").textContent = state.phase4Engines.length + " ENGINES";
  if (!state.phase4Engines.length) {
    const empty = document.createElement("p");
    empty.className = "empty-insight";
    empty.textContent = "No Phase 4 engines are connected to this dashboard instance.";
    grid.append(empty);
    return;
  }
  state.phase4Engines.forEach((engine) => {
    const card = document.createElement("article");
    card.className = "phase4-engine-card";
    const heading = document.createElement("strong");
    heading.textContent = engine.name;
    const meta = document.createElement("small");
    meta.textContent = engine.id + " · v" + engine.version + " · " + engine.category + " · " + engine.executionMode;
    const description = document.createElement("p");
    description.textContent = engine.description || "Registered trusted adapter.";
    const capabilityList = document.createElement("div");
    capabilityList.className = "phase4-capabilities";
    engine.capabilities.forEach((capability) => {
      const tag = document.createElement("span");
      tag.className = "engine-tag";
      tag.textContent = capability.replace(/-/g, " ");
      capabilityList.append(tag);
    });
    const stateTag = document.createElement("span");
    stateTag.className = "phase4-readonly-tag";
    stateTag.textContent = "DISCOVERY ONLY · EXECUTION DISABLED";
    card.append(heading, meta, description, capabilityList, stateTag);
    grid.append(card);
  });
}
async function refreshPhase4Engines() {
  const response = await fetch("/api/phase4/engines");
  if (!response.ok) throw new Error("Could not load the Phase 4 engine catalog.");
  const data = await response.json();
  state.phase4Engines = Array.isArray(data.engines) ? data.engines : [];
  renderPhase4Engines();
}

function renderEngines() {
  engineGrid.replaceChildren();
  state.engines.forEach((engine) => {
    const label = document.createElement("label");
    label.className = "engine-option";
    label.dataset.engineId = engine.id;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(engine.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(engine.id);
      else state.selected.delete(engine.id);
      updateSelectionUi();
    });
    const indicator = document.createElement("span");
    indicator.className = "engine-checkbox";
    indicator.textContent = checkbox.checked ? "✓" : "";
    const copy = document.createElement("span");
    copy.className = "engine-option-copy";
    const title = document.createElement("strong");
    title.textContent = engine.name;
    const description = document.createElement("small");
    description.textContent = engine.description;
    const tag = document.createElement("span");
    tag.className = "engine-tag";
    tag.textContent = engine.mode.replace(/-/g, " ");
    copy.append(title, description, tag);
    label.append(checkbox, indicator, copy);
    engineGrid.append(label);
  });
  $("metric-engines").textContent = String(state.engines.length);
  updateSelectionUi();
}
function setTargetMode(mode) {
  if (mode !== "website" && mode !== "project") return;
  state.targetMode = mode;
  document.querySelectorAll("[data-target-mode]").forEach((button) => {
    const active = button.dataset.targetMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const project = mode === "project";
  $("target-label").textContent = project ? "Project directory path" : "Website address";
  $("target-note").textContent = project ? "Folder visible to the dashboard process" : "Public URL or an authorized website";
  $("target-helper").textContent = project
    ? "Use an absolute path or a path relative to the terminal directory where this dashboard was started. Static audit is read-only."
    : "Private and loopback network targets remain blocked by the browser safety policy.";
  targetInput.type = project ? "text" : "url";
  targetInput.inputMode = project ? "text" : "url";
  targetInput.placeholder = project ? "./my-project" : "https://example.com";
  targetInput.autocomplete = project ? "off" : "url";
  state.selected = new Set([project ? "static" : "live-site"]);
  updateSelectionUi();
}
function addActivity(engineName, status, details) {
  state.activity.unshift({ engineName, status, details });
  state.activity = state.activity.slice(0, 12);
  renderActivity();
}
function renderActivity() {
  const feed = $("activity-feed");
  feed.replaceChildren();
  if (!state.activity.length) {
    const empty = document.createElement("div");
    empty.className = "empty-feed";
    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.textContent = "⌁";
    const title = document.createElement("strong");
    title.textContent = "No activity yet";
    const copy = document.createElement("p");
    copy.textContent = "Run an audit to see progress and results here.";
    empty.append(icon, title, copy);
    feed.append(empty);
    return;
  }
  state.activity.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "feed-item";
    const number = document.createElement("span");
    number.className = "feed-index";
    number.textContent = String(state.activity.length - index).padStart(2, "0");
    const copy = document.createElement("span");
    copy.className = "feed-copy";
    const title = document.createElement("strong");
    title.textContent = item.engineName;
    const detail = document.createElement("small");
    detail.textContent = item.details;
    copy.append(title, detail);
    const status = document.createElement("span");
    status.className = "feed-status " + (item.status === "PASSED" ? "pass" :
      item.status === "RUNNING" ? "" : item.status === "FAILED" ? "fail" : "warn");
    status.textContent = item.status;
    row.append(number, copy, status);
    feed.append(row);
  });
}
function renderMetrics() {
  $("metric-runs").textContent = String(state.history.length);
  const latest = state.history[0];
  if (!latest) {
    $("metric-score").textContent = "—";
    $("metric-score-foot").textContent = "No completed audit";
    $("metric-result").textContent = "WAITING";
    $("metric-result").className = "metric-status";
    $("metric-result-foot").textContent = "No execution recorded";
    return;
  }
  $("metric-score").textContent = formatScore(latest.score);
  $("metric-score-foot").textContent = latest.engineName;
  const result = $("metric-result");
  result.textContent = outcomeText(latest.outcome);
  result.className = "metric-status " + (latest.outcome === "passed" ? "pass" :
    latest.outcome === "passed_with_observations" ? "warn" : "fail");
  $("metric-result-foot").textContent = latest.findingsCount + " finding(s) recorded";
}
function renderHistory() {
  const body = $("history-body");
  body.replaceChildren();
  $("history-count").textContent = state.history.length + " RECORDS";
  if (!state.history.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "empty-table";
    cell.textContent = "No local audit records yet.";
    row.append(cell);
    body.append(row);
    renderMetrics();
    return;
  }
  state.history.forEach((record) => {
    const row = document.createElement("tr");
    const engineCell = document.createElement("td");
    engineCell.className = "history-engine";
    const engineName = document.createElement("strong");
    engineName.textContent = record.engineName;
    const target = document.createElement("small");
    target.textContent = record.targetLabel;
    engineCell.append(engineName, target);
    const dateCell = document.createElement("td");
    dateCell.textContent = formatDate(record.createdAt);
    const outcomeCell = document.createElement("td");
    const outcome = document.createElement("span");
    outcome.className = "outcome " + outcomeClass(record.outcome);
    outcome.textContent = outcomeText(record.outcome);
    outcomeCell.append(outcome);
    const scoreCell = document.createElement("td");
    scoreCell.textContent = formatScore(record.score);
    const findingsCell = document.createElement("td");
    findingsCell.textContent = String(record.findingsCount);
    const changeCell = document.createElement("td");
    const delta = record.comparison?.scoreDelta;
    if (Number.isFinite(delta)) {
      changeCell.textContent = (delta > 0 ? "+" : "") + delta + " pts";
      changeCell.className = delta > 0 ? "change-positive" : delta < 0 ? "change-negative" : "";
    } else changeCell.textContent = "First run";
    const actionCell = document.createElement("td");
    actionCell.className = "row-actions";
    const details = document.createElement("button");
    details.type = "button";
    details.className = "small-button";
    details.textContent = "Details";
    details.addEventListener("click", () => openDetails(record.id));
    const report = document.createElement("button");
    report.type = "button";
    report.className = "small-button";
    report.textContent = "Report";
    report.addEventListener("click", () => downloadCertificate(record.id));
    actionCell.append(details, report);
    row.append(engineCell, dateCell, outcomeCell, scoreCell, findingsCell, changeCell, actionCell);
    body.append(row);
  });
  renderMetrics();
}

function appendInsightBar(container, labelText, count, maximum, severityName) {
  const row = document.createElement("div");
  row.className = "insight-bar-row";
  const label = document.createElement("span");
  label.className = "insight-bar-label";
  label.textContent = labelText;
  const track = document.createElement("span");
  track.className = "insight-bar-track";
  const fill = document.createElement("span");
  fill.className = "insight-bar-fill severity-" + severityName;
  fill.style.width = (maximum > 0 ? Math.max(count > 0 ? 2 : 0, count / maximum * 100) : 0) + "%";
  track.append(fill);
  const value = document.createElement("strong");
  value.textContent = String(count);
  row.append(label, track, value);
  container.append(row);
}
function renderAnalytics(data) {
  state.analytics = data;
  $("analytics-score").textContent = Number.isFinite(data.averageCurrentScore) ? data.averageCurrentScore + "/100" : "—";
  $("analytics-pass-rate").textContent = Number.isFinite(data.cleanPassRate) ? data.cleanPassRate + "%" : "—";
  $("analytics-findings").textContent = String(data.activeFindingCount ?? 0);
  $("analytics-engines").textContent = (data.usedEngineCount ?? 0) + "/" + (data.availableEngineCount ?? 0);
  $("analytics-coverage-label").textContent = (data.currentSnapshotCount ?? 0) + " CURRENT SNAPSHOTS";
  const assessmentLabels = {
    NOT_ASSESSED: "NOT ASSESSED",
    NOT_PASSED: "NOT PASSED",
    REVIEW_REQUIRED: "REVIEW REQUIRED",
    OBSERVATIONS: "OBSERVATIONS",
    PASSED_WITHIN_RECORDED_SCOPE: "PASSED · RECORDED SCOPE"
  };
  const assessment = $("analytics-assessment");
  assessment.textContent = assessmentLabels[data.assessment] || "NOT ASSESSED";
  assessment.className = "assessment-tag " + (data.assessment === "NOT_PASSED" ? "fail" :
    data.assessment === "REVIEW_REQUIRED" || data.assessment === "OBSERVATIONS" ? "warn" :
    data.assessment === "PASSED_WITHIN_RECORDED_SCOPE" ? "pass" : "");

  const severityContainer = $("severity-breakdown");
  severityContainer.replaceChildren();
  const severityOrder = ["critical", "high", "medium", "low", "info", "other"];
  const severityCounts = data.severityCounts || {};
  const maxSeverity = Math.max(0, ...severityOrder.map((key) => Number(severityCounts[key] || 0)));
  if (!maxSeverity) {
    const empty = document.createElement("p");
    empty.className = "empty-insight";
    empty.textContent = data.currentSnapshotCount ? "No findings in the latest saved snapshots." : "No audit snapshots yet.";
    severityContainer.append(empty);
  } else {
    severityOrder.forEach((key) => appendInsightBar(severityContainer, key.toUpperCase(),
      Number(severityCounts[key] || 0), maxSeverity, key));
  }

  const coverageContainer = $("engine-coverage");
  coverageContainer.replaceChildren();
  const engineRows = data.engineCoverage || [];
  const maxRuns = Math.max(1, ...engineRows.map((engine) => engine.auditCount));
  engineRows.forEach((engine) => {
    const row = document.createElement("div");
    row.className = "coverage-row";
    const header = document.createElement("div");
    header.className = "coverage-row-head";
    const name = document.createElement("strong");
    name.textContent = engine.engineName;
    const status = document.createElement("span");
    status.className = "coverage-status " + (engine.latestOutcome ? outcomeClass(engine.latestOutcome) : "");
    status.textContent = engine.latestOutcome ? outcomeText(engine.latestOutcome) : "NOT RUN";
    header.append(name, status);
    const track = document.createElement("span");
    track.className = "coverage-track";
    const fill = document.createElement("span");
    fill.className = "coverage-fill";
    fill.style.width = (engine.auditCount / maxRuns * 100) + "%";
    track.append(fill);
    const detail = document.createElement("small");
    detail.textContent = engine.auditCount + " run(s) · " + engine.currentTargetCount +
      " current target(s) · " + engine.activeFindings + " active finding(s)" +
      (Number.isFinite(engine.averageScore) ? " · avg " + engine.averageScore + "/100" : "");
    row.append(header, track, detail);
    coverageContainer.append(row);
  });
  if (!engineRows.length) {
    const empty = document.createElement("p");
    empty.className = "empty-insight";
    empty.textContent = "No registered engines were supplied.";
    coverageContainer.append(empty);
  }

  const findingsContainer = $("top-findings");
  findingsContainer.replaceChildren();
  const topFindings = data.topFindings || [];
  topFindings.forEach((finding) => {
    const card = document.createElement("article");
    card.className = "top-finding-row";
    const header = document.createElement("div");
    header.className = "top-finding-head";
    const severity = document.createElement("span");
    severity.className = "top-finding-severity severity-" + finding.severity;
    severity.textContent = finding.severity.toUpperCase();
    const occurrences = document.createElement("strong");
    occurrences.textContent = finding.occurrences + " occurrence(s)";
    header.append(severity, occurrences);
    const title = document.createElement("strong");
    title.className = "top-finding-title";
    title.textContent = finding.title;
    const detail = document.createElement("small");
    detail.textContent = finding.ruleId + " · " + finding.engines.join(", ");
    card.append(header, title, detail);
    findingsContainer.append(card);
  });
  if (!topFindings.length) {
    const empty = document.createElement("p");
    empty.className = "empty-insight";
    empty.textContent = "No recurring findings in the latest snapshots.";
    findingsContainer.append(empty);
  }

  const trendContainer = $("score-trend");
  trendContainer.replaceChildren();
  const trend = data.scoreTrend || [];
  trend.forEach((item) => {
    const row = document.createElement("div");
    row.className = "trend-row";
    const label = document.createElement("span");
    label.className = "trend-label";
    label.textContent = item.engineName + " · " + item.targetLabel + " · " + formatDate(item.createdAt);
    const track = document.createElement("span");
    track.className = "trend-track";
    const fill = document.createElement("span");
    fill.className = "trend-fill";
    fill.style.width = (Number.isFinite(item.score) ? Math.max(0, Math.min(100, item.score)) : 0) + "%";
    track.append(fill);
    const score = document.createElement("strong");
    score.textContent = Number.isFinite(item.score) ? item.score + "/100" : "—";
    row.append(label, track, score);
    trendContainer.append(row);
  });
  if (!trend.length) {
    const empty = document.createElement("p");
    empty.className = "empty-insight";
    empty.textContent = "Run audits to build a score trend.";
    trendContainer.append(empty);
  }

  const posture = {
    NOT_ASSESSED: "No audit data available.",
    NOT_PASSED: "At least one latest snapshot did not pass.",
    REVIEW_REQUIRED: "Critical or high-severity findings require review.",
    OBSERVATIONS: "Findings remain in the latest snapshots.",
    PASSED_WITHIN_RECORDED_SCOPE: "No findings in the latest saved snapshots."
  };
  $("analytics-scope").textContent = posture[data.assessment] +
    " Coverage shows engines used somewhere in retained history; it does not prove all engines audited the same target. " +
    "History is locally bounded, and cross-engine scores are not directly comparable.";
}
async function refreshAnalytics() {
  const response = await fetch("/api/analytics", { headers: { "Accept": "application/json" } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Could not load QA intelligence");
  renderAnalytics(data);
}
async function downloadConsolidatedReport() {
  try {
    const response = await fetch("/api/reports/consolidated");
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.message || "Could not generate consolidated report");
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "jb-expert-qa-consolidated-report.md";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    showToast("Consolidated QA report generated.");
  } catch (error) { showToast(error.message); }
}

function renderPhase5Host(data) {
  state.phase5Host = data;
  const enabled = data?.enabled === true;
  const currentState = data?.state || "unavailable";
  const stateTag = $("phase5-host-state");
  stateTag.textContent = !enabled ? "NOT CONNECTED" : currentState.replace(/-/g, " ").toUpperCase();
  stateTag.className = "assessment-tag " + (enabled && currentState === "running" ? "pass" :
    currentState === "failed" ? "fail" : enabled ? "warn" : "");

  $("phase5-host-lifecycle").textContent = enabled ? currentState.toUpperCase() : "Unavailable";
  $("phase5-host-liveness").textContent = enabled
    ? (data.liveness?.alive === true ? "ALIVE" : "NOT ALIVE")
    : "Unavailable";
  $("phase5-host-readiness").textContent = enabled
    ? (data.readiness?.ready === true ? "READY" : "NOT READY")
    : "Not connected";
  $("phase5-host-preflight").textContent = !enabled ? "Not connected" :
    data.preflight ? (data.preflight.passed === true ? "PASSED" : "FAILED") : "Not checked";

  const queue = data?.queue;
  $("phase5-host-queue").textContent = !enabled || !queue ? "No persistent queue status" :
    "Queued " + queue.queued + " · Running " + queue.running + " · Completed " + queue.completed +
    " · Failed " + queue.failed + " · Interrupted " + queue.interrupted;

  const message = !enabled
    ? "No application-owned bootstrap controller is connected. Host execution remains disabled in this dashboard."
    : data.lastFailureCode
      ? "Host reports a controlled failure (" + data.lastFailureCode + "). Review diagnostics before recreating the controller."
      : currentState === "running" && data.readiness?.ready === true
        ? "Host is running and all readiness checks currently pass."
        : currentState === "running"
          ? "Host is running, but one or more readiness checks have not passed."
          : currentState === "idle"
            ? "Host is idle. Start is explicit and will run the complete preflight before acquiring persistent locks."
            : "Host is " + currentState + ". No automatic restart or interrupted-job recovery is performed.";
  $("phase5-host-message").textContent = message;

  const diagnostics = {
    preflightChecks: data.preflight?.checks ?? [],
    readinessChecks: data.readiness?.checks ?? [],
    recentDiagnostics: data.recentDiagnostics ?? [],
    recentEvents: data.recentEvents ?? [],
    lastFailureCode: data.lastFailureCode ?? null
  };
  $("phase5-host-diagnostics").textContent = JSON.stringify(diagnostics, null, 2);

  $("phase5-host-start").disabled = !enabled || currentState !== "idle" || state.phase5HostLoading;
  $("phase5-host-stop").disabled = !enabled || currentState !== "running" || state.phase5HostLoading;
  $("phase5-host-refresh").disabled = state.phase5HostLoading;
}
async function refreshPhase5Host() {
  if (state.phase5HostLoading) return;
  state.phase5HostLoading = true;
  $("phase5-host-refresh").disabled = true;
  try {
    const response = await fetch("/api/phase5/host/status", {
      headers: { "Accept": "application/json" }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Could not read autonomous host status.");
    renderPhase5Host(data);
  } catch (error) {
    $("phase5-host-state").textContent = "UNAVAILABLE";
    $("phase5-host-state").className = "assessment-tag";
    $("phase5-host-message").textContent = error.message || "Could not read autonomous host status.";
    $("phase5-host-start").disabled = true;
    $("phase5-host-stop").disabled = true;
  } finally {
    state.phase5HostLoading = false;
    if (state.phase5Host) renderPhase5Host(state.phase5Host);
    $("phase5-host-refresh").disabled = false;
  }
}
async function operatePhase5Host(operation) {
  if (state.phase5HostLoading || !["start", "stop"].includes(operation)) return;
  state.phase5HostLoading = true;
  renderPhase5Host(state.phase5Host ?? { enabled: false, state: "unavailable" });
  try {
    const response = await fetch("/api/phase5/host/" + operation, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: "{}"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Host lifecycle operation failed.");
    renderPhase5Host(data);
    showToast(operation === "start" ? "Autonomous host started." : "Autonomous host stopped gracefully.");
  } catch (error) {
    showToast(error.message || "Host lifecycle operation failed.");
    try { await refreshPhase5Host(); } catch {}
  } finally {
    state.phase5HostLoading = false;
    if (state.phase5Host) renderPhase5Host(state.phase5Host);
  }
}

async function refreshPhase5Approvals() {
  if (state.phase5ApprovalLoading) return;
  state.phase5ApprovalLoading = true;
  const refresh = document.getElementById("phase5-approvals-refresh");
  if (refresh) refresh.disabled = true;
  try {
    const response = await fetch("/api/phase5/host/approvals", {
      headers: { "Accept": "application/json" }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Could not load pending approvals.");
    state.phase5Approvals = data;
    renderPhase5Approvals(data);
  } catch (error) {
    const list = document.getElementById("phase5-approval-list");
    if (list) list.textContent = error.message || "Could not load pending approvals.";
    const tag = document.getElementById("phase5-approval-state");
    if (tag) tag.textContent = "UNAVAILABLE";
  } finally {
    state.phase5ApprovalLoading = false;
    if (refresh) refresh.disabled = false;
  }
}

function renderPhase5Approvals(data) {
  const tag = document.getElementById("phase5-approval-state");
  const list = document.getElementById("phase5-approval-list");
  if (!tag || !list) return;
  const pending = Array.isArray(data?.pending) ? data.pending : [];
  const enabled = data?.enabled === true;
  tag.textContent = !enabled ? "NOT CONNECTED" : pending.length ? pending.length + " PENDING" : "NO PENDING";
  tag.className = "assessment-tag " + (enabled && pending.length ? "warn" : "");
  list.replaceChildren();

  if (!enabled) {
    const empty = document.createElement("p");
    empty.className = "empty-insight";
    empty.textContent = "No local approval gate is connected. Supply approvalGate to the application host bootstrap.";
    list.append(empty);
    return;
  }
  if (!pending.length) {
    const empty = document.createElement("p");
    empty.className = "empty-insight";
    empty.textContent = data.status?.closed ? "The approval gate is closed." : "No action is waiting for an operator decision.";
    list.append(empty);
    return;
  }

  for (const item of pending) {
    const card = document.createElement("article");
    card.className = "phase5-approval-card";
    card.setAttribute("role", "listitem");

    const heading = document.createElement("div");
    heading.className = "phase5-approval-card-heading";
    const action = document.createElement("strong");
    action.textContent = item.actionType;
    const risk = document.createElement("span");
    risk.className = "assessment-tag " + (item.risk === "high" ? "warn" : "");
    risk.textContent = String(item.risk || "unknown").toUpperCase() + " RISK";
    heading.append(action, risk);

    const metadata = document.createElement("div");
    metadata.className = "phase5-approval-meta";
    const fields = [
      ["EXECUTION", item.executionId],
      ["ACTION", item.actionId],
      ["PERMISSIONS", Array.isArray(item.permissions) ? item.permissions.join(", ") : ""],
      ["EXPIRES", item.expiresAt ? formatDate(item.expiresAt) : "Unknown"]
    ];
    for (const [label, value] of fields) {
      const row = document.createElement("span");
      row.textContent = label + " · " + String(value || "—");
      metadata.append(row);
    }
    const digest = document.createElement("code");
    digest.className = "phase5-approval-digest";
    digest.textContent = "Input SHA-256 · " + String(item.inputDigest || "").slice(0, 20) + "…";

    const actions = document.createElement("div");
    actions.className = "phase5-approval-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "primary-button";
    approve.textContent = "Approve";
    approve.disabled = state.phase5ApprovalLoading;
    approve.addEventListener("click", () => decidePhase5Approval(item.id, "approve", item.actionType));
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "secondary-button";
    deny.textContent = "Deny";
    deny.disabled = state.phase5ApprovalLoading;
    deny.addEventListener("click", () => decidePhase5Approval(item.id, "deny", item.actionType));
    actions.append(approve, deny);

    card.append(heading, metadata, digest, actions);
    list.append(card);
  }
}

async function decidePhase5Approval(id, decision, actionType) {
  if (state.phase5ApprovalLoading || !/^[0-9a-f-]{36}$/iu.test(String(id)) ||
      !["approve", "deny"].includes(decision)) return;
  const message = decision === "approve"
    ? "Approve this high-risk QA action? The engine will run only if the host policy also allows it.\n\n" + String(actionType || "")
    : "Deny this QA action? It will remain blocked.";
  if (!window.confirm(message)) return;
  state.phase5ApprovalLoading = true;
  try {
    const response = await fetch("/api/phase5/host/approvals/" + encodeURIComponent(id) + "/" + decision, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: "{}"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "The approval decision was rejected.");
    state.phase5Approvals = data;
    renderPhase5Approvals(data);
    showToast(decision === "approve" ? "Approval recorded. The host still enforces its policy." : "Request denied.");
  } catch (error) {
    showToast(error.message || "The approval decision failed.");
    await refreshPhase5Approvals();
  } finally {
    state.phase5ApprovalLoading = false;
    if (state.phase5Approvals) renderPhase5Approvals(state.phase5Approvals);
  }
}

async function refreshHistory() {
  const response = await fetch("/api/history", { headers: { "Accept": "application/json" } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Could not load audit history");
  state.history = data.history || [];
  renderHistory();
}
async function refreshEngines() {
  const response = await fetch("/api/engines", { headers: { "Accept": "application/json" } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Could not load engine registry");
  state.engines = data.engines || [];
  renderEngines();
}
async function runSelected() {
  if (state.running) return;
  let target;
  try { target = currentTarget(); }
  catch (error) { setMessage(error.message, true); return; }
  const selected = state.engines.filter((engine) => state.selected.has(engine.id));
  if (!selected.length) { setMessage("Select at least one compatible engine.", true); return; }
  state.running = true;
  updateSelectionUi();
  runButton.disabled = true;
  $("run-button-label").textContent = "Running audits…";
  setMessage("Executing " + selected.length + " audit(s) sequentially.");
  let passed = 0;
  let failed = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const engine = selected[index];
    addActivity(engine.name, "RUNNING", "Audit " + (index + 1) + " of " + selected.length);
    setMessage("Running " + engine.name + " (" + (index + 1) + "/" + selected.length + ").");
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ engineId: engine.id, target })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Audit failed");
      const record = data.record;
      state.history.unshift({
        id: record.id, createdAt: record.createdAt, engineId: record.engineId,
        engineName: record.engineName, targetLabel: record.targetLabel, outcome: record.outcome,
        score: record.score, findingsCount: record.findingsCount, durationMs: record.durationMs,
        comparison: record.comparison, screenshots: record.screenshots
      });
      state.history = state.history.slice(0, 50);
      if (record.outcome === "not_passed") failed += 1;
      else passed += 1;
      addActivity(engine.name, record.outcome === "passed" ? "PASSED" :
        record.outcome === "passed_with_observations" ? "OBSERVATIONS" : "FAILED",
        formatScore(record.score) + " · " + record.findingsCount + " finding(s)");
    } catch (error) {
      failed += 1;
      addActivity(engine.name, "FAILED", error.message);
      showToast(engine.name + ": " + error.message);
    }
    renderHistory();
  }
  state.running = false;
  updateSelectionUi();
  $("run-button-label").textContent = "Run selected audits";
  const message = passed + " passed; " + failed + " not passed or failed.";
  setMessage(message, failed > 0);
  try { await refreshHistory(); await refreshAnalytics(); } catch (error) { showToast(error.message); }
  showToast("Audit batch completed: " + message);
}
async function openDetails(id) {
  try {
    const response = await fetch("/api/history/" + encodeURIComponent(id));
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Could not load audit details");
    renderDetails(data.record, data.screenshotUrls || []);
  } catch (error) { showToast(error.message); }
}
function addChip(container, text) {
  const chip = document.createElement("span");
  chip.className = "detail-chip";
  chip.textContent = text;
  container.append(chip);
}
function appendComparisonList(container, titleText, items) {
  if (!Array.isArray(items) || !items.length) return;
  const heading = document.createElement("h3");
  heading.textContent = titleText;
  const list = document.createElement("div");
  list.className = "detail-findings";
  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "finding-card";
    const title = document.createElement("strong");
    title.textContent = item.title || "QA finding";
    const detail = document.createElement("p");
    detail.textContent = [item.severity, item.location, item.viewport, item.theme].filter(Boolean).join(" · ");
    card.append(title, detail);
    list.append(card);
  });
  container.append(heading, list);
}
function renderDetails(record, screenshotUrls) {
  $("detail-title").textContent = record.engineName + " — " + outcomeText(record.outcome);
  const content = $("detail-content");
  content.replaceChildren();
  const summary = document.createElement("div");
  summary.className = "detail-summary";
  addChip(summary, "Score: " + formatScore(record.score));
  addChip(summary, "Findings: " + record.findingsCount);
  addChip(summary, "Duration: " + record.durationMs + " ms");
  addChip(summary, "Target: " + record.targetLabel);
  if (record.comparison) {
    addChip(summary, "New: " + record.comparison.newFindingsCount);
    addChip(summary, "Resolved: " + record.comparison.resolvedFindingsCount);
    addChip(summary, "Score change: " + (record.comparison.scoreDelta === null ? "n/a" :
      (record.comparison.scoreDelta > 0 ? "+" : "") + record.comparison.scoreDelta));
  }
  content.append(summary);
  if (record.comparison) {
    appendComparisonList(content, "New since previous run", record.comparison.newFindings || []);
    appendComparisonList(content, "Resolved since previous run", record.comparison.resolvedFindings || []);
  }
  if (record.findings?.length) {
    const heading = document.createElement("h3");
    heading.textContent = "Finding details";
    content.append(heading);
    const list = document.createElement("div");
    list.className = "detail-findings";
    record.findings.slice(0, 30).forEach((finding) => {
      const card = document.createElement("article");
      card.className = "finding-card";
      const severity = document.createElement("span");
      severity.className = "severity";
      severity.textContent = finding.severity;
      const title = document.createElement("strong");
      title.textContent = finding.title;
      const description = document.createElement("p");
      description.textContent = finding.description || finding.recommendation || "No additional description.";
      card.append(severity, title, description);
      list.append(card);
    });
    content.append(list);
  } else {
    const empty = document.createElement("p");
    empty.className = "section-subtitle";
    empty.textContent = "No findings were recorded for this run.";
    content.append(empty);
  }
  if (screenshotUrls.length) {
    const heading = document.createElement("h3");
    heading.textContent = "Visual evidence";
    const grid = document.createElement("div");
    grid.className = "screenshot-grid";
    screenshotUrls.forEach((url) => {
      const figure = document.createElement("figure");
      figure.className = "screenshot-card";
      const image = document.createElement("img");
      image.src = url;
      image.alt = "Visual QA screenshot";
      const caption = document.createElement("figcaption");
      caption.textContent = url.split("/").pop();
      figure.append(image, caption);
      grid.append(figure);
    });
    content.append(heading, grid);
  }
  const toolbar = document.createElement("div");
  toolbar.className = "detail-toolbar";
  const report = document.createElement("button");
  report.type = "button";
  report.className = "secondary-button";
  report.textContent = "Download certification report";
  report.addEventListener("click", () => downloadCertificate(record.id));
  toolbar.append(report);
  content.append(toolbar);
  const panel = $("detail-panel");
  panel.hidden = false;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function downloadCertificate(id) {
  try {
    const response = await fetch("/api/certificates/" + encodeURIComponent(id));
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.message || "Could not generate report");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match ? match[1] : "jb-expert-qa-certificate.md";
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    showToast("Certification report generated.");
  } catch (error) { showToast(error.message); }
}

document.querySelectorAll("[data-target-mode]").forEach((button) => {
  button.addEventListener("click", () => setTargetMode(button.dataset.targetMode));
});
$("refresh-history").addEventListener("click", async () => {
  try { await refreshHistory(); await refreshAnalytics(); showToast("Audit history and intelligence refreshed."); }
  catch (error) { showToast(error.message); }
});
$("close-detail").addEventListener("click", () => { $("detail-panel").hidden = true; });
$("download-consolidated").addEventListener("click", downloadConsolidatedReport);
runButton.addEventListener("click", runSelected);
$("phase4-execute-button").addEventListener("click", runPhase4Engine);
$("phase4-audit-refresh").addEventListener("click", async () => {
  try { await refreshPhase4Audit(); }
  catch (error) { $("phase4-audit-result").textContent = error.message; }
});
$("phase5-host-refresh").addEventListener("click", refreshPhase5Host);
$("phase5-approvals-refresh").addEventListener("click", () => refreshPhase5Approvals());
$("phase5-host-start").addEventListener("click", () => operatePhase5Host("start"));
$("phase5-host-stop").addEventListener("click", () => operatePhase5Host("stop"));
$("phase5-events-refresh").addEventListener("click", () => refreshPhase5Events());
$("phase5-events-load-older").addEventListener("click", loadOlderPhase5Events);
for (const id of ["phase5-event-type", "phase5-event-engine", "phase5-event-job", "phase5-event-execution"]) {
  $(id).addEventListener("change", () => refreshPhase5Events());
}

async function initialize() {
  try {
    await refreshEngines();
    await refreshPhase4Engines();
    await refreshPhase4Execution();
    await refreshPhase4Audit();
    await refreshPhase5Events();
    await refreshPhase5Host();
    await refreshPhase5Approvals();
    await refreshHistory();
    await refreshAnalytics();
    setTargetMode("website");
  } catch (error) {
    setMessage(error.message, true);
    engineGrid.textContent = "The dashboard could not connect to its local service.";
  }
}
initialize();
window.setInterval(() => {
  if (!state.phase5ApprovalLoading && document.visibilityState === "visible") void refreshPhase5Approvals();
}, 2500);
