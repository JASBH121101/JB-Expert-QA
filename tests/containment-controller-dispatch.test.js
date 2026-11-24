import assert from "node:assert/strict";
import test from "node:test";
import {
  createContainmentControllerDispatcher,
  ContainmentControllerDispatchError
} from "../src/agent/containment-controller-dispatch.js";

const LINUX_CAPABILITIES = {
  platform: "linux",
  cgroupRoot: "/fake/cgroup",
  exists: () => true,
  readText: () => "cpu memory pids"
};

test("Linux dispatch refuses to start without a delegated child cgroup path", () => {
  assert.throws(
    () => createContainmentControllerDispatcher({
      capabilityProbeOptions: LINUX_CAPABILITIES
    }),
    (error) => error instanceof ContainmentControllerDispatchError &&
      error.code === "LINUX_DELEGATED_ROOT_REQUIRED"
  );
});

test("Linux dispatch permits uncontained fallback only when explicitly authorized", () => {
  const dispatcher = createContainmentControllerDispatcher({
    policy: { allowUncontainedFallback: true },
    capabilityProbeOptions: LINUX_CAPABILITIES
  });

  const status = dispatcher.getStatus();
  assert.equal(status.mode, "uncontained-fallback");
  assert.equal(status.available, false);
  assert.equal(status.enforced, false);
  assert.equal(status.allowUncontainedFallback, true);
  assert.equal(status.fallbackReason, "LINUX_DELEGATED_ROOT_REQUIRED");

  const scope = dispatcher.createScope({
    engineId: "expert-qa",
    requestId: "12345678-1234-4234-8234-123456789012"
  });
  assert.deepEqual(scope.getUsage(), { state: "unenforced", contained: false });
  assert.deepEqual(awaitValue(scope.attachProcess(123)), {
    attached: false,
    contained: false,
    pid: 123
  });
  assert.deepEqual(awaitValue(scope.terminateAll()), { terminated: false, contained: false });
  assert.equal(dispatcher.getStatus().activeScopes, 1);
  scope.close();
  assert.equal(dispatcher.getStatus().activeScopes, 0);
});

function awaitValue(value) {
  return value;
}

test("unsupported platforms fail closed unless fallback is explicitly enabled", () => {
  assert.throws(
    () => createContainmentControllerDispatcher({
      capabilityProbeOptions: { platform: "freebsd" }
    }),
    (error) => error.code === "UNSUPPORTED_CONTAINMENT_PLATFORM"
  );

  const fallback = createContainmentControllerDispatcher({
    policy: { allowUncontainedFallback: true },
    capabilityProbeOptions: { platform: "freebsd" }
  });
  assert.equal(fallback.getStatus().mode, "uncontained-fallback");
  assert.equal(fallback.getStatus().enforced, false);
});

test("required containment cannot be combined with uncontained fallback", () => {
  assert.throws(
    () => createContainmentControllerDispatcher({
      policy: { required: true, allowUncontainedFallback: true },
      capabilityProbeOptions: { platform: "freebsd" }
    }),
    (error) => error.code === "CONFLICTING_CONTAINMENT_POLICY"
  );
});

test("invalid capability probes are rejected without invoking getters", () => {
  let invoked = false;
  const options = {};
  Object.defineProperty(options, "platform", {
    enumerable: true,
    get() {
      invoked = true;
      return "linux";
    }
  });
  assert.throws(
    () => createContainmentControllerDispatcher({ capabilityProbeOptions: options }),
    (error) => error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(invoked, false);
});

test("Windows dispatch initializes its native Job Object adapter on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("requires the Windows Job Object host");
    return;
  }
  const dispatcher = createContainmentControllerDispatcher();
  assert.equal(dispatcher.getStatus().mode, "windows-job-object");
  assert.equal(dispatcher.getStatus().enforced, true);
  await dispatcher.close();
  assert.equal(dispatcher.getStatus().activeScopes, 0);
});
