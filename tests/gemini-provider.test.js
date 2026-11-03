import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiProvider } from "../src/ai/gemini-provider.js";

function okResponse(value) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("Gemini text provider sends JSON-mode request and parses the response", async () => {
  let capturedUrl = "";
  let capturedOptions;
  const provider = createGeminiProvider({
    apiKey: "test-secret-key",
    model: "gemini-test-model",
    fetchImpl: async (url, options) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return okResponse({ plan: true });
    }
  });

  const result = await provider.generateJson({
    systemInstruction: "Return JSON only",
    prompt: "Create a test response"
  });
  assert.deepEqual(result, { plan: true });
  assert.match(capturedUrl, /gemini-test-model:generateContent$/);
  assert.equal(capturedOptions.headers["x-goog-api-key"], "test-secret-key");
  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.contents[0].parts[0].text, "Create a test response");
});

test("Gemini provider encodes image bytes only in the request body", async () => {
  let captured;
  const provider = createGeminiProvider({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      captured = JSON.parse(options.body);
      return okResponse({ reviewed: true });
    }
  });
  const image = Buffer.from([0, 1, 2, 255]);
  const result = await provider.generateJson({
    systemInstruction: "Inspect an image",
    prompt: "Review this screenshot",
    image: { buffer: image, mimeType: "image/png" }
  });
  assert.deepEqual(result, { reviewed: true });
  assert.equal(captured.contents[0].parts[1].inline_data.mime_type, "image/png");
  assert.equal(captured.contents[0].parts[1].inline_data.data, image.toString("base64"));
});

test("Gemini provider classifies quota failures without retrying", async () => {
  const provider = createGeminiProvider({
    apiKey: "test-key",
    fetchImpl: async () => new Response("{}", { status: 429 })
  });
  await assert.rejects(
    provider.generateJson({ systemInstruction: "JSON", prompt: "Test" }),
    (error) => error.code === "quota_exhausted" && error.status === 429
  );
});

test("Gemini provider blocks missing credentials before making a request", async () => {
  let requests = 0;
  const provider = createGeminiProvider({
    apiKey: "",
    fetchImpl: async () => {
      requests += 1;
      return okResponse({});
    }
  });
  assert.equal(provider.isConfigured, false);
  await assert.rejects(
    provider.generateJson({ systemInstruction: "JSON", prompt: "Test" }),
    (error) => error.code === "provider_not_configured"
  );
  assert.equal(requests, 0);
});

test("Gemini provider rejects malformed JSON output and unsupported image media", async () => {
  const invalidJson = createGeminiProvider({
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "not json" }] } }]
    }), { status: 200 })
  });
  await assert.rejects(
    invalidJson.generateJson({ systemInstruction: "JSON", prompt: "Test" }),
    /not valid JSON/
  );

  const imageProvider = createGeminiProvider({ apiKey: "test-key" });
  await assert.rejects(
    imageProvider.generateJson({
      systemInstruction: "JSON",
      prompt: "Test",
      image: { buffer: Buffer.from("test"), mimeType: "image/gif" }
    }),
    /Only PNG, JPEG and WebP/
  );
});
