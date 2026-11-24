const EVENT_FIELDS = [
  "eventId", "sequence", "timestamp", "eventType", "severity", "engineId",
  "jobId", "executionId", "workerId", "supervisorId", "stage", "code"
];
const RESOURCE_FIELDS = [
  "memoryCurrentBytes", "memoryPeakBytes", "memoryLimitBytes", "cpuUsageMicros",
  "cpuLimitPercent", "cpuPeriods", "cpuThrottledPeriods", "cpuThrottledMicros",
  "processCount", "processLimit", "totalProcesses", "terminatedProcesses",
  "memoryMaxEvents", "memoryOomEvents", "memoryOomKillEvents"
];

function projectEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const result = {};
  for (const field of EVENT_FIELDS) {
    const value = event[field];
    if (typeof value === "string" || (Number.isSafeInteger(value) && value >= 0)) {
      result[field] = value;
    }
  }
  const metrics = {};
  for (const field of RESOURCE_FIELDS) {
    const value = event[field];
    if (Number.isSafeInteger(value) && value >= 0) metrics[field] = value;
  }
  if (Object.keys(metrics).length) result.resourceMetrics = metrics;
  return result;
}

function buildEventExport(events) {
  if (!Array.isArray(events)) throw new TypeError("Events must be an array.");
  return events.map(projectEvent).filter(Boolean);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}

function toCsv(events) {
  const rows = buildEventExport(events);
  const columns = [...EVENT_FIELDS, "resourceMetrics"];
  return [columns.join(","), ...rows.map(row => columns.map(field => csvCell(row[field])).join(","))].join("\r\n");
}

function toJson(events) {
  return JSON.stringify(buildEventExport(events), null, 2);
}

const api = Object.freeze({ buildEventExport, toCsv, toJson });
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.JBPhase5EventExport = api;
