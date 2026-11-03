import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pngjs from "pngjs";
import { reviewScreenshot, validateVisualReview } from "../src/ai/visual-review.js";
import { createRemediationPlan, validateRemediationPlan } from "../src/ai/remediation-plan.js";
import {
  evaluatePatchPaths,
  redactSourceForAI,
  validateUnifiedPatch
} from "../src/agent/policy.js";

const { PNG } = pngjs;

function screenshot() {
  const image = new PNG({ width: 3, height: 2 });
  image.data.fill(255);
  return PNG.sync.write(image);
}

test("visual review contract validates findings and always requires human review", () => {
  const result = validateVisualReview({
    visual_score: 87,
    overall_assessment: "Clear layout with a minor alignment issue.",
    strengths: ["Readable hierarchy"],
    issues: [{
      severity: "low",
      region: "header",
      evidence: "The logo is slightly misaligned.",
      recommendation: "Align the logo with the navigation baseline.",
      confidence: 0.78
    }],
    limitations: ["Only one viewport was supplied."]
  });
  assert.equal(result.visualScore, 87);
  assert.equal(result.issues.length, 1);
  assert.equal(result.manualReviewRequired, true);
  assert.throws(() => validateVisualReview({ visual_score: 101, issues: [] }), /1 to 100/);
  assert.throws(() => validateVisualReview({ visual_score: 80, issues: [{ severity: "urgent" }] }), /valid severity/);
});

test("visual screenshot review uses bounded context and returns normalized observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-ai-visual-"));
  try {
    const imagePath = join(directory, "capture.png");
    await writeFile(imagePath, screenshot());
    let request;
    const provider = {
      provider: "test-provider",
      model: "test-vision",
      generateJson: async (payload) => {
        request = payload;
        return {
          visual_score: 92,
          overall_assessment: "The page is balanced.",
          strengths: ["Strong contrast"],
          issues: [],
          limitations: []
        };
      }
    };
    const result = await reviewScreenshot(imagePath, {
      provider,
      context: {
        viewport: { width: 390, height: 844 },
        findings: [{ title: "Overflow", severity: "high", location: "body" }]
      }
    });
    assert.equal(result.review.visualScore, 92);
    assert.equal(result.review.manualReviewRequired, true);
    assert.match(request.prompt, /Overflow/);
    assert.equal(request.image.buffer.length > 0, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remediation plan contract makes every task approval-gated", () => {
  const plan = validateRemediationPlan({
    summary: "Resolve the low-risk UI findings.",
    tasks: [{
      id: "task-a",
      title: "Correct card spacing",
      rationale: "A repeated spacing defect was observed.",
      expected_outcome: "Consistent card spacing.",
      target_files: ["src/components/card.js"],
      risk: "low"
    }]
  });
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].requiresHumanApproval, true);
  assert.equal(plan.autoExecutionAllowed, false);
  assert.equal(plan.requiresHumanApproval, true);
  assert.throws(() => validateRemediationPlan({ tasks: [{ risk: "critical" }] }), /valid risk/);
});

test("AI planner receives audit metadata and produces an approval-gated plan", async () => {
  let prompt = "";
  const provider = {
    provider: "test-provider",
    model: "test-text",
    generateJson: async (payload) => {
      prompt = payload.prompt;
      return {
        summary: "Address the reported layout issue.",
        tasks: [{
          id: "spacing",
          title: "Fix spacing",
          rationale: "Measured evidence shows inconsistent spacing.",
          expected_outcome: "More consistent visual rhythm.",
          target_files: ["src/components/card.js"],
          risk: "low"
        }]
      };
    }
  };
  const report = {
    scoring: { passed: false, score: 72 },
    analysisScope: { complete: true },
    diagnostics: [{
      id: "UI-1",
      specialist: "ui-ux",
      title: "Uneven spacing",
      description: "Spacing varies between product cards.",
      severity: "medium",
      location: "src/components/card.js",
      recommendation: "Use the shared spacing token.",
      metadata: {}
    }]
  };
  const result = await createRemediationPlan(report, { provider });
  assert.match(prompt, /Uneven spacing/);
  assert.equal(result.plan.tasks[0].risk, "low");
  assert.equal(result.plan.autoExecutionAllowed, false);
  assert.equal(prompt.includes("export const secret"), false);
});

test("patch policy allows source files only and blocks sensitive project paths", () => {
  const result = evaluatePatchPaths([
    "src/components/card.js",
    "package.json",
    "src/auth/login.js",
    "src/database/client.ts",
    "src/agent/policy.js",
    "../outside.js",
    ".env"
  ]);
  assert.deepEqual(result.allowed, ["src/components/card.js"]);
  assert.equal(result.blocked.length, 6);
});

test("unified patches are restricted to the exact approved source file", () => {
  const patch = [
    "diff --git a/src/components/card.js b/src/components/card.js",
    "--- a/src/components/card.js",
    "+++ b/src/components/card.js",
    "@@ -1 +1 @@",
    "-export const gap = 8;",
    "+export const gap = 12;"
  ].join("\n");
  assert.deepEqual(
    validateUnifiedPatch(patch, { allowedPaths: ["src/components/card.js"] }),
    ["src/components/card.js"]
  );
  assert.throws(
    () => validateUnifiedPatch(patch.replaceAll("src/components/card.js", "src/auth.js"), {
      allowedPaths: ["src/components/card.js"]
    }),
    /outside the approved/
  );
  assert.throws(
    () => validateUnifiedPatch(patch.replace("diff --git", "deleted file mode 100644\ndiff --git"), {
      allowedPaths: ["src/components/card.js"]
    }),
    /deleted/
  );
});

test("source redaction removes credential values before AI upload", () => {
  const source = 'const API_KEY = "this-is-a-very-long-secret-key-value";\nconst item = "ghp_' + "A".repeat(36) + '";\nconst pem = "-----BEGIN PRIVATE KEY-----\\nSECRET-MATERIAL\\n-----END PRIVATE KEY-----";\nconst endpoint = "https://example.com/?access_token=url-secret-value";';
  const redacted = redactSourceForAI(source);
  assert.equal(redacted.includes("this-is-a-very-long-secret-key-value"), false);
  assert.equal(redacted.includes("ghp_"), false);
  assert.match(redacted, /REDACTED/);
  assert.equal(redacted.includes("SECRET-MATERIAL"), false);\n  assert.equal(redacted.includes("url-secret-value"), false);
});


test("unified patch validator accepts multiple approved files but validates each section", () => {
  const patch = [
    "diff --git a/src/components/card.js b/src/components/card.js",
    "--- a/src/components/card.js",
    "+++ b/src/components/card.js",
    "@@ -1 +1 @@",
    "-export const gap = 8;",
    "+export const gap = 12;",
    "diff --git a/src/components/header.js b/src/components/header.js",
    "--- a/src/components/header.js",
    "+++ b/src/components/header.js",
    "@@ -1 +1 @@",
    "-export const size = 8;",
    "+export const size = 10;"
  ].join("\\n");
  assert.deepEqual(validateUnifiedPatch(patch, {
    allowedPaths: ["src/components/card.js", "src/components/header.js"]
  }), ["src/components/card.js", "src/components/header.js"]);
});
