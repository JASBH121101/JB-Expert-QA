const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEventExport, toCsv, toJson } = require("../src/dashboard/event-export");

test("Phase 5 event export projects allowlisted fields and numeric resource counters", () => {
  const events = [{
    eventId: "event-a",
    sequence: 4,
    timestamp: "2026-11-24T20:00:00.000Z",
    eventType: "CONTAINMENT_RESOURCE_SNAPSHOT",
    severity: "info",
    engineId: "engine-a",
    memoryPeakBytes: 1024,
    cpuUsageMicros: 33,
    pid: 9876,
    rawPayload: "must not export",
    resourceMetrics: { unexpected: "nested input" }
  }];
  assert.deepEqual(buildEventExport(events), [{
    eventId: "event-a",
    sequence: 4,
    timestamp: "2026-11-24T20:00:00.000Z",
    eventType: "CONTAINMENT_RESOURCE_SNAPSHOT",
    severity: "info",
    engineId: "engine-a",
    resourceMetrics: { memoryPeakBytes: 1024, cpuUsageMicros: 33 }
  }]);
  assert.doesNotMatch(toJson(events), /pid|rawPayload|unexpected/);
});

test("Phase 5 CSV export quotes values and neutralizes spreadsheet formula prefixes", () => {
  const csv = toCsv([{
    sequence: 1,
    eventType: "JOB_CREATED",
    engineId: "=HYPERLINK(\"https://evil.example\",\"click\")",
    code: "safe,with comma",
    memoryPeakBytes: 512
  }]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /"safe,with comma"/);
  assert.match(csv, /512/);
  assert.match(csv, /\r\n/);
});

test("Phase 5 event export handles empty events and rejects non-arrays", () => {
  assert.deepEqual(buildEventExport([]), []);
  assert.equal(toCsv([]).split("\r\n").length, 1);
  assert.equal(toJson([]), "[]");
  assert.throws(() => buildEventExport({}), /array/);
});
