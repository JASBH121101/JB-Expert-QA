import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createLocalApprovalGate } from "../src/agent/local-approval-gate.js";

test("local dashboard can approve one sanitized pending QA action", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-approval-"));
  const gate = createLocalApprovalGate();
  const execution = gate.requestApproval({
    executionId: "exec-1", actionId: "action-1",
    actionType: "qa.engine.jb.static-qa-engine", risk: "high",
    permissions: ["qa:engine-execute"], inputDigest: "e".repeat(64),
    scope: { path: "/private/path", token: "secret-value" }
  });
  const host = {
    getStatus: async () => ({ enabled: true, state: "idle" }),
    getReadiness: async () => ({ ready: false, state: "idle" }),
    getLiveness: async () => ({ alive: false, state: "idle" }),
    getDiagnostics: async () => ({}),
    start: async () => {}, stop: async () => {},
    listApprovals: gate.listPending, getApprovalStatus: gate.getStatus,
    approveApproval: gate.approve, denyApproval: gate.deny
  };
  const server = createDashboardServer({ storageDirectory: directory, phase5HostBootstrap: host });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    gate.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const listed = await fetch(origin + "/api/phase5/host/approvals");
  assert.equal(listed.status, 200);
  const data = await listed.json();
  assert.equal(data.pending.length, 1);
  assert.equal(JSON.stringify(data).includes("secret-value"), false);
  assert.equal(JSON.stringify(data).includes("/private/path"), false);
  const id = data.pending[0].id;
  const deniedOrigin = await fetch(origin + "/api/phase5/host/approvals/" + id + "/approve", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" }, body: "{}"
  });
  assert.equal(deniedOrigin.status, 403);
  const approved = await fetch(origin + "/api/phase5/host/approvals/" + id + "/approve", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}"
  });
  assert.equal(approved.status, 200);
  assert.equal((await execution).approved, true);
  const again = await fetch(origin + "/api/phase5/host/approvals/" + id + "/approve", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}"
  });
  assert.equal(again.status, 409);
});
