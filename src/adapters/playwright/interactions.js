import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { comparePngFiles } from "../visual/png-diff.js";
import { collectPageContext } from "./context.js";
import { applyThemeOverride, collectThemeContext } from "./theme-context.js";

const DEFAULT_MAX_ACTIONS = 8;
const DEFAULT_SETTLE_MS = 180;
const MAX_INTERACTION_CONTRAST_SAMPLES = 3000;

function validateOptions({ maxActions, settleMs }) {
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 30) {
    throw new TypeError("maxActions must be an integer between 1 and 30");
  }
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 2000) {
    throw new TypeError("settleMs must be an integer between 0 and 2000");
  }
}

async function discoverCandidates(page, maxActions) {
  return page.evaluate((limit) => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };

    const selectorFor = (element) => {
      if (element.id) return "#" + CSS.escape(element.id);
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
        let part = current.tagName.toLowerCase();
        if (current.parentElement) {
          const siblings = [...current.parentElement.children]
            .filter((sibling) => sibling.tagName === current.tagName);
          if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
        parts.unshift(part);
        if (current.parentElement?.id) {
          parts.unshift("#" + CSS.escape(current.parentElement.id));
          break;
        }
        current = current.parentElement;
      }
      return parts.join(" > ");
    };

    const dangerous = /\b(delete|remove|destroy|logout|log out|sign out|save|submit|purchase|buy|pay|checkout|send|confirm|eliminar|borrar|suprimir|guardar|enviar|comprar|pagar|salir|publicar|registrar|crear|agregar|añadir)\b|cerrar sesión/i;
    const intent = /menu|hamburger|burger|sidebar|side-nav|navigation|nav-toggle|drawer|dropdown|drop-down|accordion|expand|collapse|more|options|filter|sort|settings|setting|tab|dialog|modal|open|show|view more|categor|navegaci|menú|opciones|mostrar|expandir|contraer|filtro|ajustes|configuraci|más|ver más|theme|dark mode|light mode|appearance|color scheme|tema|modo oscuro|modo claro|apariencia|esquema de color/i;
    const themeIntent = /theme|dark mode|light mode|appearance|color scheme|tema|modo oscuro|modo claro|apariencia|esquema de color/i;
    const selector = [
      "button", "[role='button']", "[role='tab']", "summary",
      "[aria-expanded='false']", "[aria-haspopup]", "[aria-pressed]", "[popovertarget]",
      "[data-bs-toggle]", "[data-toggle]"
    ].join(",");

    const candidates = [];
    const seen = new Set();
    for (const element of document.querySelectorAll(selector)) {
      if (!isVisible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") continue;
      if (element.isContentEditable || element.tagName === "A") continue;
      const explicitButtonType = (element.getAttribute("type") || "").toLowerCase();
      if (element.tagName === "BUTTON" && explicitButtonType && explicitButtonType !== "button") continue;
      if (element.tagName === "BUTTON" && !explicitButtonType && element.closest("form")) continue;

      const role = element.getAttribute("role") || "";
      const expanded = element.getAttribute("aria-expanded");
      const isPressedToggle = element.hasAttribute("aria-pressed");
      const popup = element.getAttribute("aria-haspopup") || "";
      const dataToggle = element.getAttribute("data-bs-toggle") || element.getAttribute("data-toggle") || "";
      const isTab = role === "tab";
      const isSummary = element.tagName === "SUMMARY" && element.parentElement?.tagName === "DETAILS" &&
        !element.parentElement.open;
      const isCollapsed = expanded === "false";
      const isPopup = ["true", "menu", "dialog", "listbox", "tree", "grid"].includes(popup);
      const toggleKind = /^(collapse|dropdown|modal|offcanvas|popover)$/i.test(dataToggle);
      const controlIds = (element.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean);
      const targetSelectors = [
        element.getAttribute("data-bs-target"),
        element.getAttribute("data-target"),
        element.getAttribute("popovertarget") ? "#" + element.getAttribute("popovertarget") : null
      ].filter(Boolean);
      const targets = [
        ...controlIds.map((id) => document.getElementById(id)).filter(Boolean),
        ...targetSelectors.map((target) => {
          try { return document.querySelector(target); } catch { return null; }
        }).filter(Boolean)
      ];
      const hasHiddenTarget = targets.some((target) => {
        const style = getComputedStyle(target);
        return target.hidden || target.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || style.visibility === "hidden";
      });

      const ownDescription = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.innerText,
        element.textContent,
        element.id,
        element.className,
        element.getAttribute("data-testid"),
        element.getAttribute("data-action")
      ].filter((value) => typeof value === "string").join(" ").replace(/\s+/g, " ").trim().slice(0, 180);
      const description = [
        ownDescription,
        ...targets.map((target) => [target.id, target.className, target.getAttribute("role")].join(" "))
      ].filter(Boolean).join(" ").slice(0, 240);

      const semanticSignal = isTab || isSummary || isCollapsed || isPopup ||
        toggleKind || hasHiddenTarget || isPressedToggle;
      const isThemeToggle = themeIntent.test(ownDescription);
      const namedToggle = intent.test(description);
      if ((!semanticSignal && !namedToggle) || dangerous.test(description)) continue;

      const stableSelector = selectorFor(element);
      if (seen.has(stableSelector)) continue;
      seen.add(stableSelector);
      candidates.push({
        selector: stableSelector,
        label: (element.getAttribute("aria-label") || element.getAttribute("title") ||
          element.innerText || element.textContent || role || element.tagName.toLowerCase())
          .replace(/\s+/g, " ").trim().slice(0, 80) || "interactive toggle",
        kind: isThemeToggle ? "theme-toggle" : isTab ? "tab" : isSummary ? "disclosure" :
          isPopup ? "popup" : toggleKind ? dataToggle :
            hasHiddenTarget ? "controlled-region" : "toggle"
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }, maxActions);
}

function compareThemeSnapshots(before, after) {
  if (!before || !after) return null;
  const tokenMap = (snapshot) => new Map(
    (snapshot.themeAudit?.colorTokens ?? []).map((token) => [
      String(token.scope ?? "root") + ":" + token.name,
      token.value
    ])
  );
  const sampleMap = (snapshot) => new Map(
    (snapshot.contrastSamples ?? []).map((sample) => [
      String(sample.selector ?? "") + "|" + String(sample.kind ?? "text") + "|" +
        String(sample.componentPart ?? ""),
      JSON.stringify({
        foreground: sample.foreground,
        backgroundStatus: sample.backgroundStatus,
        backgroundReason: sample.backgroundReason,
        backgroundLayers: sample.backgroundLayers
      })
    ])
  );
  const beforeTokens = tokenMap(before);
  const afterTokens = tokenMap(after);
  const changedTokens = [...beforeTokens.keys()]
    .filter((name) => afterTokens.has(name) && beforeTokens.get(name) !== afterTokens.get(name))
    .map((name) => ({
      name: name.slice(name.indexOf(":") + 1),
      scope: name.split(":")[0],
      before: beforeTokens.get(name),
      after: afterTokens.get(name)
    }));
  const addedTokens = [...afterTokens.keys()].filter((name) => !beforeTokens.has(name));
  const removedTokens = [...beforeTokens.keys()].filter((name) => !afterTokens.has(name));
  const beforeSamples = sampleMap(before);
  const afterSamples = sampleMap(after);
  const sharedSamples = [...beforeSamples.keys()].filter((key) => afterSamples.has(key));
  const changedSampleKeys = sharedSamples
    .filter((key) => beforeSamples.get(key) !== afterSamples.get(key));
  const changedSamples = changedSampleKeys
    .slice(0, 50)
    .map((key) => ({
      selector: key.split("|")[0],
      kind: key.split("|")[1],
      componentPart: key.split("|")[2] || null
    }));
  const themeMarkerChanged =
    before.themeAudit?.themeMarker !== after.themeAudit?.themeMarker;
  const rootColorSchemeChanged =
    before.themeAudit?.rootColorScheme !== after.themeAudit?.rootColorScheme;
  const changed = themeMarkerChanged || rootColorSchemeChanged ||
    changedTokens.length > 0 || addedTokens.length > 0 ||
    removedTokens.length > 0 || changedSamples.length > 0;
  return Object.freeze({
    status: changed ? "changed" : "no-measurable-change",
    changed,
    beforeThemeMarker: before.themeAudit?.themeMarker ?? null,
    afterThemeMarker: after.themeAudit?.themeMarker ?? null,
    themeMarkerChanged,
    beforeColorScheme: before.themeAudit?.rootColorScheme ?? null,
    afterColorScheme: after.themeAudit?.rootColorScheme ?? null,
    rootColorSchemeChanged,
    changedTokens: Object.freeze(changedTokens),
    addedTokens: Object.freeze(addedTokens),
    removedTokens: Object.freeze(removedTokens),
    changedSamples: Object.freeze(changedSamples),
    changedSampleCount: changedSampleKeys.length,
    changedSamplesTruncated: changedSampleKeys.length > changedSamples.length
  });
}

async function captureForcedPseudoState(page, selector, pseudo, capture) {
  let session = null;
  let nodeId = null;
  try {
    session = await page.context().newCDPSession(page);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const document = await session.send("DOM.getDocument", { depth: 1 });
    const match = await session.send("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector
    });
    nodeId = match.nodeId;
    if (!nodeId) return false;
    await session.send("CSS.forcePseudoState", {
      nodeId,
      forcedPseudoClasses: [pseudo]
    });
    try {
      await capture();
    } finally {
      await session.send("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: []
      }).catch(() => {});
    }
    return true;
  } catch {
    return false;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

/**
 * Opens one safe, semantically identified control at a time and measures the resulting
 * visible state. Each candidate starts from a fresh load of the target URL, so tabs,
 * drawers and dialogs do not contaminate the next scenario.
 */
export async function exploreInteractionStates(page, {
  url = page.url(),
  thresholds = {},
  maxActions = DEFAULT_MAX_ACTIONS,
  settleMs = DEFAULT_SETTLE_MS,
  timeout = 10000,
  screenshotDir = null,
  baselineDir = null,
  diffDir = null,
  updateBaselines = false,
  visualThreshold = 0.1,
  maxDiffPixelRatio = 0.005,
  viewportName = "viewport",
  colorScheme = "light",
  themeAttribute = null
} = {}) {
  validateOptions({ maxActions, settleMs });
  if (baselineDir && !screenshotDir) throw new TypeError("screenshotDir is required for interaction baselines");
  if (diffDir && !baselineDir) throw new TypeError("baselineDir is required for interaction diffs");
  if (updateBaselines && !baselineDir) throw new TypeError("baselineDir is required when updating interaction baselines");
  if (typeof updateBaselines !== "boolean") throw new TypeError("updateBaselines must be a boolean");
  const originalOrigin = new URL(url).origin;
  const candidates = await discoverCandidates(page, maxActions);
  if (candidates.length > 0) {
    const storageOrigin = new URL(page.url()).origin;
    const initialStorage = await page.evaluate(() => {
      const entries = (storage) => {
        const result = {};
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key !== null) result[key] = storage.getItem(key);
        }
        return result;
      };
      try {
        return {
          localStorage: entries(window.localStorage),
          sessionStorage: entries(window.sessionStorage)
        };
      } catch {
        return null;
      }
    }).catch(() => null);
    if (initialStorage) {
      await page.addInitScript(({ origin, snapshot }) => {
        if (window.location.origin !== origin) return;
        try {
          window.localStorage.clear();
          for (const [key, value] of Object.entries(snapshot.localStorage ?? {})) {
            window.localStorage.setItem(key, value);
          }
          window.sessionStorage.clear();
          for (const [key, value] of Object.entries(snapshot.sessionStorage ?? {})) {
            window.sessionStorage.setItem(key, value);
          }
        } catch {}
      }, { origin: storageOrigin, snapshot: initialStorage });
    }
  }
  const states = [];
  const interactiveElements = [];
  const interactiveOverlaps = [];
  const contrastSamples = [];
  let contrastSamplesTruncated = false;
  const appendContrastSamples = (samples, metadata) => {
    const remaining = MAX_INTERACTION_CONTRAST_SAMPLES - contrastSamples.length;
    if (remaining <= 0) {
      if (samples.length) contrastSamplesTruncated = true;
      return;
    }
    if (samples.length > remaining) contrastSamplesTruncated = true;
    contrastSamples.push(...samples.slice(0, remaining).map((sample) => ({
      ...sample,
      ...metadata
    })));
  };
  const skipped = [];
  let actionsAttempted = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 2000) }).catch(() => {});
      await applyThemeOverride(page, { theme: colorScheme, attribute: themeAttribute });
      const control = page.locator(candidate.selector).first();
      if (!await control.isVisible({ timeout: 1000 }).catch(() => false) ||
          !await control.isEnabled().catch(() => false)) {
        skipped.push({ selector: candidate.selector, reason: "Control was not visible or enabled after reload" });
        continue;
      }

      const captureContrastState = async (state) => {
        const snapshot = await collectThemeContext(page);
        appendContrastSamples(snapshot.contrastSamples ?? [], {
          interactionState: state,
          triggerSelector: candidate.selector
        });
      };

      try {
        await control.hover({ timeout: 1500 });
        if (settleMs) await page.waitForTimeout(settleMs);
        await captureContrastState("hover");
        await page.mouse.move(0, 0).catch(() => {});
      } catch {}
      try {
        await control.focus({ timeout: 1500 });
        if (settleMs) await page.waitForTimeout(settleMs);
        await captureContrastState("focus");
      } catch {}
      await control.evaluate((element) => element.blur()).catch(() => {});
      await captureForcedPseudoState(page, candidate.selector, "active", async () => {
        if (settleMs) await page.waitForTimeout(settleMs);
        await captureContrastState("active");
      });

      const beforeToggleTheme = candidate.kind === "theme-toggle"
        ? await collectThemeContext(page)
        : null;
      actionsAttempted += 1;
      await control.click({ timeout: 2500, noWaitAfter: true });
      if (settleMs) await page.waitForTimeout(settleMs);

      const currentUrl = new URL(page.url());
      if (currentUrl.origin !== originalOrigin || currentUrl.pathname !== new URL(url).pathname) {
        skipped.push({ selector: candidate.selector, reason: "Control navigated away from the audited page" });
        continue;
      }

      const stateName = "interaction-" + (index + 1) + ": " + candidate.kind + " — " + candidate.label;
      const snapshot = await collectPageContext(page, { thresholds });
      const themeSnapshot = await collectThemeContext(page);
      const themeToggleEffect = candidate.kind === "theme-toggle"
        ? compareThemeSnapshots(beforeToggleTheme, themeSnapshot)
        : null;
      appendContrastSamples(themeSnapshot.contrastSamples ?? [], {
        interactionState: stateName,
        triggerSelector: candidate.selector
      });
      const stateElements = (snapshot.interactiveElements ?? []).map((item) => ({
        ...item,
        state: stateName,
        triggerSelector: candidate.selector
      }));
      let stateScreenshotPath = null;
      let visualComparison = null;
      if (screenshotDir) {
        const safePart = (value) => String(value).toLowerCase()
          .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "state";
        const fileName = String(index + 1).padStart(2, "0") + "-" +
          safePart(candidate.kind) + "-" + safePart(candidate.label) + ".png";
        stateScreenshotPath = join(screenshotDir, safePart(viewportName), fileName);
        await mkdir(join(screenshotDir, safePart(viewportName)), { recursive: true });
        await page.screenshot({
          path: stateScreenshotPath,
          fullPage: false,
          animations: "disabled"
        });

        if (baselineDir) {
          const relativePath = join(safePart(viewportName), fileName);
          const baselinePath = join(baselineDir, relativePath);
          if (updateBaselines) {
            await mkdir(join(baselineDir, safePart(viewportName)), { recursive: true });
            await writeFile(baselinePath, await readFile(stateScreenshotPath));
            visualComparison = {
              status: "baseline-updated",
              passed: false,
              baselinePath,
              actualPath: stateScreenshotPath,
              diffPath: null
            };
          } else {
            let baselineExists = true;
            try { await access(baselinePath); } catch { baselineExists = false; }
            if (!baselineExists) {
              visualComparison = {
                status: "baseline-missing",
                passed: false,
                baselinePath,
                actualPath: stateScreenshotPath,
                diffPath: null
              };
            } else {
              const diffPath = diffDir ? join(diffDir, relativePath) : null;
              visualComparison = await comparePngFiles({
                baselinePath,
                actualPath: stateScreenshotPath,
                diffPath,
                threshold: visualThreshold,
                maxDiffPixelRatio
              });
            }
          }
        }
      }

      const stateOverlaps = (snapshot.interactiveOverlaps ?? []).map((item) => ({
        ...item,
        state: stateName,
        triggerSelector: candidate.selector,
        screenshotPath: stateScreenshotPath
      }));

      interactiveElements.push(...stateElements.map((item) => ({
        ...item,
        screenshotPath: stateScreenshotPath
      })));
      interactiveOverlaps.push(...stateOverlaps);
      states.push({
        name: stateName,
        triggerSelector: candidate.selector,
        kind: candidate.kind,
        visibleControls: stateElements.length,
        overlapCount: stateOverlaps.length,
        themeMarker: themeSnapshot.themeAudit?.themeMarker ?? null,
        rootColorScheme: themeSnapshot.themeAudit?.rootColorScheme ?? null,
        colorTokens: themeSnapshot.themeAudit?.colorTokens ?? [],
        themeToggleEffect,
        screenshotPath: stateScreenshotPath,
        visualComparison
      });
    } catch (error) {
      skipped.push({
        selector: candidate.selector,
        reason: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
      });
    }
  }

  // Restore the initial page state so the ordinary axe scan and screenshot represent
  // the default landing state rather than the last explored menu or dialog.
  if (candidates.length > 0) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 2000) }).catch(() => {});
    await applyThemeOverride(page, { theme: colorScheme, attribute: themeAttribute });
  }

  return Object.freeze({
    enabled: true,
    candidatesDiscovered: candidates.length,
    actionsAttempted,
    statesCaptured: states.length,
    overlapsFound: interactiveOverlaps.length,
    states: Object.freeze(states),
    skipped: Object.freeze(skipped),
    interactiveElements: Object.freeze(interactiveElements),
    interactiveOverlaps: Object.freeze(interactiveOverlaps),
    contrastSamples: Object.freeze(contrastSamples),
    contrastSamplesTruncated
  });
}
