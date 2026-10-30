import { getElements, getElementLabel, getViewport, isVisible } from "../shared/context.js";

export const responsiveRules = [
  {
    id: "responsive.horizontal-overflow",
    specialist: "responsive",
    evaluate(context) {
      const { width } = getViewport(context);
      const scrollWidth = Number(context.documentScrollWidth);
      if (!width || !Number.isFinite(scrollWidth) || scrollWidth <= width + 1) return [];
      return {
        id: "RESP-001",
        title: "Horizontal page overflow",
        description: `Document width (${scrollWidth}px) exceeds viewport width (${width}px).`,
        severity: "high",
        evidence: { viewportWidth: width, documentScrollWidth: scrollWidth, overflowPx: scrollWidth - width },
        recommendation: "Inspect fixed widths, wide tables, long unbroken text, and overflowing positioned elements."
      };
    }
  },
  {
    id: "responsive.element-overflow",
    specialist: "responsive",
    evaluate(context) {
      const { width } = getViewport(context);
      if (!width) return [];
      return getElements(context, "elements")
        .filter((element) => isVisible(element) && Number.isFinite(Number(element.right)) && Number(element.right) > width + 1)
        .map((element, index) => ({
          id: `RESP-002-${index + 1}`,
          title: "Visible element exceeds viewport",
          description: `${getElementLabel(element)} extends beyond the right edge of the viewport.`,
          severity: "medium",
          location: element.selector ?? null,
          evidence: { right: Number(element.right), viewportWidth: width },
          recommendation: "Review the element width, parent constraints, and responsive CSS at this viewport."
        }));
    }
  },
  {
    id: "responsive.fixed-width-on-small-screen",
    specialist: "responsive",
    evaluate(context) {
      const { width } = getViewport(context);
      if (!width || width > 480) return [];
      return getElements(context, "elements")
        .filter((element) => isVisible(element) && element.fixedWidth === true && Number(element.width) > width)
        .map((element, index) => ({
          id: `RESP-003-${index + 1}`,
          title: "Fixed-width element is wider than mobile viewport",
          description: `${getElementLabel(element)} has a fixed width larger than the available viewport.`,
          severity: "high",
          location: element.selector ?? null,
          evidence: { elementWidth: Number(element.width), viewportWidth: width },
          recommendation: "Use a fluid width or a responsive max-width constraint instead of a fixed width."
        }));
    }
  }
];
