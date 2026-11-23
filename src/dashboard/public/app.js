const state = {
  engines: [],
  selected: new Set(["live-site"]),
  targetMode: "website",
  history: [],
  analytics: null,
  running: false,
  activity: [],
  toastTimer: null
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

async function initialize() {
  try {
    await refreshEngines();
    await refreshHistory();
    await refreshAnalytics();
    setTargetMode("website");
  } catch (error) {
    setMessage(error.message, true);
    engineGrid.textContent = "The dashboard could not connect to its local service.";
  }
}
initialize();
