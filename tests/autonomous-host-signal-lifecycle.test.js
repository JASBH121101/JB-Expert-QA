import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachHostSignalLifecycle, HostSignalLifecycleError } from "../src/agent/autonomous-host-signal-lifecycle.js";

function mockHost(close = async () => ({ state: "closed" })) {
  let calls = 0;
  return { host: { close: async () => { calls += 1; return close(); } }, calls: () => calls };
}

test("signal lifecycle attaches only on explicit call and graceful signal closes host once", async () => {
  const source = new EventEmitter();
  const mock = mockHost();
  const lifecycle = attachHostSignalLifecycle({ host: mock.host, signalSource: source });
  assert.deepEqual(lifecycle.getStatus().attachedSignals, ["SIGINT", "SIGTERM"]);
  source.emit("SIGTERM");
  source.emit("SIGINT");
  const status = await lifecycle.shutdown();
  assert.equal(status.state, "closed");
  assert.equal(status.shutdownSignal, "SIGTERM");
  assert.equal(mock.calls(), 1);
  lifecycle.detach();
  assert.equal(source.listenerCount("SIGINT"), 0);
  assert.equal(source.listenerCount("SIGTERM"), 0);
});

test("detach removes signal handlers without closing host", async () => {
  const source = new EventEmitter();
  const mock = mockHost();
  const lifecycle = attachHostSignalLifecycle({ host: mock.host, signalSource: source, signals: ["SIGINT"] });
  lifecycle.detach();
  source.emit("SIGINT");
  assert.equal(mock.calls(), 0);
  assert.equal(lifecycle.getStatus().state, "detached");
});

test("host close failure is reported through callback and state is observable", async () => {
  const source = new EventEmitter();
  const failure = Object.assign(new Error("controlled close failed"), { code: "HOST_CLOSE_ERR" });
  const mock = mockHost(() => { throw failure; });
  let received;
  const lifecycle = attachHostSignalLifecycle({
    host: mock.host,
    signalSource: source,
    onError: error => { received = error; }
  });
  source.emit("SIGTERM");
  const status = await lifecycle.shutdown();
  assert.equal(status.state, "failed");
  assert.equal(status.closeErrorCode, "HOST_CLOSE_ERR");
  assert.equal(received, failure);
});

test("signal configuration validation and accessor safety", () => {
  const source = new EventEmitter();
  const mock = mockHost();
  assert.throws(() => attachHostSignalLifecycle({ host: mock.host, signalSource: source, signals: ["SIGTERM", "SIGTERM"] }),
    error => error.code === "INVALID_SIGNALS");
  let getterCalled = false;
  const options = { host: mock.host, signalSource: source };
  Object.defineProperty(options, "signals", { enumerable: true, get() { getterCalled = true; return ["SIGTERM"]; } });
  assert.throws(() => attachHostSignalLifecycle(options), error => error.code === "ACCESSOR_NOT_ALLOWED");
  assert.equal(getterCalled, false);
});

test("signal attachment failure rolls back already attached listeners", () => {
  const source = new EventEmitter();
  const originalOn = source.on.bind(source);
  source.on = (signal, handler) => {
    if (signal === "SIGTERM") throw new Error("attach failure");
    return originalOn(signal, handler);
  };
  const mock = mockHost();
  assert.throws(() => attachHostSignalLifecycle({ host: mock.host, signalSource: source }),
    error => error.code === "SIGNAL_ATTACH_FAILED");
  assert.equal(source.listenerCount("SIGINT"), 0);
  assert.equal(source.listenerCount("SIGTERM"), 0);
});
