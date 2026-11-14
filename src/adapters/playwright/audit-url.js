import { chromium } from "playwright";
import { createBrowserEnvironment } from "./browser-environment.js";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { comparePngFiles } from "../visual/png-diff.js";
import { createRequire } from "node:module";
import { ExpertQAEngine } from "../../core/engine.js";
import { RuleRegistry } from "../../core/rule-registry.js";
import { ENGINE_VERSION } from "../../core/version.js";
import { createUrlSafetyGuard, assertSafeWebSocketUrl } from "./url-safety.js";
import { redactUrlForReport, redactUrlsInText } from "../../core/redaction.js";
import {
  responsiveRules,
  uiUxRules,
  accessibilityRules,
  performanceRules,
  functionalRules,
  consistencyRules
} from "../../specialists/index.js";
import { collectPageContext } from "./context.js";
import { collectVisualIntegrity } from "./visual-integrity.js";
import { applyThemeOverride, collectThemeContext } from "./theme-context.js";
import { analyzeContrastSamples, summarizeContrastResults } from "../visual/contrast.js";
import { exploreInteractionStates } from "./interactions.js";
import defaultConfig from "../../../config/default.config.json" with { type: "json" };

const require = createRequire(import.meta.url);
const axeScriptPath = require.resolve("axe-core/axe.min.js");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

function themeTokenMap(themeContext = {}) {
  return new Map((themeContext.themeAudit?.colorTokens ?? []).map((token) => [
    String(token.scope ?? "root") + ":" + token.name,
    token.value
  ]));
}

function contrastSampleMap(themeContext = {}) {
  return new Map((themeContext.contrastSamples ?? []).map((sample) => [
    String(sample.selector ?? "") + "|" + String(sample.kind ?? "text"),
    JSON.stringify({
      foreground: sample.foreground,
      backgroundStatus: sample.backgroundStatus,
      backgroundReason: sample.backgroundReason,
      backgroundLayers: sample.backgroundLayers,
      fontSizePx: sample.fontSizePx,
      fontWeight: sample.fontWeight
    })
  ]));
}

async function auditThemeRoundTrip(page, {
  initialContext,
  colorScheme,
  themeAttribute,
  themeStorageKey
}) {
  const alternateTheme = colorScheme === "dark" ? "light" : "dark";
  const setStorageTheme = async (theme) => {
    if (!themeStorageKey) return;
    await page.evaluate(({ key, value }) => {
      try {
        const previous = window.localStorage.getItem(key);
        window.localStorage.setItem(key, value);
        window.dispatchEvent(new StorageEvent("storage", {
          key,
          oldValue: previous,
          newValue: value,
          storageArea: window.localStorage,
          url: window.location.href
        }));
      } catch {}
    }, { key: themeStorageKey, value: theme });
  };

  await page.emulateMedia({ colorScheme: alternateTheme });
  await setStorageTheme(alternateTheme);
  await applyThemeOverride(page, { theme: alternateTheme, attribute: themeAttribute });
  await page.waitForTimeout(80);
  const alternateContext = await collectThemeContext(page);

  await page.emulateMedia({ colorScheme });
  await setStorageTheme(colorScheme);
  await applyThemeOverride(page, { theme: colorScheme, attribute: themeAttribute });
  await page.waitForTimeout(80);
  const restoredContext = await collectThemeContext(page);

  const initialTokens = themeTokenMap(initialContext);
  const restoredTokens = themeTokenMap(restoredContext);
  const changedTokens = [...initialTokens.keys()]
    .filter((name) => restoredTokens.has(name) &&
      initialTokens.get(name) !== restoredTokens.get(name))
    .map((name) => ({
      scope: name.split(":")[0],
      name: name.slice(name.indexOf(":") + 1),
      initialValue: initialTokens.get(name),
      restoredValue: restoredTokens.get(name)
    }));

  const addedTokens = [...restoredTokens.keys()].filter((name) => !initialTokens.has(name));
  const removedTokens = [...initialTokens.keys()].filter((name) => !restoredTokens.has(name));
  const rootColorSchemeChanged =
    initialContext.themeAudit?.rootColorScheme !== restoredContext.themeAudit?.rootColorScheme;
  const themeMarkerChanged =
    initialContext.themeAudit?.themeMarker !== restoredContext.themeAudit?.themeMarker;

  const initialSamples = contrastSampleMap(initialContext);
  const restoredSamples = contrastSampleMap(restoredContext);
  const sharedSamples = [...initialSamples.keys()].filter((key) => restoredSamples.has(key));
  const changedSamples = sharedSamples
    .filter((key) => initialSamples.get(key) !== restoredSamples.get(key))
    .map((key) => ({
      selector: key.split("|")[0],
      kind: key.split("|")[1]
    }));

  return Object.freeze({
    enabled: true,
    sequence: Object.freeze([colorScheme, alternateTheme, colorScheme]),
    alternateThemeMarker: alternateContext.themeAudit?.themeMarker ?? null,
    restoredThemeMarker: restoredContext.themeAudit?.themeMarker ?? null,
    restoredColorScheme: restoredContext.themeAudit?.requestedColorScheme ?? null,
    changedTokens: Object.freeze(changedTokens),
    addedTokens: Object.freeze(addedTokens),
    removedTokens: Object.freeze(removedTokens),
    changedSamples: Object.freeze(changedSamples),
    rootColorSchemeChanged,
    themeMarkerChanged,
    addedSamplesAfterRestore: Math.max(0, restoredSamples.size - sharedSamples.length),
    removedSamplesAfterRestore: Math.max(0, initialSamples.size - sharedSamples.length),
    restoredStable: changedTokens.length === 0 && addedTokens.length === 0 &&
      removedTokens.length === 0 && changedSamples.length === 0 &&
      !rootColorSchemeChanged && !themeMarkerChanged
  });
}

const ALL_RULES = [
  ...responsiveRules,
  ...uiUxRules,
  ...accessibilityRules,
  ...performanceRules,
  ...functionalRules,
  ...consistencyRules
];

export async function auditUrl(url, {
  config = defaultConfig,
  viewport = { width: 1365, height: 900 },
  specialist,
  timeout = 30000,
  headless = true,
  runAxe = true,
  allowPrivateNetworks = false,
  sameOriginOnly = false,
  interactionExploration = false,
  maxInteractionActions = 8,
  interactionSettleMs = 180,
  interactionScreenshotDir = null,
  interactionBaselineDir = null,
  interactionDiffDir = null,
  updateInteractionBaselines = false,
  interactionVisualThreshold = 0.1,
  interactionMaxDiffPixelRatio = 0.005,
  interactionViewportName = "default",
  screenshotPath = null,
  screenshotFullPage = false,
  colorScheme = "light",
  themeAttribute = null,
  themeStorageKey = null,
  themeTransitionAudit = false,
  targetLanguage = null,
  preserveTerms
} = {}) {
  if (!["light", "dark"].includes(colorScheme)) throw new TypeError("colorScheme must be light or dark");
  if (targetLanguage !== null &&
      (typeof targetLanguage !== "string" || !/^(?:es|en)(?:[-_][a-z0-9]+)?$/i.test(targetLanguage.trim()))) {
    throw new TypeError("targetLanguage must be es, en, or a supported locale such as es-NI or en-US");
  }
  if (typeof themeTransitionAudit !== "boolean") throw new TypeError("themeTransitionAudit must be a boolean");
  if (themeAttribute !== null &&
      (typeof themeAttribute !== "string" ||
       !(themeAttribute === "class" || /^data-[a-z0-9_-]{1,60}$/i.test(themeAttribute)))) {
    throw new TypeError("themeAttribute must be class or a valid data-* attribute");
  }
  if (themeStorageKey !== null &&
      (typeof themeStorageKey !== "string" || !themeStorageKey.trim() ||
       themeStorageKey.length > 120 || [...themeStorageKey].some((character) =>
         character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    throw new TypeError("themeStorageKey must be a non-empty key of at most 120 characters");
  }
  if (typeof updateInteractionBaselines !== "boolean") throw new TypeError("updateInteractionBaselines must be a boolean");
  if (interactionBaselineDir && !interactionScreenshotDir && !screenshotPath) {
    throw new TypeError("Interaction screenshots are required for interaction baselines");
  }
  if (interactionDiffDir && !interactionBaselineDir) {
    throw new TypeError("interactionBaselineDir is required for interaction diffs");
  }
  if (updateInteractionBaselines && !interactionBaselineDir) {
    throw new TypeError("interactionBaselineDir is required when updating interaction baselines");
  }
  if (typeof sameOriginOnly !== "boolean") throw new TypeError("sameOriginOnly must be a boolean");
  if (typeof interactionExploration !== "boolean") throw new TypeError("interactionExploration must be a boolean");
  if (screenshotPath !== null && (typeof screenshotPath !== "string" || !screenshotPath.trim())) throw new TypeError("screenshotPath must be a non-empty path");
  const assertSafeUrl = createUrlSafetyGuard({ allowPrivateNetworks });
  const parsed = await assertSafeUrl(url);

  const browser = await chromium.launch({ headless, env: createBrowserEnvironment(process.env) });
  let browserContext;
  try {
    browserContext = await browser.newContext({ viewport, serviceWorkers: "block", colorScheme });
    if (themeStorageKey) {
      await browserContext.addInitScript(({ key, theme }) => {
        try {
          window.localStorage.setItem(key, theme);
          window.__jbqaThemeStorageSeeded = true;
        } catch {
          window.__jbqaThemeStorageSeeded = false;
        }
      }, { key: themeStorageKey, theme: colorScheme });
    }
    const page = await browserContext.newPage();
    const runtimeIssues = {
      pageErrors: [],
      failedRequests: [],
      httpErrors: [],
      blockedRequests: []
    };
    page.on("pageerror", (error) => runtimeIssues.pageErrors.push({
      message: redactUrlsInText(error.message)
    }));
    page.on("requestfailed", (request) => runtimeIssues.failedRequests.push({
      url: redactUrlForReport(request.url()),
      failureText: redactUrlsInText(request.failure()?.errorText ?? "Request failed")
    }));
    page.on("response", (response) => {
      if (response.status() >= 400) runtimeIssues.httpErrors.push({
        url: redactUrlForReport(response.url()),
        status: response.status(),
        resourceType: response.request().resourceType()
      });
    });

    // Re-check every HTTP(S) navigation/resource, including redirects and browser fetches.
    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      try {
        const requestProtocol = new URL(requestUrl).protocol;
        if (["http:", "https:"].includes(requestProtocol)) {
          if (sameOriginOnly && new URL(requestUrl).origin !== parsed.origin) {
            throw new Error("Request blocked by same-origin-only audit policy");
          }
          await assertSafeUrl(requestUrl);
        }
        await route.continue();
      } catch (error) {
        runtimeIssues.blockedRequests.push({
          url: redactUrlForReport(requestUrl),
          reason: error instanceof Error ? error.message : String(error)
        });
        await route.abort("blockedbyclient").catch(() => {});
      }
    });

    await page.routeWebSocket("**/*", async (webSocketRoute) => {
      const socketUrl = webSocketRoute.url();
      try {
        const normalizedSocketUrl = socketUrl.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
        if (sameOriginOnly && new URL(normalizedSocketUrl).origin !== parsed.origin) {
          throw new Error("WebSocket blocked by same-origin-only audit policy");
        }
        await assertSafeWebSocketUrl(socketUrl, assertSafeUrl);
        webSocketRoute.connectToServer();
      } catch (error) {
        runtimeIssues.blockedRequests.push({
          url: redactUrlForReport(socketUrl),
          reason: error instanceof Error ? error.message : String(error)
        });
        await webSocketRoute.close({ code: 1008, reason: "Blocked by JB Expert QA network policy" });
      }
    });

    await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5000) }).catch(() => {});
    await applyThemeOverride(page, { theme: colorScheme, attribute: themeAttribute });
    const context = await collectPageContext(page, { thresholds: config.thresholds ?? {} });
    const themeContext = await collectThemeContext(page);
    const visualIntegrity = await collectVisualIntegrity(page, { targetLanguage, preserveTerms });
    Object.assign(context, visualIntegrity);
    const themeTransition = themeTransitionAudit
      ? await auditThemeRoundTrip(page, {
          initialContext: themeContext,
          colorScheme,
          themeAttribute,
          themeStorageKey
        })
      : Object.freeze({ enabled: false, restoredStable: null });
    Object.assign(context, themeContext);
    context.themeTransitionAudit = themeTransition;
    context.themeAudit = {
      ...context.themeAudit,
      appliedThemeAttribute: themeAttribute,
      storageKeySeeded: themeStorageKey
        ? await page.evaluate(() => window.__jbqaThemeStorageSeeded === true)
        : false
    };
    context.url = redactUrlForReport(context.url);
    context.resources = (context.resources ?? []).map((resource) => ({
      ...resource,
      name: redactUrlForReport(resource.name)
    }));

    let interactionResult = null;
    if (interactionExploration) {
      interactionResult = await exploreInteractionStates(page, {
        url: parsed.href,
        thresholds: config.thresholds ?? {},
        maxActions: maxInteractionActions,
        settleMs: interactionSettleMs,
        timeout,
        screenshotDir: interactionScreenshotDir ?? (screenshotPath ? join(dirname(screenshotPath), "interaction-states") : null),
        baselineDir: interactionBaselineDir,
        diffDir: interactionDiffDir,
        updateBaselines: updateInteractionBaselines,
        visualThreshold: interactionVisualThreshold,
        maxDiffPixelRatio: interactionMaxDiffPixelRatio,
        viewportName: interactionViewportName,
        colorScheme,
        themeAttribute
      });
      context.interactiveElements = [
        ...(context.interactiveElements ?? []).map((item) => ({ ...item, state: "initial" })),
        ...interactionResult.interactiveElements
      ];
      context.interactiveOverlaps = [
        ...(context.interactiveOverlaps ?? []).map((item) => ({ ...item, state: "initial" })),
        ...interactionResult.interactiveOverlaps
      ];
      context.interactionExploration = {
        enabled: true,
        candidatesDiscovered: interactionResult.candidatesDiscovered,
        actionsAttempted: interactionResult.actionsAttempted,
        statesCaptured: interactionResult.statesCaptured,
        overlapsFound: interactionResult.overlapsFound,
        states: interactionResult.states,
        skipped: interactionResult.skipped,
        contrastSamplesTruncated: interactionResult.contrastSamplesTruncated
      };
    } else {
      context.interactionExploration = {
        enabled: false,
        candidatesDiscovered: 0,
        actionsAttempted: 0,
        statesCaptured: 0,
        overlapsFound: 0,
        states: [],
        skipped: [],
        contrastSamplesTruncated: false
      };
    }

    const allContrastSamples = [
      ...(context.contrastSamples ?? []),
      ...(interactionResult?.contrastSamples ?? [])
    ];
    context.contrastAnalysis = analyzeContrastSamples(allContrastSamples);
    context.contrastSummary = summarizeContrastResults(context.contrastAnalysis);

    Object.assign(context, runtimeIssues);

    if (runAxe) {
      try {
        await page.addScriptTag({ path: axeScriptPath });
        context.axeViolations = await page.evaluate(async (tags) => {
          const result = await window.axe.run(document, {
            runOnly: { type: "tag", values: tags }
          });
          return result.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
            description: violation.description,
            helpUrl: violation.helpUrl,
            nodes: violation.nodes.slice(0, 8).map((node) => ({
              target: node.target,
              summary: node.failureSummary?.slice(0, 500) ?? ""
            }))
          }));
        }, AXE_TAGS);
      } catch (error) {
        context.axeViolations = [];
        runtimeIssues.pageErrors.push({
          message: "axe-core scan failed: " + (error instanceof Error ? error.message : String(error))
        });
      }
    }

    if (screenshotPath) {
      await mkdir(dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: screenshotFullPage, animations: "disabled" });
    }

    const configuredSpecialists = new Set(Object.keys(config.weights ?? {}));
    const activeRules = ALL_RULES.filter((rule) => configuredSpecialists.has(rule.specialist));
    const registry = new RuleRegistry();
    activeRules.forEach((rule) => registry.register(rule));
    const engine = new ExpertQAEngine({ registry, config });
    const report = await engine.audit(context, { specialist });
    return {
      ...report,
      target: { url: redactUrlForReport(parsed.href), viewport, pageTitle: context.title, theme: colorScheme },
      evidence: {
        documentScrollWidth: context.documentScrollWidth,
        documentScrollHeight: context.documentScrollHeight,
        pageErrors: runtimeIssues.pageErrors.length,
        failedRequests: runtimeIssues.failedRequests.length,
        httpErrors: runtimeIssues.httpErrors.length,
        blockedRequests: runtimeIssues.blockedRequests.length,
        sameOriginOnly,
        networkDnsPolicy: Object.freeze({
          dnsRevalidatedBeforeEachHttpRequest: true,
          browserConnectionDnsPinned: false
        }),
        interactiveOverlaps: context.interactiveOverlaps?.length ?? 0,
        interactionStatesChecked: context.interactionExploration?.statesCaptured ?? 0,
        interactionCandidates: context.interactionExploration?.candidatesDiscovered ?? 0,
        interactionActionsAttempted: context.interactionExploration?.actionsAttempted ?? 0,
        interactionExploration: context.interactionExploration,
        axeViolations: context.axeViolations?.length ?? null,
        themeAudit: context.themeAudit,
        themeTransitionAudit: context.themeTransitionAudit,
        layoutIntegrity: context.layoutIntegrity?.summary ?? null,
        containerMetrics: context.layoutIntegrity?.containerMetrics ?? [],
        localizationAudit: context.localizationAudit,
        contrastSummary: context.contrastSummary,
        contrastSamplesTruncated: context.interactionExploration?.contrastSamplesTruncated ?? false,
        screenshotPath
      }
    };
  } finally {
    if (browserContext) await browserContext.close().catch(() => {});
    await browser.close();
  }
}

const DEFAULT_VIEWPORTS = Object.freeze([
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1365, height: 900 }
]);

const FULL_VIEWPORTS = Object.freeze([
  { name: "small-phone", width: 320, height: 720 },
  { name: "phone", width: 375, height: 812 },
  { name: "mobile", width: 390, height: 844 },
  { name: "large-phone", width: 430, height: 932 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "small-laptop", width: 1280, height: 720 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "desktop", width: 1600, height: 900 },
  { name: "wide-monitor", width: 1920, height: 1080 }
]);

export async function auditViewports(url, {
  viewports = DEFAULT_VIEWPORTS,
  screenshotDir = null,
  screenshotFullPage = false,
  baselineDir = null,
  diffDir = null,
  updateBaselines = false,
  visualThreshold = 0.1,
  maxDiffPixelRatio = 0.005,
  themes = ["light"],
  ...options
} = {}) {
  if (!Array.isArray(viewports) || viewports.length === 0) {
    throw new TypeError("At least one viewport is required");
  }
  if (!Array.isArray(themes) || themes.length === 0 || themes.length > 2 ||
      themes.some((theme) => !["light", "dark"].includes(theme)) ||
      new Set(themes).size !== themes.length) {
    throw new TypeError("themes must contain light, dark, or both without duplicates");
  }
  const seen = new Set();
  const seenSafeNames = new Set();
  const results = [];
  if (updateBaselines && !baselineDir) throw new TypeError("baselineDir is required when updating visual baselines");
  if (baselineDir && !screenshotDir) throw new TypeError("screenshotDir is required when comparing visual baselines");

  // Validate the complete matrix before launching Chromium or writing any artifacts.
  const validatedViewports = viewports.map((viewport) => {
    if (!viewport || typeof viewport.name !== "string" || !viewport.name.trim() ||
        viewport.name.length > 80 || /[\u0000-\u001f\u007f]/.test(viewport.name) ||
        !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) ||
        viewport.width < 1 || viewport.height < 1 ||
        viewport.width > 8192 || viewport.height > 8192 ||
        viewport.width * viewport.height > 33_554_432) {
      throw new TypeError("Each viewport requires a safe name and integer dimensions within the 32-megapixel budget");
    }
    const normalizedName = viewport.name.trim().toLowerCase();
    if (seen.has(normalizedName)) throw new Error("Duplicate viewport name: " + viewport.name);
    seen.add(normalizedName);
    const safeName = viewport.name.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
    const normalizedSafeName = safeName.toLowerCase();
    if (!safeName) throw new TypeError("Viewport name must contain at least one safe filename character");
    if (seenSafeNames.has(normalizedSafeName)) {
      throw new Error("Viewport names collide after filename normalization: " + viewport.name);
    }
    seenSafeNames.add(normalizedSafeName);
    return { viewport, safeName };
  });

  for (const { viewport, safeName } of validatedViewports) {
    for (const theme of themes) {
      const artifactName = themes.length > 1 || theme === "dark"
        ? theme + "-" + safeName
        : safeName;
      const screenshotPath = screenshotDir ? join(screenshotDir, artifactName + ".png") : null;
      const report = await auditUrl(url, {
        ...options,
        colorScheme: theme,
        themeTransitionAudit: themes.length > 1,
        screenshotPath,
        screenshotFullPage,
        viewport: { width: viewport.width, height: viewport.height },
        interactionScreenshotDir: screenshotDir ? join(screenshotDir, "interaction-states") : null,
        interactionBaselineDir: baselineDir ? join(baselineDir, "interaction-states") : null,
        interactionDiffDir: diffDir ? join(diffDir, "interaction-states") : null,
        updateInteractionBaselines: updateBaselines,
        interactionVisualThreshold: visualThreshold,
        interactionMaxDiffPixelRatio: maxDiffPixelRatio,
        interactionViewportName: artifactName
      });
      let visualComparison = null;
      if (baselineDir) {
        const baselinePath = join(baselineDir, artifactName + ".png");
        if (updateBaselines) {
          await mkdir(dirname(baselinePath), { recursive: true });
          await writeFile(baselinePath, await readFile(screenshotPath));
          visualComparison = { status: "baseline-updated", passed: false, baselinePath, actualPath: screenshotPath };
        } else {
          let baselineExists = true;
          try { await access(baselinePath); } catch { baselineExists = false; }
          if (!baselineExists) {
            visualComparison = { status: "baseline-missing", passed: false, baselinePath, actualPath: screenshotPath };
          } else {
            visualComparison = await comparePngFiles({
              baselinePath,
              actualPath: screenshotPath,
              diffPath: diffDir ? join(diffDir, artifactName + ".diff.png") : null,
              threshold: visualThreshold,
              maxDiffPixelRatio
            });
          }
        }
      }
      const visualPassed = !visualComparison ||
        (visualComparison.status === "compared" && visualComparison.passed === true);
      const interactionStates = report.evidence?.interactionExploration?.states ?? [];
      const interactionVisualPassed = !baselineDir || interactionStates.length === 0 ||
        interactionStates.every((state) =>
          state.visualComparison?.status === "compared" &&
          state.visualComparison.passed === true);
      results.push({
        name: viewport.name,
        theme,
        viewport: { width: viewport.width, height: viewport.height },
        passed: report.scoring.passed && visualPassed && interactionVisualPassed,
        score: report.scoring.score,
        findings: report.diagnostics,
        summary: report.summary,
        execution: report.execution,
        evidence: report.evidence,
        screenshotPath,
        visualComparison
      });
    }
  }
  const themeTokenComparisons = [];
  if (themes.includes("light") && themes.includes("dark")) {
    for (const { viewport } of validatedViewports) {
      const lightResult = results.find((item) => item.name === viewport.name && item.theme === "light");
      const darkResult = results.find((item) => item.name === viewport.name && item.theme === "dark");
      if (!lightResult || !darkResult) continue;
      const tokenMap = (item) => new Map(
        (item.evidence?.themeAudit?.colorTokens ?? []).map((token) => [
          String(token.scope ?? "root") + ":" + token.name,
          token.value
        ])
      );
      const lightTokens = tokenMap(lightResult);
      const darkTokens = tokenMap(darkResult);
      const sharedNames = [...lightTokens.keys()].filter((name) => darkTokens.has(name));
      const changedTokens = sharedNames
        .filter((name) => lightTokens.get(name) !== darkTokens.get(name))
        .map((name) => ({
          scope: name.split(":")[0],
          name: name.slice(name.indexOf(":") + 1),
          lightValue: lightTokens.get(name),
          darkValue: darkTokens.get(name)
        }));
      const unchangedTokens = sharedNames
        .filter((name) => lightTokens.get(name) === darkTokens.get(name))
        .map((name) => ({
          scope: name.split(":")[0],
          name: name.slice(name.indexOf(":") + 1),
          value: lightTokens.get(name)
        }));
      const comparison = Object.freeze({
        viewport: viewport.name,
        lightTokenCount: lightTokens.size,
        darkTokenCount: darkTokens.size,
        changedTokens: Object.freeze(changedTokens),
        unchangedTokens: Object.freeze(unchangedTokens),
        onlyInLight: Object.freeze([...lightTokens.keys()].filter((name) => !darkTokens.has(name))),
        onlyInDark: Object.freeze([...darkTokens.keys()].filter((name) => !lightTokens.has(name)))
      });
      lightResult.themeTokenComparison = comparison;
      darkResult.themeTokenComparison = comparison;
      themeTokenComparisons.push(comparison);
    }
  }

  return Object.freeze({
    engine: "JB Expert QA",
    version: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    target: { url: redactUrlForReport(new URL(url).href) },
    summary: Object.freeze({
      viewportsChecked: results.length,
      themesChecked: themes.length,
      viewportsPerTheme: validatedViewports.length,
      themePairsCompared: themeTokenComparisons.length,
      passedViewports: results.filter((item) => item.passed).length,
      failedViewports: results.filter((item) => !item.passed).length,
      totalFindings: results.reduce((sum, item) => sum + item.findings.length, 0),
      blockedRequests: results.reduce((sum, item) => sum + (item.evidence?.blockedRequests ?? 0), 0),
      visualComparisons: results.filter((item) => item.visualComparison?.status === "compared").length,
      baselineMissing: results.filter((item) => item.visualComparison?.status === "baseline-missing").length,
      visualFailures: results.filter((item) => item.visualComparison?.status === "compared" && !item.visualComparison.passed).length,
      baselinesUpdated: results.filter((item) => item.visualComparison?.status === "baseline-updated").length,
      interactionVisualComparisons: results.reduce((sum, item) =>
        sum + (item.evidence?.interactionExploration?.states ?? [])
          .filter((state) => state.visualComparison?.status === "compared").length, 0),
      interactionVisualFailures: results.reduce((sum, item) =>
        sum + (item.evidence?.interactionExploration?.states ?? [])
          .filter((state) => state.visualComparison?.status === "compared" && !state.visualComparison.passed).length, 0),
      interactionBaselinesMissing: results.reduce((sum, item) =>
        sum + (item.evidence?.interactionExploration?.states ?? [])
          .filter((state) => state.visualComparison?.status === "baseline-missing").length, 0),
      interactionBaselinesUpdated: results.reduce((sum, item) =>
        sum + (item.evidence?.interactionExploration?.states ?? [])
          .filter((state) => state.visualComparison?.status === "baseline-updated").length, 0)
    }),
    passed: results.every((item) => item.passed),
    themeComparisons: Object.freeze(themeTokenComparisons),
    viewports: Object.freeze(results)
  });
}

export { DEFAULT_VIEWPORTS, FULL_VIEWPORTS };
