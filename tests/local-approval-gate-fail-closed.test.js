import test from "node:test";
import assert from "node:assert/strict";
import { createLocalApprovalGate } from "../src/agent/local-approval-gate.js";

const input = { executionId:"r1", actionId:"a1", actionType:"qa.engine.jb.static-qa-engine", risk:"high", permissions:["qa:engine-execute"], inputDigest:"f".repeat(64) };

test("deny, abort and close all return a negative decision", async () => {
  const gate = createLocalApprovalGate();
  const denied = gate.requestApproval(input);
  const [one] = gate.listPending();
  assert.equal(gate.deny(one.id), true);
  assert.deepEqual(await denied, { approved:false });

  const controller = new AbortController();
  const aborted = gate.requestApproval({ ...input, actionId:"a2", signal:controller.signal });
  controller.abort();
  assert.deepEqual(await aborted, { approved:false });

  const closing = gate.requestApproval({ ...input, actionId:"a3" });
  gate.close();
  assert.deepEqual(await closing, { approved:false });
});

test("capacity and malformed approval metadata fail closed", async () => {
  const gate = createLocalApprovalGate({ maxPending:1 });
  const first = gate.requestApproval(input);
  assert.deepEqual(await gate.requestApproval({ ...input, actionId:"a2" }), { approved:false });
  const [item] = gate.listPending();
  gate.deny(item.id);
  await first;
  assert.throws(() => gate.requestApproval({ ...input, risk:"critical" }), { code:"INVALID_APPROVAL_REQUEST" });
  gate.close();
});
