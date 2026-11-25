import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createAutonomousExecutionHostService,
  AutonomousExecutionHostServiceError
} from "../src/agent/autonomous-execution-host-service.js";

function createHost({ start, close } = {}) {
  const calls = { start: 0, close: 0 };
  let state = "idle";
  const host = {
    getStatus() {
      return Object.freeze({ state });
    },
    start() {
      calls.start += 1;
      if (start) start();
      state = "running";
      return host.getStatus();
    },
    async close() {
      calls.close += 1;
      if (close) await close();
      state = "closed";
      return host.getStatus();
    }
  };
  return { host, calls };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for host service state");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test("service construction is inert; explicit start and stop own host lifecycle", async () => {
  const signalSource = new EventEmitter();
  const { host, calls } = createHost();
  const service = createAutonomousExecutionHostService({ host, signalSource });

  assert.equal(calls.start, 0);
  assert.equal(calls.close, 0);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(service.getStatus().state, "idle");

  assert.equal(service.start().state, "running");
  assert.equal(calls.start, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 1);
  assert.equal(signalSource.listenerCount("SIGTERM"), 1);

  const stopped = await service.stop();
  assert.equal(stopped.state, "closed");
  assert.equal(calls.close, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(service.getStatus().host.state, "closed");
});

test("service signal shutdown delegates to the host once and exposes terminal state", async () => {
  const signalSource = new EventEmitter();
  const { host, calls } = createHost();
  const service = createAutonomousExecutionHostService({ host, signalSource });

  service.start();
  signalSource.emit("SIGTERM");
  signalSource.emit("SIGINT");
  await waitFor(() => service.getStatus().state === "closed");

  assert.equal(calls.close, 1);
  assert.equal(service.getStatus().signalLifecycle.shutdownSignal, "SIGTERM");
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  await service.stop();
  assert.equal(calls.close, 1);
});

test("service stop is single-flight while host graceful close is pending", async () => {
  const signalSource = new EventEmitter();
  let release;
  const { host, calls } = createHost({
    close: () => new Promise(resolve => { release = resolve; })
  });
  const service = createAutonomousExecutionHostService({ host, signalSource });

  service.start();
  const first = service.stop();
  const second = service.stop();
  assert.equal(first, second);
  assert.equal(calls.close, 1);
  assert.equal(service.getStatus().state, "stopping");

  release();
  const status = await first;
  assert.equal(status.state, "closed");
});

test("failed host startup removes installed signal handlers and remains terminal", async () => {
  const signalSource = new EventEmitter();
  const { host, calls } = createHost({
    start: () => { throw Object.assign(new Error("not ready"), { code: "RUNTIME_NOT_READY" }); }
  });
  const service = createAutonomousExecutionHostService({ host, signalSource });

  assert.throws(() => service.start(), error => error.code === "RUNTIME_NOT_READY");
  assert.equal(service.getStatus().state, "failed");
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  await service.stop();
  assert.equal(calls.close, 1);
  assert.equal(service.getStatus().state, "closed");
  assert.throws(() => service.start(), error =>
    error instanceof AutonomousExecutionHostServiceError && error.code === "SERVICE_TERMINAL"
  );
});

test("service validates plain options and trusted host methods", () => {
  assert.throws(
    () => createAutonomousExecutionHostService({ host: {}, signalSource: new EventEmitter() }),
    error => error.code === "INVALID_HOST"
  );
  assert.throws(
    () => createAutonomousExecutionHostService({ host: createHost().host, signalSource: {} }),
    error => error.code === "INVALID_SIGNAL_SOURCE"
  );

  let getterCalled = false;
  const options = { host: createHost().host, signalSource: new EventEmitter() };
  Object.defineProperty(options, "signals", {
    enumerable: true,
    get() {
      getterCalled = true;
      return ["SIGTERM"];
    }
  });
  assert.throws(
    () => createAutonomousExecutionHostService(options),
    error => error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(getterCalled, false);
});

test("signal-driven close failures remain observable without exposing exception text", async () => {
  const signalSource = new EventEmitter();
  const failure = Object.assign(new Error("private shutdown detail"), { code: "HOST_CLOSE_FAILED" });
  const { host } = createHost({
    close: () => { throw failure; }
  });
  let observed;
  const service = createAutonomousExecutionHostService({
    host,
    signalSource,
    onError: error => { observed = error; }
  });

  service.start();
  signalSource.emit("SIGTERM");
  await waitFor(() => service.getStatus().state === "failed");

  assert.equal(observed, failure);
  assert.equal(JSON.stringify(service.getStatus()).includes("private shutdown detail"), false);
});
