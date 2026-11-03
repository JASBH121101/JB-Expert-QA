import { createGeminiProvider } from "./gemini-provider.js";
import { createCloudflareProvider } from "./cloudflare-provider.js";

const FALLBACKABLE_CODES = new Set([
  "quota_exhausted",
  "provider_unavailable",
  "provider_network_error",
  "provider_timeout"
]);

function unavailableError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.provider = "jbqa-ai-router";
  return error;
}

export function createAiProviderRouter({
  enabled = process.env.JBQA_AI_ENABLED === "true",
  primary = createGeminiProvider(),
  fallback = createCloudflareProvider()
} = {}) {
  const state = {
    enabled: Boolean(enabled),
    primaryExhausted: false,
    primaryUnavailable: false,
    fallbackDisabled: false,
    allAiDisabled: !enabled,
    lastProvider: null,
    disableReason: enabled ? null : "AI is disabled by default; explicitly enable deep analysis"
  };

  const configuredProviders = [primary, fallback].filter((provider) =>
    provider && provider.isConfigured !== false &&
    typeof provider.generateJson === "function"
  );

  const router = {
    get provider() {
      return state.lastProvider || "jbqa-ai-router";
    },
    get isConfigured() {
      return state.enabled && configuredProviders.length > 0;
    },
    getStatus() {
      return Object.freeze({
        enabled: state.enabled,
        primary: primary && primary.isConfigured !== false && !state.primaryExhausted && !state.primaryUnavailable
          ? "available" : state.primaryExhausted ? "quota-exhausted" : "unavailable",
        fallback: fallback && fallback.isConfigured !== false && !state.fallbackDisabled
          ? "available" : state.fallbackDisabled ? "quota-exhausted-or-disabled" : "not-configured",
        lastProvider: state.lastProvider,
        aiDisabled: state.allAiDisabled,
        disableReason: state.disableReason
      });
    },
    async generateJson(input) {
      if (!state.enabled) {
        throw unavailableError("ai_disabled_by_policy", state.disableReason);
      }
      if (state.allAiDisabled) {
        throw unavailableError("ai_disabled_for_run", "All AI providers are disabled for this run");
      }

      const candidates = [];
      if (!state.primaryExhausted && !state.primaryUnavailable &&
          primary && primary.isConfigured !== false) candidates.push(primary);
      if (!state.fallbackDisabled && fallback && fallback.isConfigured !== false) candidates.push(fallback);
      if (!candidates.length) {
        state.allAiDisabled = true;
        state.disableReason = "No configured AI provider remains available";
        throw unavailableError("ai_providers_unavailable", state.disableReason);
      }

      let lastError = null;
      for (const candidate of candidates) {
        try {
          const result = await candidate.generateJson(input);
          state.lastProvider = candidate.provider || "configured-provider";
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("AI provider failed");
          const code = lastError.code || "provider_request_rejected";
          const isPrimary = candidate === primary;

          if (code === "quota_exhausted") {
            if (isPrimary) {
              state.primaryExhausted = true;
              state.disableReason = "Gemini quota exhausted; switched to Cloudflare Workers AI";
            } else {
              state.fallbackDisabled = true;
              state.allAiDisabled = true;
              state.disableReason = "Cloudflare Workers AI quota or local request budget exhausted; all AI disabled for this run";
              throw unavailableError("ai_quota_exhausted", state.disableReason);
            }
            continue;
          }

          if (FALLBACKABLE_CODES.has(code) && isPrimary) {
            state.primaryUnavailable = true;
            state.disableReason = "Gemini unavailable; attempting Cloudflare Workers AI";
            continue;
          }

          if (!isPrimary) {
            state.fallbackDisabled = true;
            state.allAiDisabled = true;
            state.disableReason = "Cloudflare Workers AI unavailable; all AI disabled for this run";
            throw unavailableError("ai_fallback_unavailable", state.disableReason);
          }

          throw lastError;
        }
      }

      state.allAiDisabled = true;
      state.disableReason = "No AI provider could complete the request";
      const error = unavailableError("ai_providers_unavailable", state.disableReason);
      if (lastError) error.cause = lastError;
      throw error;
    }
  };

  return Object.freeze(router);
}
