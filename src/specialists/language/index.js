function severityFor(id, fallback = "medium") {
  if (id === "missing-key" || id === "placeholder-mismatch" || id === "resource-parse-error" || id === "missing-locale-file") return "high";
  if (id === "empty-value") return "medium";
  if (id === "glossary-review" || id === "obsolete-key" || id === "target-file-without-source") return "low";
  return fallback;
}

export const languageRules = Object.freeze([
  {
    id: "language.translation-resource-integrity",
    specialist: "language",
    evaluate(context) {
      const audit = context.languageAudit;
      if (!audit || audit.status !== "checked") return [];
      return (audit.findings ?? []).map((item, index) => ({
        id: "LANG-" + String(item.id ?? "finding").toUpperCase() + "-" + (index + 1),
        title: titleFor(item.id),
        description: describe(item),
        severity: severityFor(item.id, item.severity),
        location: item.path ? item.path + (item.key ? ":" + item.key : "") : null,
        evidence: {
          localeSource: audit.sourceLocale,
          localeTarget: audit.targetLocale,
          finding: item
        },
        recommendation: recommendationFor(item.id)
      }));
    }
  }
]);

function titleFor(id) {
  return ({
    "missing-key": "Translation key is missing",
    "empty-value": "Translation value is empty",
    "placeholder-mismatch": "Translation placeholders do not match",
    "obsolete-key": "Target locale contains an obsolete key",
    "glossary-review": "Glossary terminology requires review",
    "unchanged-source-text": "Source text may be untranslated",
    "protected-url-mismatch": "Translation link differs from source",
    "protected-email-mismatch": "Translation email differs from source",
    "protected-markup-mismatch": "Translation markup structure differs",
    "protected-number-mismatch": "Translation numeric literal differs",
    "missing-locale-file": "Translation resource is missing",
    "target-file-without-source": "Target resource has no source file",
    "resource-parse-error": "Translation resource could not be parsed safely"
  })[id] ?? "Language QA finding";
}

function describe(item) {
  if (item.message) return item.message;
  if (item.id === "placeholder-mismatch") {
    return "Placeholders in the source and target strings differ for key " + item.key + ".";
  }
  return (item.key ? "Key " + item.key + ": " : "") + (item.message ?? item.id);
}

function recommendationFor(id) {
  if (id === "missing-key") return "Add a human-reviewed translation for this key; do not copy the source text as an automatic approval.";
  if (id === "empty-value") return "Provide a non-empty translation and send it through human review.";
  if (id === "placeholder-mismatch") return "Preserve every named or positional placeholder exactly so runtime substitutions remain valid.";
  if (id === "obsolete-key") return "Confirm whether the target key should be removed or the source key restored.";
  if (id === "glossary-review") return "Check the approved glossary and local context; this is a low-confidence advisory, not an automatic translation error.";
  if (id === "resource-parse-error") return "Use a static literal translation array or JSON object. The parser deliberately refuses executable PHP.";
  if (id === "unchanged-source-text") return "Confirm whether the source text is intentionally shared across locales or needs a reviewed translation.";
  if (id === "protected-url-mismatch" || id === "protected-email-mismatch") return "Verify the link or email destination before approving the localized message.";
  if (id === "protected-markup-mismatch") return "Restore equivalent HTML structure and validate nesting before approval.";
  if (id === "protected-number-mismatch") return "Check the numeric value and use locale-aware formatting where appropriate.";
  return "Review the locale resource pair and confirm that public-facing text is complete and appropriate.";
}
