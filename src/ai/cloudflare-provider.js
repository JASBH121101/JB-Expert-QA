const API_ROOT = "https://api.cloudflare.com/client/v4/accounts/";
export const CLOUDFLARE_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const CLOUDFLARE_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_IMAGE_BYTES = 5200000;
const DEFAULT_MAX_REQUESTS = 4;

function parseJson(value) {
  const source = String(value || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("Cloudflare Workers AI returned a response that was not valid JSON");
  }
}

function cloudflareError(payload, status) {
  const errors = Array.isArray(payload && payload.errors) ? payload.errors : [];
  const codes = errors.map((item) => Number(item && item.code)).filter(Number.isFinite);
  const messages = errors.map((item) => String(item && item.message || "")).join(" ");
  const dailyLimit = codes.includes(3036) || /daily free allocation|10,000 neurons/i.test(messages);
  const capacity = codes.includes(3040) || /capacity temporarily exceeded/i.test(messages);
  const paidModel = codes.includes(5035) || /requires a workers paid plan/i.test(messages);
  const error = new Error(dailyLimit
    ? "Cloudflare Workers AI free daily allocation is exhausted"
    : capacity
      ? "Cloudflare Workers AI is temporarily out of capacity"
      : paidModel
        ? "The configured Cloudflare AI model requires a paid plan and is blocked by policy"
        : "Cloudflare Workers AI request rejected with HTTP " + status);
  error.provider = "cloudflare-workers-ai";
  error.status = status;
  if (dailyLimit) error.quotaScope = "daily";
  error.code = dailyLimit ? "quota_exhausted"
    : capacity ? "provider_unavailable"
      : paidModel ? "paid_model_blocked" : "provider_request_rejected";
  return error;
}

export function createCloudflareProvider({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  freeTierConfirmed = process.env.CLOUDFLARE_FREE_TIER_CONFIRMED === "true",
  fetchImpl = globalThis.fetch,
  textModel = CLOUDFLARE_TEXT_MODEL,
  visionModel = CLOUDFLARE_VISION_MODEL,
  maxRequestsPerRun = Number(process.env.CLOUDFLARE_MAX_REQUESTS_PER_RUN || DEFAULT_MAX_REQUESTS),
  timeoutMs = 45000,
  maxImageBytes = MAX_IMAGE_BYTES
} = {}) {
  const id = String(accountId || "").trim();
  const token = String(apiToken || "").trim();
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (![CLOUDFLARE_TEXT_MODEL].includes(textModel)) {
    throw new TypeError("Cloudflare text model is not in the JB Expert QA free-tier allowlist");
  }
  if (![CLOUDFLARE_VISION_MODEL].includes(visionModel)) {
    throw new TypeError("Cloudflare vision model is not in the JB Expert QA free-tier allowlist");
  }
  if (!Number.isInteger(maxRequestsPerRun) || maxRequestsPerRun < 1 || maxRequestsPerRun > 10) {
    throw new TypeError("maxRequestsPerRun must be between 1 and 10");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new TypeError("timeoutMs must be between 1000 and 120000");
  }
  if (!Number.isInteger(maxImageBytes) || maxImageBytes < 1024) {
    throw new TypeError("maxImageBytes must be at least 1024");
  }

  let requestsUsed = 0;
  const isConfigured = Boolean(id && token && freeTierConfirmed);

  return Object.freeze({
    provider: "cloudflare-workers-ai",
    isConfigured,
    getUsage() {
      return Object.freeze({ requestsUsed, maxRequestsPerRun, remainingRequests: maxRequestsPerRun - requestsUsed });
    },
    async generateJson({
      systemInstruction,
      prompt,
      image = null,
      maxOutputTokens = 1200,
      temperature = 0.1
    } = {}) {
      if (!isConfigured) {
        const error = new Error(
          "Cloudflare Workers AI requires account ID, API token and CLOUDFLARE_FREE_TIER_CONFIRMED=true"
        );
        error.provider = "cloudflare-workers-ai";
        error.code = "provider_not_configured";
        throw error;
      }
      if (requestsUsed >= maxRequestsPerRun) {
        const error = new Error("Cloudflare Workers AI per-run request budget is exhausted");
        error.provider = "cloudflare-workers-ai";
        error.code = "quota_exhausted";
        error.quotaScope = "run";
        throw error;
      }
      if (typeof systemInstruction !== "string" || !systemInstruction.trim()) {
        throw new TypeError("systemInstruction is required");
      }
      if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("prompt is required");
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 4096) {
        throw new TypeError("maxOutputTokens must be between 64 and 4096");
      }
      if (typeof temperature !== "number" || !Number.isFinite(temperature) ||
          temperature < 0 || temperature > 1) {
        throw new TypeError("temperature must be between 0 and 1");
      }

      const hasImage = image !== null;
      if (hasImage && (!image || !Buffer.isBuffer(image.buffer) || !image.buffer.length ||
          image.buffer.length > maxImageBytes)) {
        const error = new Error("Cloudflare image must be a non-empty Buffer within the configured size limit");
        error.code = "image_size_invalid";
        throw error;
      }
      if (hasImage && !["image/png", "image/jpeg", "image/webp"].includes(
        String(image.mimeType || "image/png").toLowerCase()
      )) {
        throw new TypeError("Only PNG, JPEG and WebP images are supported");
      }

      const model = hasImage ? visionModel : textModel;
      const messages = [
        { role: "system", content: systemInstruction },
        { role: "user", content: prompt }
      ];
      const body = {
        messages,
        max_tokens: maxOutputTokens,
        temperature,
        response_format: { type: "json_object" }
      };
      if (hasImage) {
        const mimeType = String(image.mimeType || "image/png").toLowerCase();
        body.image = "data:" + mimeType + ";base64," + image.buffer.toString("base64");
      }

      requestsUsed += 1;
      let response;
      try {
        response = await fetchImpl(
          API_ROOT + encodeURIComponent(id) + "/ai/run/" + model,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
          }
        );
      } catch (cause) {
        const error = new Error("Cloudflare Workers AI request failed before a response was received");
        error.provider = "cloudflare-workers-ai";
        error.code = cause && (cause.name === "TimeoutError" || cause.name === "AbortError")
          ? "provider_timeout" : "provider_network_error";
        throw error;
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Cloudflare Workers AI returned an unreadable response");
      }
      if (!response.ok || payload.success === false) {
        throw cloudflareError(payload, response.status);
      }
      const result = payload && payload.result;
      const generated = typeof result === "string" ? result
        : result && typeof result.response === "string" ? result.response
          : result && typeof result.result === "string" ? result.result : "";
      if (!generated.trim()) {
        const error = new Error("Cloudflare Workers AI returned an empty response");
        error.provider = "cloudflare-workers-ai";
        error.code = "provider_empty_response";
        throw error;
      }
      return parseJson(generated);
    }
  });
}
