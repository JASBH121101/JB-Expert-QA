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
          description: `${getElementLabel(element)} measures ${Number(element.width)}×${Number(element.height)}px.`,
          severity: "medium",
          location: element.selector ?? null,
          evidence: { widthPx: Number(element.width), heightPx: Number(element.height), configuredMinimumPx: minimum },
          recommendation: "Increase the clickable or touch area, or provide sufficient spacing around the control."
        }));
    }
  }
];
