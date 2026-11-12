import { getElements } from "../shared/context.js";

export const themeContrastRules = [
  {
    id: "ui-ux.theme-contrast",
    specialist: "ui-ux",
    evaluate(context) {
      return getElements(context, "contrastAnalysis")
        .filter((sample) => sample.status === "measured" && sample.passed === false)
        .map((sample, index) => ({
          id: "UIUX-005-" + (index + 1),
          title: sample.kind === "text" || sample.kind === "placeholder"
            ? "Text contrast is below WCAG AA"
            : "Non-text UI contrast is below WCAG AA",
          description: sample.kind === "placeholder"
            ? "A placeholder has a contrast ratio of " + sample.contrastRatio +
              ":1; the required ratio is " + sample.requiredRatio + ":1."
            : sample.kind === "text"
              ? "Text has a contrast ratio of " + sample.contrastRatio +
                ":1; the required ratio is " + sample.requiredRatio + ":1."
              : "The " + sample.kind + " (" + (sample.componentPart ?? "component") +
                ") has a contrast ratio of " + sample.contrastRatio +
                ":1; the required ratio is " + sample.requiredRatio + ":1.",
          severity: sample.contrastRatio < 3 ? "high" : "medium",
          location: sample.selector,
          evidence: {
            contrastRatio: sample.contrastRatio,
            requiredRatio: sample.requiredRatio,
            fontSizePx: sample.fontSizePx,
            fontWeight: sample.fontWeight,
            kind: sample.kind,
            componentPart: sample.componentPart ?? null,
            standard: sample.kind === "text" || sample.kind === "placeholder"
              ? "WCAG 1.4.3"
              : "WCAG 1.4.11",
            theme: context.themeAudit?.requestedColorScheme ?? null,
            state: sample.state ?? "default",
            interactionState: sample.interactionState ?? null,
            triggerSelector: sample.triggerSelector ?? null
          },
          recommendation: sample.kind === "text" || sample.kind === "placeholder"
            ? "Adjust the text or effective background color to meet WCAG 2.2 AA (4.5:1 normal text, 3:1 large text). Verify both themes."
            : "Adjust the component boundary, fill, focus indicator, or icon color to achieve at least 3:1 against its adjacent background. Verify both themes."
        }));
    }
  },
  {
    id: "ui-ux.theme-transition-drift",
    specialist: "ui-ux",
    evaluate(context) {
      const audit = context.themeTransitionAudit;
      if (!audit?.enabled || audit.restoredStable !== false) return [];
      return [{
        id: "UIUX-007",
        title: "Visual theme did not fully restore after a light/dark transition",
        description: "The same page was switched from " +
          (audit.sequence?.[0] ?? "the initial theme") + " to " +
          (audit.sequence?.[1] ?? "the alternate theme") + " and back, but " +
          (audit.changedTokens?.length ?? 0) + " changed tokens, " +
          (audit.addedTokens?.length ?? 0) + " added tokens, " +
          (audit.removedTokens?.length ?? 0) + " missing tokens, and " +
          (audit.changedSamples?.length ?? 0) + " rendered text styles remained different.",
        severity: "medium",
        location: "html",
        evidence: {
          sequence: audit.sequence,
          changedTokens: audit.changedTokens,
          addedTokens: audit.addedTokens,
          removedTokens: audit.removedTokens,
          changedSamples: audit.changedSamples,
          rootColorSchemeChanged: audit.rootColorSchemeChanged,
          themeMarkerChanged: audit.themeMarkerChanged,
          addedSamplesAfterRestore: audit.addedSamplesAfterRestore,
          removedSamplesAfterRestore: audit.removedSamplesAfterRestore
        },
        recommendation: "Check theme toggle state, localStorage synchronization, stale component classes, inline styles, and event listeners. Confirm that the same page returns to its original appearance after switching themes twice."
      }];
    }
  }
];
