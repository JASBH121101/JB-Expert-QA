import { chromium } from "playwright";
import { ExpertQAEngine } from "../../core/engine.js";
import { RuleRegistry } from "../../core/rule-registry.js";
import { ENGINE_VERSION } from "../../core/version.js";
import { createUrlSafetyGuard, assertSafeWebSocketUrl } from "../playwright/url-safety.js";
import { redactUrlForReport } from "../../core/redaction.js";
import { securityRuntimeRules } from "../../specialists/runtime-security-rules.js";
import runtimeConfig from "../../../config/security-url.config.json" with { type: "json" };

function parseSetCookie(value) {
  const parts = String(value).split(";");
  const pair = parts.shift() ?? "";
  const separator = pair.indexOf("=");
  const name = separator < 0 ? pair.trim() : pair.slice(0, separator).trim();
  const attributes = new Map(parts.map((part) => {
    const index = part.indexOf("=");
    return index < 0
      ? [part.trim().toLowerCase(), true]
      : [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()];
  }));
  return {
    name,
    secure: attributes.has("secure"),
    httpOnly: attributes.has("httponly"),
    sameSite: attributes.get("samesite") || null
  };
}

function normalizeHeaders(entries) {
  const result = {};
  for (const entry of entries) {
    const name = String(entry.name).toLowerCase();
    if (!result[name]) result[name] = [];
    result[name].push(String(entry.value));
  }
  return result;
}

export async function auditSecurityUrl(url, {
  config = runtimeConfig,
  timeout = 30000,
  headless = true,
  allowPrivateNetworks = false
} = {}) {
  if (typeof url !== "string" || !url.trim()) throw new TypeError("A target URL is required");
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) {
    throw new TypeError("timeout must be an integer between 1000 and 60000 milliseconds");
  }
  if (typeof headless !== "boolean" || typeof allowPrivateNetworks !== "boolean") {
    throw new TypeError("headless and allowPrivateNetworks must be booleans");
  }

  const assertSafeUrl = createUrlSafetyGuard({ allowPrivateNetworks });
  const parsed = await assertSafeUrl(url);
  const browser = await chromium.launch({ headless });
  let browserContext;
  try {
    browserContext = await browser.newContext({ serviceWorkers: "block" });
    const page = await browserContext.newPage();
    const httpSubresources = [];
    const blockedRequests = [];
    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      try {
        const protocol = new URL(requestUrl).protocol;
        if (protocol === "http:" || protocol === "https:") await assertSafeUrl(requestUrl);
        await route.continue();
      } catch (error) {
        blockedRequests.push({
          url: redactUrlForReport(requestUrl),
          reason: error instanceof Error ? error.message : String(error)
        });
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    await page.routeWebSocket("**/*", async (socket) => {
      try {
        await assertSafeWebSocketUrl(socket.url(), assertSafeUrl);
        socket.connectToServer();
      } catch (error) {
        blockedRequests.push({
          url: redactUrlForReport(socket.url()),
          reason: error instanceof Error ? error.message : String(error)
        });
        await socket.close({ code: 1008, reason: "Blocked by JB Expert QA network policy" });
      }
    });
    page.on("request", (request) => {
      try {
        const requestUrl = new URL(request.url());
        if (requestUrl.protocol === "http:" && request.resourceType() !== "document") {
          httpSubresources.push({
            url: redactUrlForReport(request.url()),
            resourceType: request.resourceType()
          });
        }
      } catch {
        // Non-HTTP browser-internal URLs are outside the mixed-content check.
      }
    });

    let response;
    try {
      response = await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout });
    } catch (error) {
      throw new Error("Unable to load the target page safely: " +
        (error instanceof Error ? error.message : String(error)));
    }
    if (!response) throw new Error("The target did not return a main-document HTTP response");
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 4000) }).catch(() => {});

    const entries = await response.headersArray();
    const headers = normalizeHeaders(entries);
    const cookies = entries
      .filter((entry) => entry.name.toLowerCase() === "set-cookie")
      .map((entry) => parseSetCookie(entry.value))
      .filter((item) => item.name);
    const finalUrl = page.url();
    const mixedContent = finalUrl.startsWith("https://") ? httpSubresources : [];
    const context = {
      securityHttpResponse: {
        initialUrl: redactUrlForReport(parsed.href),
        finalUrl: redactUrlForReport(finalUrl),
        status: response.status(),
        headers,
        cookies,
        mixedContent
      }
    };
    const registry = new RuleRegistry();
    for (const rule of securityRuntimeRules) registry.register(rule);
    const report = await new ExpertQAEngine({ registry, config }).audit(context);
    return Object.freeze({
      ...report,
      engine: "JB Expert QA — Runtime Security Auditor",
      version: ENGINE_VERSION,
      target: Object.freeze({
        initialUrl: redactUrlForReport(parsed.href),
        finalUrl: redactUrlForReport(finalUrl),
        status: response.status()
      }),
      runtimeAssessment: Object.freeze({
        mode: "passive-browser-observation",
        requestsMadeByAuditor: true,
        exploitPayloadsSent: false,
        authenticatedSessionUsed: false,
        databaseConnections: 0,
        blockedRequests: Object.freeze(blockedRequests),
        mixedContentRequests: mixedContent.length,
        cookieValuesReported: false,
        limitations: Object.freeze([
          "This check loads the page normally and inspects the main document response; it does not attempt exploitation.",
          "It does not authenticate, submit forms, crawl linked pages, or test role-based access controls.",
          "Browser and CDN behavior can vary by region, user agent, and cache state; findings should be confirmed against the deployed response configuration.",
          "It observes only response headers and cookies visible to the browser for the main document, not every API endpoint or subresource response."
        ])
      })
    });
  } finally {
    if (browserContext) await browserContext.close().catch(() => {});
    await browser.close();
  }
}
