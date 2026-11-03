import { getElements, getElementLabel, isVisible } from "../shared/context.js";

export const uiUxRules = [
  {
    id: "ui-ux.tiny-text",
    specialist: "ui-ux",
    evaluate(context) {
      const minimum = Number(context.thresholds?.minimumBodyFontPx ?? 12);
      return getElements(context, "textElements")
        .filter((element) => isVisible(element) && Number.isFinite(Number(element.fontSize)) && Number(element.fontSize) < minimum)
        .map((element, index) => ({
          id: `UIUX-001-${index + 1}`,
          title: "Text is below configured minimum size",
          description: `${getElementLabel(element)} uses ${Number(element.fontSize)}px text; configured minimum is ${minimum}px.`,
          severity: Number(element.fontSize) < 10 ? "high" : "medium",
          location: element.selector ?? null,
          evidence: { fontSizePx: Number(element.fontSize), minimumFontSizePx: minimum },
          recommendation: "Increase the text size or verify that the text is intentionally secondary and remains legible."
        }));
    }
  },
  {
    id: "ui-ux.oversized-empty-space",
    specialist: "ui-ux",
    evaluate(context) {
      const threshold = Number(context.thresholds?.largeEmptySpacePx ?? 160);
      return getElements(context, "verticalGaps")
        .filter((gap) => isVisible(gap) && Number(gap.height) >= threshold && gap.containsContent !== true)
        .map((gap, index) => ({
          id: `UIUX-002-${index + 1}`,
          title: "Large unexplained vertical gap",
          description: `A vertical gap of ${Number(gap.height)}px was measured without detected content.`,
          severity: Number(gap.height) >= threshold * 2 ? "high" : "medium",
          location: gap.selector ?? null,
          evidence: { heightPx: Number(gap.height), thresholdPx: threshold },
          recommendation: "Check margins, padding, min-height, empty containers, and reserved media areas. Confirm the gap is not intentional before changing it."
        }));
    }
  },
  {
    id: "ui-ux.small-interactive-target",
    specialist: "ui-ux",
    evaluate(context) {
      const minimum = Number(context.thresholds?.minimumTargetSizePx ?? 24);
      return getElements(context, "interactiveElements")
        .filter((element) => isVisible(element) &&
          Number.isFinite(Number(element.width)) && Number.isFinite(Number(element.height)) &&
          (Number(element.width) < minimum || Number(element.height) < minimum))
        .map((element, index) => ({
          id: `UIUX-003-${index + 1}`,
          title: "Interactive target is unusually small",
          description: `${getElementLabel(element)} measures ${Number(element.width)}×${Number(element.height)}px in ${element.state ?? "the initial page state"}.`,
          severity: "medium",
          location: element.selector ?? null,
          evidence: { widthPx: Number(element.width), heightPx: Number(element.height), configuredMinimumPx: minimum, state: element.state ?? "initial", triggerSelector: element.triggerSelector ?? null, screenshotPath: element.screenshotPath ?? null },
          recommendation: "Increase the clickable or touch area, or provide sufficient spacing around the control."
        }));
    }
  },
  {
    id: "ui-ux.interactive-overlap",
    specialist: "ui-ux",
    evaluate(context) {
      return getElements(context, "interactiveOverlaps")
        .filter((overlap) =>
          Number.isFinite(Number(overlap.overlapPercentOfSmallerTarget)) &&
          Number(overlap.overlapPercentOfSmallerTarget) >= 8
        )
        .map((overlap, index) => {
          const overlapPercent = Number(overlap.overlapPercentOfSmallerTarget);
          const blockedRatio = Number(overlap.blockedSampleRatio ?? 0);
          const blocked = Boolean(overlap.blockedSelector);
          const severity = blocked && blockedRatio >= 0.6 && overlapPercent >= 25
            ? "high"
            : blocked || overlapPercent >= 25
              ? "medium"
              : "low";
          const location = [overlap.selectorA, overlap.selectorB].filter(Boolean).join(" ↔ ") || null;
          const obstruction = blocked
            ? (overlap.blockingSelector
                ? overlap.blockingSelector + " covers " + overlap.blockedSelector
                : overlap.blockedSelector + " is obscured")
            : "Neither target consistently blocked the other's hit test";

          return {
            id: "UIUX-004-" + (index + 1),
            title: blocked
              ? "Interactive control is obscured by an overlapping element"
              : "Interactive controls overlap",
            description: (overlap.selectorA || "Control A") + " and " +
              (overlap.selectorB || "Control B") + " intersect by " + overlapPercent +
              "% of the smaller target in " + (overlap.state ?? "the initial page state") + ". " + obstruction + ".",
            severity,
            location,
            evidence: {
              selectorA: overlap.selectorA ?? null,
              selectorB: overlap.selectorB ?? null,
              overlapAreaPx2: Number(overlap.overlapAreaPx2 ?? 0),
              overlapPercentOfSmallerTarget: overlapPercent,
              blockedSelector: overlap.blockedSelector ?? null,
              blockingSelector: overlap.blockingSelector ?? null,
              blockedSampleRatio: blockedRatio,
              sampleCount: Number(overlap.sampleCount ?? 0),
              positionA: overlap.positionA ?? null,
              positionB: overlap.positionB ?? null,
              zIndexA: overlap.zIndexA ?? null,
              zIndexB: overlap.zIndexB ?? null,
              state: overlap.state ?? "initial",
              triggerSelector: overlap.triggerSelector ?? null,
              screenshotPath: overlap.screenshotPath ?? null
            },
            recommendation: "Separate the controls at this viewport or correct their positioning and stacking order. Check the page in the affected viewport and confirm that every visible control has an unobstructed, independent hit target. Intentional menus and dialogs should not leave background controls interactable."
          };
        });
    }
  }
];
