import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createContainedLocalProcessEngineRunner,
  ContainedProcessEngineRunnerError
} from "../src/agent/contained-process-runner.js";

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "jbqa-contained-process-"));
  const modulePath = join(root, "runner.mjs");
  await writeFile(modulePath, `
    export async function run(input) {
      return { received: input.value, executed: true };
    }
  `, "utf8");

  const runner = createContainedLocalProcessEngineRunner({
    runner: {
      engineId: "jb.test.contained",
      moduleRoot: root,
      modulePath,
      cwd: root,
      timeoutMs: 5000
    },
    containment: {
      policy: { allowUncontainedFallback: true },
      capabilityProbeOptions: { platform: "freebsd" },
      ...options.containment
    }
  });

  return {
    root,
    runner,
    async cleanup() {
      await runner.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("contained runner owns dispatch and reports an explicit uncontained fallback", async () => {
  const item = await createFixture();
  try {
    const before = item.runner.getStatus();
    assert.equal(before.containmentDispatcher.mode, "uncontained-fallback");
    assert.equal(before.containmentDispatcher.enforced, false);
    assert.equal(before.resourceContainment.configured, true);
    assert.equal(before.resourceContainment.controller.mode, "uncontained-fallback");

    const result = await item.runner.run({ value: "runner-integration" });
    assert.deepEqual(result, {
      received: "runner-integration",
      executed: true
    });
    assert.equal(item.runner.getStatus().containmentDispatcher.activeScopes, 0);
  } finally {
    await item.cleanup();
  }
});

test("contained runner closes the process runner before its dispatcher and rejects later runs", async () => {
  const item = await createFixture();
  try {
    await item.runner.run({ value: "close-order" });
    const closed = await item.runner.close();
    assert.equal(closed.state, "closed");
    assert.equal(closed.containmentDispatcher.state, "closed");
    assert.equal(closed.containmentDispatcher.accepting, false);
    assert.equal(closed.containmentDispatcher.activeScopes, 0);
    await assert.rejects(
      item.runner.run({ value: "after-close" }),
      (error) => error instanceof ContainedProcessEngineRunnerError &&
        error.code === "RUNNER_CLOSED"
    );
  } finally {
    await item.cleanup();
  }
});

test("contained runner fails closed when native containment is unavailable by default", () => {
  assert.throws(
    () => createContainedLocalProcessEngineRunner({
      runner: {
        engineId: "jb.test.contained",
        moduleRoot: "/tmp",
        modulePath: "/tmp/runner.mjs"
      },
      containment: {
        capabilityProbeOptions: { platform: "freebsd" }
      }
    }),
    (error) => error.code === "UNSUPPORTED_CONTAINMENT_PLATFORM"
  );
});

test("contained runner rejects caller-injected resource controllers", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-contained-invalid-"));
  const modulePath = join(root, "runner.mjs");
  await writeFile(modulePath, "export function run() { return {}; }", "utf8");
  try {
    assert.throws(
      () => createContainedLocalProcessEngineRunner({
        runner: {
          engineId: "jb.test.contained",
          moduleRoot: root,
          modulePath,
          resourceController: {
            createScope() {},
            getStatus() {}
          }
        },
        containment: {
          policy: { allowUncontainedFallback: true },
          capabilityProbeOptions: { platform: "freebsd" }
        }
      }),
      (error) => error instanceof ContainedProcessEngineRunnerError &&
        error.code === "UNSUPPORTED_OPTION"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required containment cannot be weakened by an uncontained fallback policy", () => {
  assert.throws(
    () => createContainedLocalProcessEngineRunner({
      runner: {
        engineId: "jb.test.contained",
        moduleRoot: "/tmp",
        modulePath: "/tmp/runner.mjs"
      },
      containment: {
        policy: { required: true, allowUncontainedFallback: true },
        capabilityProbeOptions: { platform: "freebsd" }
      }
    }),
    (error) => error.code === "CONFLICTING_CONTAINMENT_POLICY"
  );
});
