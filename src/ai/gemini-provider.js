const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models/";
const DEFAULT_MODEL = "gemini-3.1-flash-lite";

function responseText(payload) {
  const parts = payload && payload.candidates && payload.candidates[0] &&
    payload.candidates[0].content && payload.candidates[0].content.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean).join("\n").trim();
}

function parseJson(value) {
  const source = String(value || "").trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "")
    .replace(/\s*\x60\x60\x60$/, "");
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("Gemini returned a response that was not valid JSON");
  }
}

function makeProviderError(status) {
  const error = new Error("Gemini request rejected with HTTP " + status);
  error.provider = "google-gemini";
  error.status = status;
  error.code = status === 429 ? "quota_exhausted" :
    status >= 500 ? "provider_unavailable" : "provider_request_rejected";
  return error;
}

export function createGeminiProvider({
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_TEXT_MODEL || DEFAULT_MODEL,
  visionModel = process.env.GEMINI_VISION_MODEL || model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  maxImageBytes = 5200000
} = {}) {
  const key = String(apiKey || "").trim();
  const selectedModel = String(model || "").trim();
  const selectedVisionModel = String(visionModel || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(selectedModel)) {
    throw new TypeError("A valid Gemini text model name is required");
  }
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(selectedVisionModel)) {
    throw new TypeError("A valid Gemini vision model name is required");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new TypeError("timeoutMs must be between 1000 and 120000");
  }
  if (!Number.isInteger(maxImageBytes) || maxImageBytes < 1024) {
    throw new TypeError("maxImageBytes must be at least 1024");
  }

  return Object.freeze({
    provider: "google-gemini",
    model: selectedModel,
    visionModel: selectedVisionModel,
    isConfigured: Boolean(key),
    async generateJson({
      systemInstruction,
      prompt,
      image = null,
      maxOutputTokens = 1200,
      temperature = 0.15
    } = {}) {
      if (!key) {
        const error = new Error("GEMINI_API_KEY is not configured");
        error.provider = "google-gemini";
        error.code = "provider_not_configured";
        throw error;
      }
      if (typeof systemInstruction !== "string" || !systemInstruction.trim()) {
        throw new TypeError("systemInstruction is required");
      }
      if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("prompt is required");
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 8192) {
        throw new TypeError("maxOutputTokens must be between 64 and 8192");
      }
      if (typeof temperature !== "number" || !Number.isFinite(temperature) ||
          temperature < 0 || temperature > 1) {
        throw new TypeError("temperature must be between 0 and 1");
      }

      const parts = [{ text: prompt }];
      if (image !== null) {
        if (!image || !Buffer.isBuffer(image.buffer) || !image.buffer.length) {
          throw new TypeError("image.buffer must be a non-empty Buffer");
        }
        if (image.buffer.length > maxImageBytes) {
          const error = new Error("Image exceeds the configured Gemini upload limit");
          error.code = "image_too_large";
          throw error;
        }
        const mimeType = String(image.mimeType || "image/png").toLowerCase();
        if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
          throw new TypeError("Only PNG, JPEG and WebP images are supported");
        }
        parts.push({
          inline_data: {
            mime_type: mimeType,
            data: image.buffer.toString("base64")
          }
        });
      }

      let response;
      try {
        response = await fetchImpl(
          API_ROOT + encodeURIComponent(image === null ? selectedModel : selectedVisionModel) + ":generateContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": key
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts }],
              generationConfig: {
                temperature,
                maxOutputTokens,
                responseMimeType: "application/json"
              }
            }),
            signal: AbortSignal.timeout(timeoutMs)
          }
        );
      } catch (cause) {
        const error = new Error("Gemini request failed before a response was received");
        error.provider = "google-gemini";
        error.code = cause && (cause.name === "TimeoutError" || cause.name === "AbortError")
          ? "provider_timeout" : "provider_network_error";
        throw error;
      }

      if (!response.ok) throw makeProviderError(response.status);
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Gemini returned an unreadable response");
      }
      const candidate = payload && payload.candidates && payload.candidates[0];
      if (!candidate || candidate.finishReason === "SAFETY" ||
          candidate.finishReason === "RECITATION") {
        const error = new Error("Gemini did not provide an evaluable response");
        error.provider = "google-gemini";
        error.code = "provider_response_blocked";
        throw error;
      }
      const text = responseText(payload);
      if (!text) throw new Error("Gemini returned an empty response");
      return parseJson(text);
    }
  });
}
