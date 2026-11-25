import test from "node:test";
import assert from "node:assert/strict";
import { createLocalApprovalGate } from "../src/agent/local-approval-gate.js";

test("gate can deny a pending request", async () => {
 const gate = createLocalApprovalGate();
 const pending = gate.requestApproval({ executionId:"e1", actionId:"a1", actionType:"qa.engine.jb.static-qa-engine", risk:"high", permissions:["qa:engine-execute"], inputDigest:"c".repeat(64) });
 const [item] = gate.listPending();
 assert.equal(gate.deny(item.id), true);
 assert.deepEqual(await pending, { approved:false });
 gate.close();
});
