import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("website audit workflow restores the daily Cloudflare quota circuit breaker", async () => {
  const workflow = await readFile(new URL("../.github/workflows/site-audit.yml", import.meta.url), "utf8");
  assert.match(workflow, /actions\/cache\/restore@v4/);
  assert.match(workflow, /key: jbqa-ai-quota-\$\{\{ steps\.quota_day\.outputs\.day \}\}/);
  assert.match(workflow, /JBQA_AI_QUOTA_STATE_PATH:/);
  assert.match(workflow, /CLOUDFLARE_FREE_TIER_CONFIRMED:/);
});

test("website audit workflow saves only a quota marker and only when newly created", async () => {
  const workflow = await readFile(new URL("../.github/workflows/site-audit.yml", import.meta.url), "utf8");
  assert.match(workflow, /actions\/cache\/save@v4/);
  assert.match(workflow, /hashFiles\('\.jbqa-ai-quota\/provider-quota\.json'\) != ''/);
  assert.match(workflow, /steps\.ai_quota_cache\.outputs\.cache-hit != 'true'/);
  assert.match(workflow, /path: \.jbqa-ai-quota/);
  assert.doesNotMatch(workflow, /path: .*\.env/);
});

test("website audit workflow serializes manual runs sharing provider quotas", async () => {
  const workflow = await readFile(new URL("../.github/workflows/site-audit.yml", import.meta.url), "utf8");
  assert.match(workflow, /concurrency:\\s+group: jb-expert-qa-site-audit\\s+cancel-in-progress: false/);
});
