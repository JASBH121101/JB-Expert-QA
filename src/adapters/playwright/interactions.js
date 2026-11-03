import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { collectPageContext } from "./context.js";

const DEFAULT_MAX_ACTIONS = 8;
const DEFAULT_SETTLE_MS = 180;

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

    const dangerous = /\\b(delete|remove|destroy|logout|log out|sign out|save|submit|purchase|buy|pay|checkout|send|confirm|eliminar|borrar|suprimir|guardar|enviar|comprar|pagar|salir|publicar|registrar|crear|agregar|añadir)\\b|cerrar sesión/i;
    const intent = /menu|hamburger|burger|sidebar|side-nav|navigation|nav-toggle|drawer|dropdown|drop-down|accordion|expand|collapse|more|options|filter|sort|settings|setting|tab|dialog|modal|open|show|view more|categor|navegaci|menú|opciones|mostrar|expandir|contraer|filtro|ajustes|configuraci|más|ver más/i;
    const selector = [
      "button", "[role='button']", "[role='tab']", "summary",
      "[aria-expanded='false']", "[aria-haspopup]", "[popovertarget]",
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
      const popup = element.getAttribute("aria-haspopup") || "";
      const dataToggle = element.getAttribute("data-bs-toggle") || element.getAttribute("data-toggle") || "";
      const isTab = role === "tab";
      const isSummary = element.tagName === "SUMMARY" && element.parentElement?.tagName === "DETAILS" &&
        !element.parentElement.open;
      const isCollapsed = expanded === "false";
      const isPopup = ["true", "menu", "dialog", "listbox", "tree", "grid"].includes(popup);
      const toggleKind = /^(collapse|dropdown|modal|offcanvas|popover)$/i.test(dataToggle);
      const controlIds = (element.getAttribute("aria-controls") || "").split(/\\s+/).filter(Boolean);
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

      const description = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.innerText,
        element.textContent,
        element.id,
        element.className,
        element.getAttribute("data-testid"),
        element.getAttribute("data-action"),
        ...targets.map((target) => [target.id, target.className, target.getAttribute("role")].join(" "))
      ].filter((value) => typeof value === "string").join(" ").replace(/\\s+/g, " ").trim().slice(0, 180);

      const semanticSignal = isTab || isSummary || isCollapsed || isPopup || toggleKind || hasHiddenTarget;
      const namedToggle = intent.test(description);
      if ((!semanticSignal && !namedToggle) || dangerous.test(description)) continue;

      const stableSelector = selectorFor(element);
      if (seen.has(stableSelector)) continue;
      seen.add(stableSelector);
      candidates.push({
        selector: stableSelector,
        label: (element.getAttribute("aria-label") || element.getAttribute("title") ||
          element.innerText || element.textContent || role || element.tagName.toLowerCase())
          .replace(/\\s+/g, " ").trim().slice(0, 80) || "interactive toggle",
        kind: isTab ? "tab" : isSummary ? "disclosure" : isPopup ? "popup" :
          toggleKind ? dataToggle : hasHiddenTarget ? "controlled-region" : "toggle"
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }, maxActions);
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
  viewportName = "viewport"
} = {}) {
  validateOptions({ maxActions, settleMs });
  const originalOrigin = new URL(url).origin;
  const candidates = await discoverCandidates(page, maxActions);
  const states = [];
  const interactiveElements = [];
  const interactiveOverlaps = [];
  const skipped = [];
  let actionsAttempted = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 2000) }).catch(() => {});
      const control = page.locator(candidate.selector).first();
      if (!await control.isVisible({ timeout: 1000 }).catch(() => false) ||
          !await control.isEnabled().catch(() => false)) {
        skipped.push({ selector: candidate.selector, reason: "Control was not visible or enabled after reload" });
        continue;
      }

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
      const stateElements = (snapshot.interactiveElements ?? []).map((item) => ({
        ...item,
        state: stateName,
        triggerSelector: candidate.selector
      }));
      let stateScreenshotPath = null;
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
        screenshotPath: stateScreenshotPath
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
    interactiveOverlaps: Object.freeze(interactiveOverlaps)
  });
}
