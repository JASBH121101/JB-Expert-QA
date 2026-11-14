import test from "node:test";
import assert from "node:assert/strict";
import { layoutIntegrityRules } from "../src/specialists/ui-ux/layout-integrity.js";

const evaluate = (id, context) => {
  const rule = layoutIntegrityRules.find((item) => item.id === id);
  assert.ok(rule, "expected rule to exist: " + id);
  return rule.evaluate(context);
};

test("flags a primary desktop content container constrained to a narrow max width", () => {
  const findings = evaluate("ui-ux.constrained-primary-container", {
    viewport: { width: 1600, height: 900 },
    layoutIntegrity: {
      containerMetrics: [{
        selector: "main.page-content",
        tagName: "main",
        className: "page-content",
        widthPx: 820,
        parentContentWidthPx: 1480,
        widthToParentRatio: 0.554,
        maxWidth: "820px"
      }]
    }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "low");
  assert.equal(findings[0].evidence.widthPx, 820);
});

test("does not flag intentional narrow content on mobile or ordinary cards", () => {
  const metrics = [{
    selector: "main.page-content",
    tagName: "main",
    className: "page-content",
    widthPx: 820,
    parentContentWidthPx: 1480,
    widthToParentRatio: 0.554,
    maxWidth: "820px"
  }, {
    selector: "section.product-card",
    tagName: "section",
    className: "product-card",
    widthPx: 360,
    parentContentWidthPx: 1480,
    widthToParentRatio: 0.243,
    maxWidth: "360px"
  }];
  assert.equal(evaluate("ui-ux.constrained-primary-container", {
    viewport: { width: 390, height: 844 },
    layoutIntegrity: { containerMetrics: metrics }
  }).length, 0);
  assert.equal(evaluate("ui-ux.constrained-primary-container", {
    viewport: { width: 1600, height: 900 },
    layoutIntegrity: { containerMetrics: metrics.slice(1) }
  }).length, 0);
});

test("reports when language detection is skipped because html lang is missing", () => {
  const findings = evaluate("ui-ux.missing-document-language", {
    localizationAudit: { status: "skipped", languageSource: "undetermined" }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "low");
});

test("does not report a missing language when a target language was detected", () => {
  assert.equal(evaluate("ui-ux.missing-document-language", {
    localizationAudit: { status: "checked", languageSource: "option", language: "es" }
  }).length, 0);
});
