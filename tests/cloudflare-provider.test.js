import test from "node:test";
import assert from "node:assert/strict";
import { createCloudflareProvider, CLOUDFLARE_TEXT_MODEL, CLOUDFLARE_VISION_MODEL } from "../src/ai/cloudflare-provider.js";

function fakeResponse({ status = 200, payload = { success: true, result: { response: '{"ok":true}' } } } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

const common = {
  accountId: "account-test",
  apiToken: "token-test",
  freeTierConfirmed: true
};

test("Cloudflare provider is disabled unless free-tier status is explicitly confirmed", async () => {
  const provider = createCloudflareProvider({
    accountId: "account-test",
    apiToken: "token-test",
    freeTierConfirmed: false,
    fetchImpl: async () => fakeResponse()
  });
  assert.equal(provider.isConfigured, false);
  await assert.rejects(provider.generateJson({
    systemInstruction: "Return JSON.",
    prompt: "Test."
  }), { code: "provider_not_configured" });
});

test("Cloudflare provider sends JSON requests to the allowlisted text model", async () => {
  let request;
  const provider = createCloudflareProvider({
    ...common,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return fakeResponse();
    }
  });
  const result = await provider.generateJson({
    systemInstruction: "Return JSON only.",
    prompt: "Return {ok:true}."
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(request.url, "https://api.cloudflare.com/client/v4/accounts/account-test/ai/run/" + CLOUDFLARE_TEXT_MODEL);
  assert.equal(request.options.headers.Authorization, "Bearer token-test");
  assert.equal(request.body.response_format.type, "json_object");
  assert.equal(provider.getUsage().requestsUsed, 1);
});

test("Cloudflare provider selects its vision model and sends image bytes as base64", async () => {
  let requestBody;
  const provider = createCloudflareProvider({
    ...common,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return fakeResponse();
    }
  });
  await provider.generateJson({
    systemInstruction: "Review screenshot.",
    prompt: "Return JSON.",
    image: { buffer: Buffer.from("image-data"), mimeType: "image/png" }
  });
  assert.equal(requestBody.image, Buffer.from("image-data").toString("base64"));
  assert.equal(requestBody.messages[1].content, "Return JSON.");
  assert.ok(CLOUDFLARE_VISION_MODEL.includes("llama-3.2-11b-vision"));
});

test("Cloudflare provider turns the daily free-allocation error into a quota stop", async () => {
  const provider = createCloudflareProvider({
    ...common,
    fetchImpl: async () => fakeResponse({
      status: 429,
      payload: { success: false, errors: [{ code: 3036, message: "You have used up your daily free allocation of 10,000 neurons." }] }
    })
  });
  await assert.rejects(provider.generateJson({
    systemInstruction: "Return JSON.",
    prompt: "Test."
  }), { code: "quota_exhausted" });
});

test("Cloudflare provider stops at its local per-run request budget", async () => {
  let calls = 0;
  const provider = createCloudflareProvider({
    ...common,
    maxRequestsPerRun: 1,
    fetchImpl: async () => { calls += 1; return fakeResponse(); }
  });
  const input = { systemInstruction: "Return JSON.", prompt: "Test." };
  await provider.generateJson(input);
  await assert.rejects(provider.generateJson(input), { code: "quota_exhausted" });
  assert.equal(calls, 1);
});

test("Cloudflare provider refuses model overrides outside its no-paid-model allowlist", () => {
  assert.throws(() => createCloudflareProvider({
    ...common,
    textModel: "@cf/zai-org/glm-5.3"
  }), /allowlist/);
});
