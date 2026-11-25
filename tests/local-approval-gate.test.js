import test from "node:test";
import assert from "node:assert/strict";
import { createLocalApprovalGate } from "../src/agent/local-approval-gate.js";

test("local approval gate requires an explicit operator decision", async () => {
  const gate = createLocalApprovalGate();
  const pending = gate.requestApproval({ executionId: "run-1", actionId: "step-1", actionType: "qa.engine.jb.static-qa-engine", risk: "high", permissions: ["qa:engine-execute"], inputDigest: "a".repeat(64) });
  const [request] = gate.listPending();
  assert.ok(request);
  assert.equal(gate.approve(request.id), true);
  assert.equal((await pending).approved, true);
  assert.equal(gate.approve(request.id), false);
  gate.close();
});
