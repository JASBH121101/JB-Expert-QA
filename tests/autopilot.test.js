import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAutopilot } from "../src/agent/autopilot.js";

function fakeProvider(taskRisk = "medium") {
  const calls = [];
  return {
    calls,
    provider: "test-provider",
    model: "test-model",
    generateJson: async (request) => {
      calls.push(request);
      return {
        summary: "Review the detected issues.",
        tasks: [{
          id: "test-task",
          title: "Review source issue",
          rationale: "The audit found a code-quality issue.",
          expected_outcome: "The code becomes easier to maintain.",
          target_files: ["src/app.js"],
          risk: taskRisk
        }]
      };
    }
  };
}

async function fixtureProject() {
  const root = await mkdtemp(join(tmpdir(), "jbqa-agent-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.js"), "export const ready = true;\n");
  return root;
}

test("auto-repair rejects missing opt-ins before making an AI request", async () => {
  const provider = fakeProvider("low");
  await assert.rejects(
    runAutopilot(".", { provider, applyLowRisk: true }),
    /allowSourceUpload=true/
  );
  assert.equal(provider.calls.length, 0);
});

test("default autopilot produces a plan without uploading source or changing a repository", async () => {
  const root = await fixtureProject();
  try {
    const provider = fakeProvider("low");
    const result = await runAutopilot(root, { provider });
    assert.equal(result.status, "plan-only");
    assert.equal(result.safety.sourceUploadedToAi, false);
    assert.equal(result.safety.isolatedGitWorktree, false);
    assert.equal(result.safety.testsExecuted, false);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].image, undefined);
    assert.equal(JSON.stringify(provider.calls[0].prompt).includes("export const ready"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("medium-risk plans remain advisory even when repair flags are present", async () => {
  const root = await fixtureProject();
  try {
    const provider = fakeProvider("medium");
    const result = await runAutopilot(root, {
      provider,
      applyLowRisk: true,
      allowSourceUpload: true,
      runTests: true
    });
    assert.equal(result.status, "no-safe-task");
    assert.equal(result.safety.sourceUploadedToAi, false);
    assert.equal(result.safety.isolatedGitWorktree, false);
    assert.equal(result.safety.testsExecuted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
