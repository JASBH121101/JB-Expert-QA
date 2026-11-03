import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAiProviderRouter } from "../src/ai/provider-router.js";

function provider(name, sequence, calls) {
  return {
    provider: name,
    isConfigured: true,
    async generateJson(input) {
      calls.push({ name, input });
      const next = sequence.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

function quotaError(message = "Quota exhausted") {
  const error = new Error(message);
  error.code = "quota_exhausted";
  return error;
}

test("AI router is disabled by default and makes no provider request", async () => {
  const calls = [];
  const primary = provider("gemini", [{ ok: true }], calls);
  const fallback = provider("cloudflare", [{ ok: true }], calls);
  const router = createAiProviderRouter({ primary, fallback });
  assert.equal(router.isConfigured, false);
  await assert.rejects(router.generateJson({ prompt: "test" }), { code: "ai_disabled_by_policy" });
  assert.equal(calls.length, 0);
});

test("AI router switches from exhausted Gemini to Cloudflare and keeps using fallback", async () => {
  const calls = [];
  const primary = provider("gemini", [quotaError()], calls);
  const fallback = provider("cloudflare", [{ source: "fallback-1" }, { source: "fallback-2" }], calls);
  const router = createAiProviderRouter({ enabled: true, primary, fallback });

  assert.deepEqual(await router.generateJson({ prompt: "first" }), { source: "fallback-1" });
  assert.deepEqual(await router.generateJson({ prompt: "second" }), { source: "fallback-2" });
  assert.deepEqual(calls.map((call) => call.name), ["gemini", "cloudflare", "cloudflare"]);
  assert.equal(router.getStatus().primary, "quota-exhausted");
  assert.equal(router.getStatus().lastProvider, "cloudflare");
});

test("AI router disables every provider when Cloudflare free quota is exhausted", async () => {
  const calls = [];
  const primary = provider("gemini", [quotaError()], calls);
  const fallback = provider("cloudflare", [quotaError()], calls);
  const router = createAiProviderRouter({ enabled: true, primary, fallback });

  await assert.rejects(router.generateJson({ prompt: "first" }), { code: "ai_quota_exhausted" });
  await assert.rejects(router.generateJson({ prompt: "second" }), { code: "ai_disabled_for_run" });
  assert.deepEqual(calls.map((call) => call.name), ["gemini", "cloudflare"]);
  assert.equal(router.getStatus().aiDisabled, true);
});

test("AI router falls back on Gemini network errors but does not retry either provider", async () => {
  const calls = [];
  const networkError = new Error("network");
  networkError.code = "provider_network_error";
  const primary = provider("gemini", [networkError, { shouldNotRun: true }], calls);
  const fallback = provider("cloudflare", [{ ok: true }], calls);
  const router = createAiProviderRouter({ enabled: true, primary, fallback });

  assert.deepEqual(await router.generateJson({ prompt: "test" }), { ok: true });
  assert.deepEqual(calls.map((call) => call.name), ["gemini", "cloudflare"]);
});

test("Cloudflare daily quota circuit breaker persists for the UTC day", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-ai-quota-"));
  const quotaStatePath = join(directory, "quota.json");
  try {
    const calls = [];
    const exhausted = quotaError();
    exhausted.quotaScope = "daily";
    const firstRouter = createAiProviderRouter({
      enabled: true,
      primary: provider("gemini", [quotaError()], calls),
      fallback: provider("cloudflare", [exhausted], calls),
      quotaStatePath
    });
    await assert.rejects(firstRouter.generateJson({ prompt: "quota check" }), {
      code: "ai_quota_exhausted"
    });

    const secondRouter = createAiProviderRouter({
      enabled: true,
      primary: provider("gemini", [{ source: "gemini" }], calls),
      fallback: provider("cloudflare", [{ source: "must-not-run" }], calls),
      quotaStatePath
    });
    assert.equal(secondRouter.getStatus().fallback, "daily-quota-exhausted");
    assert.deepEqual(await secondRouter.generateJson({ prompt: "next process" }), { source: "gemini" });
    assert.deepEqual(calls.map((call) => call.name), ["gemini", "cloudflare", "gemini"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI router reports a per-run Cloudflare cap separately from the daily quota", async () => {
  const calls = [];
  const perRunError = quotaError();
  perRunError.quotaScope = "run";
  const router = createAiProviderRouter({
    enabled: true,
    primary: provider("gemini", [quotaError()], calls),
    fallback: provider("cloudflare", [perRunError], calls),
    quotaStatePath: null
  });
  await assert.rejects(router.generateJson({ prompt: "cap check" }), {
    code: "ai_quota_exhausted"
  });
  assert.equal(router.getStatus().fallback, "disabled-for-run");
});

test("AI router exposes Cloudflare per-run usage and remaining requests", () => {
  const calls = [];
  const primary = provider("gemini", [{ ok: true }], calls);
  const fallback = provider("cloudflare", [{ ok: true }], calls);
  fallback.getUsage = () => ({
    requestsUsed: 3,
    maxRequestsPerRun: 4,
    remainingRequests: 1
  });
  const router = createAiProviderRouter({ enabled: true, primary, fallback });

  assert.deepEqual(router.getStatus().cloudflareUsage, {
    requestsUsed: 3,
    maxRequestsPerRun: 4,
    remainingRequests: 1
  });
});
