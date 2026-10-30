import { getElements } from "../shared/context.js";

const IMPACT_TO_SEVERITY = Object.freeze({
  critical: "critical",
  serious: "high",
  moderate: "medium",
  minor: "low"
});

export const accessibilityRules = [
  {
    id: "accessibility.axe-core",
    specialist: "accessibility",
    evaluate(context) {
      return getElements(context, "axeViolations").map((violation) => {
        const ruleKey = String(violation.id ?? "unknown")
          .replace(/[^a-z0-9-]/gi, "-").toUpperCase();
        const nodes = getElements(violation, "nodes");
        return {
          id: "A11Y-AXE-" + ruleKey,
          title: String(violation.help ?? "Accessibility rule violation"),
          description: String(violation.description ?? "axe-core detected an accessibility violation."),
          severity: IMPACT_TO_SEVERITY[violation.impact] ?? "medium",
          location: nodes[0]?.target?.[0] ?? null,
          evidence: {
            ruleId: violation.id,
            impact: violation.impact,
            helpUrl: violation.helpUrl,
            affectedNodes: violation.nodes?.length ?? 0,
            nodes: nodes.slice(0, 8)
          },
          recommendation: String(violation.help ?? "Review the affected element.") +
            (violation.helpUrl ? " Reference: " + violation.helpUrl : "")
        };
      });
    }
  },
  {
    id: "accessibility.image-alt",
    specialist: "accessibility",
    evaluate(context) {
      return getElements(context, "images")
        .filter((image) => image.visible !== false && image.hasAlt !== true)
        .map((image, index) => ({
          id: "A11Y-001-" + (index + 1),
          title: "Image is missing alternative text",
          description: "An image has no alt attribute, so its content may not be available to assistive technology.",
          severity: "high",
          location: image.selector ?? null,
          evidence: { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight },
          recommendation: "Add concise alt text for meaningful images. Use alt=\"\" only for decorative images."
        }));
    }
  },
  {
    id: "accessibility.form-label",
    specialist: "accessibility",
    evaluate(context) {
      return getElements(context, "formControls")
        .filter((control) => ![control.labelsText, control.ariaLabel, control.ariaLabelledByText, control.title]
          .some((value) => String(value ?? "").trim()))
        .map((control, index) => ({
          id: "A11Y-002-" + (index + 1),
          title: "Form control has no programmatic label",
          description: "A visible form field has no associated label, aria-label, aria-labelledby, or title.",
          severity: "high",
          location: control.selector ?? null,
          evidence: { tagName: control.tagName, type: control.type },
          recommendation: "Associate a label element with the field or provide an accessible name."
        }));
    }
  },
  {
    id: "accessibility.document-language",
    specialist: "accessibility",
    evaluate(context) {
      if (String(context.documentLang ?? "").trim()) return [];
      return {
        id: "A11Y-003",
        title: "Document language is not declared",
        description: "The root HTML element does not declare a language.",
        severity: "medium",
        recommendation: "Set an appropriate lang attribute on the html element, such as lang=\"es\"."
      };
    }
  },
  {
    id: "accessibility.heading-order",
    specialist: "accessibility",
    evaluate(context) {
      const headings = getElements(context, "headings");
      const findings = [];
      let previous = 0;
      for (const heading of headings) {
        const level = Number(heading.level);
        if (!Number.isInteger(level) || level < 1 || level > 6) continue;
        if (previous && level > previous + 1) {
          findings.push({
            id: "A11Y-004-" + (findings.length + 1),
            title: "Heading hierarchy skips a level",
            description: "Heading level h" + level + " follows h" + previous + " without an intermediate level.",
            severity: "low",
            location: heading.selector ?? null,
            evidence: { previousLevel: previous, currentLevel: level },
            recommendation: "Use heading levels to represent document structure, not visual size."
          });
        }
        previous = level;
      }
      return findings;
    }
  }
];
