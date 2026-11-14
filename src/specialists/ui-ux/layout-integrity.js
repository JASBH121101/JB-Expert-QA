export const layoutIntegrityRules = [
  {
    id: "ui-ux.clipped-text",
    specialist: "ui-ux",
    evaluate(context) {
      return (context.layoutIntegrity?.clippedText ?? []).map((item, index) => ({
        id: "UIUX-008-" + (index + 1),
        title: item.control ? "Interactive control text is clipped" : "Visible text is clipped",
        description: (item.selector ?? "Element") + " clips its own content: " +
          (item.clippedHorizontally ? "horizontal overflow" : "") +
          (item.clippedHorizontally && item.clippedVertically ? " and " : "") +
          (item.clippedVertically ? "vertical overflow" : "") + ".",
        severity: item.control ? "high" : "medium",
        location: item.selector ?? null,
        evidence: {
          kind: "self-clipped-content",
          tagName: item.tagName,
          text: item.text,
          widthPx: item.widthPx,
          heightPx: item.heightPx,
          clientWidthPx: item.clientWidthPx,
          scrollWidthPx: item.scrollWidthPx,
          clientHeightPx: item.clientHeightPx,
          scrollHeightPx: item.scrollHeightPx,
          overflowX: item.overflowX,
          overflowY: item.overflowY,
          textOverflow: item.textOverflow,
          lineClamp: item.lineClamp
        },
        recommendation: item.control
          ? "Increase the control width or allow its label to wrap. Check padding, min-width, flex-shrink, white-space and overflow rules at this viewport."
          : "Review fixed heights, max-height, overflow, line clamping and responsive text wrapping. Do not hide important content unintentionally."
      }));
    }
  },
  {
    id: "ui-ux.ancestor-clipping",
    specialist: "ui-ux",
    evaluate(context) {
      return (context.layoutIntegrity?.clippedByAncestor ?? []).map((item, index) => ({
        id: "UIUX-009-" + (index + 1),
        title: item.control ? "Interactive element is cut off by its container" : "Element is cut off by its container",
        description: item.selector + " extends beyond " + item.ancestorSelector +
          " and is clipped on the " + item.clippedEdges.join(", ") + " edge(s).",
        severity: item.control ? "high" : "medium",
        location: item.selector,
        evidence: {
          kind: "ancestor-clipping",
          ancestorSelector: item.ancestorSelector,
          tagName: item.tagName,
          text: item.text,
          clippedEdges: item.clippedEdges,
          elementRect: item.elementRect,
          ancestorRect: item.ancestorRect,
          ancestorOverflowX: item.ancestorOverflowX,
          ancestorOverflowY: item.ancestorOverflowY
        },
        recommendation: "Check the parent container's width/height, overflow, grid/flex constraints and responsive breakpoint. Ensure controls and important text remain fully visible."
      }));
    }
  },
  {
    id: "ui-ux.localization-opposite-language",
    specialist: "ui-ux",
    evaluate(context) {
      const audit = context.localizationAudit;
      if (!audit || audit.status !== "checked") return [];
      return (audit.findings ?? []).map((item, index) => ({
        id: "UIUX-010-" + (index + 1),
        title: "UI text appears to be in the wrong language",
        description: item.selector + " contains text detected as " +
          item.detectedLanguage.toUpperCase() + " while the requested interface language is " +
          item.expectedLanguage.toUpperCase() + ". Matched phrase: \"" + item.marker + "\".",
        severity: item.control ? "high" : "medium",
        location: item.selector,
        evidence: {
          kind: "localization",
          expectedLanguage: item.expectedLanguage,
          detectedLanguage: item.detectedLanguage,
          marker: item.marker,
          text: item.text,
          attribute: item.attribute,
          languageSource: audit.languageSource,
          preservedTerms: audit.preservedTerms
        },
        recommendation: "Translate the user-facing text naturally for the selected language, or add a deliberate technical loanword to the project's preserveTerms glossary. Avoid literal translations that sound unnatural."
      }));
    }
  }
  ,
  {
    id: "ui-ux.constrained-primary-container",
    specialist: "ui-ux",
    evaluate(context) {
      const viewportWidth = Number(context.viewport?.width ?? 0);
      if (viewportWidth < 1280) return [];
      const ratioLimit = Number(context.thresholds?.narrowContainerRatio ?? 0.72);
      const widthLimit = Number(context.thresholds?.narrowContainerMaxWidthPx ?? 960);
      return (context.layoutIntegrity?.containerMetrics ?? [])
        .filter((item) => {
          const semantic = item.tagName === "main" ||
            /page-content|content-wrapper|content-area|catalog-grid|dashboard-content/i.test(
              String(item.className ?? "") + " " + String(item.selector ?? "")
            );
          const maxWidth = Number.parseFloat(item.maxWidth);
          return semantic && Number(item.parentContentWidthPx) >= 1200 &&
            Number(item.widthPx) <= widthLimit &&
            Number(item.widthToParentRatio) > 0 &&
            Number(item.widthToParentRatio) <= ratioLimit &&
            Number.isFinite(maxWidth) && maxWidth <= widthLimit;
        })
        .map((item, index) => ({
          id: "UIUX-012-" + (index + 1),
          title: "Primary content container may be unnecessarily constrained",
          description: item.selector + " uses " + Number(item.widthPx) +
            "px inside a " + Number(item.parentContentWidthPx) +
            "px parent at a " + viewportWidth + "px viewport.",
          severity: "low",
          location: item.selector,
          evidence: {
            widthPx: item.widthPx,
            parentContentWidthPx: item.parentContentWidthPx,
            widthToParentRatio: item.widthToParentRatio,
            maxWidth: item.maxWidth,
            viewportWidthPx: viewportWidth,
            className: item.className
          },
          recommendation: "Review the max-width and width rules at this desktop breakpoint. Compare equivalent sections across pages and remove accidental fixed limits, while preserving intentional readable content widths."
        }));
    }
  },
  {
    id: "ui-ux.missing-document-language",
    specialist: "ui-ux",
    evaluate(context) {
      const audit = context.localizationAudit;
      if (!audit || audit.status !== "skipped" || audit.languageSource !== "undetermined") return [];
      return [{
        id: "UIUX-011",
        title: "Document language is not declared",
        description: "JB Expert QA could not determine whether the page is Spanish or English, so the localization completeness check was skipped.",
        severity: "low",
        location: "html",
        evidence: { localizationStatus: audit.status, languageSource: audit.languageSource },
        recommendation: "Set the correct lang attribute on the html element (for example, lang=\"es\" or lang=\"en\") or pass --language=es|en when auditing a specific localized version."
      }];
    }
  }

];