import test from "node:test";
import assert from "node:assert/strict";
import { formatReport, formatMarkdownReport, formatHtmlReport } from "../src/reporters/index.js";

const report = {
  engine: "JB Expert QA",
  generatedAt: "2026-10-30T19:00:00.000Z",
  target: { url: "https://example.com" },
  summary: { rulesExecuted: 2, rulesWithErrors: 0, findings: 1 },
  scoring: { score: 88, passed: true },
  diagnostics: [{
    id: "UIUX-001-1",
    specialist: "ui-ux",
    severity: "medium",
    title: "Small <label> | *bold*",
    description: "Text is too small",
    location: ".caption",
    recommendation: "Increase size & review contrast"
  }],
  execution: [{ ruleId: "ui-ux.tiny-text", status: "passed" }]
};

test("markdown reporter includes findings and neutralizes Markdown/HTML controls", () => {
  const output = formatMarkdownReport(report);
  assert.match(output, /JB Expert QA report/);
  assert.ok(output.includes("Small &lt;label&gt; \\| \\*bold\\*"));
  assert.match(output, /Increase size &amp; review contrast/);
});

test("html reporter escapes untrusted report strings", () => {
  const output = formatHtmlReport(report);
  assert.match(output, /Small &lt;label&gt;/);
  assert.match(output, /Increase size &amp; review contrast/);
  assert.equal(output.includes("<label>"), false);
});

test("report format dispatcher supports JSON and rejects unknown formats", () => {
  assert.match(formatReport(report, "json"), /"score": 88/);
  assert.throws(() => formatReport(report, "pdf"), /Unsupported report format/);
});


test("reporters include visual regression and escaped AI observations", () => {
  const visualReport = {
    ...report,
    passed: false,
    summary: { viewportsChecked: 1, passedViewports: 0, failedViewports: 1, totalFindings: 0 },
    viewports: [{
      name: "desktop",
      findings: [],
      execution: [],
      screenshotPath: "artifacts/screenshots/desktop.png",
      visualComparison: {
        status: "compared",
        passed: false,
        diffPixelRatio: 0.125
      }
    }],
    aiVisualReview: {
      provider: "google-gemini",
      model: "gemini-test-model",
      status: "completed",
      reviews: [{
        viewport: "desktop",
        status: "reviewed",
        review: {
          visualScore: 81,
          assessment: "A <strong>misaligned</strong> header.",
          issues: [{
            severity: "low",
            region: "header",
            evidence: "<script>alert(1)</script>",
            recommendation: "Align the header."
          }]
        }
      }]
    }
  };
  const markdown = formatMarkdownReport(visualReport);
  const html = formatHtmlReport(visualReport);
  assert.match(markdown, /Visual regression/);
  assert.ok(markdown.includes("12\\.500%"));
  assert.match(markdown, /AI-assisted visual review/);
  assert.ok(markdown.includes("&lt;script&gt;"));
  assert.match(html, /Visual regression/);
  assert.match(html, /AI-assisted visual review/);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(html.includes("<script>alert(1)</script>"), false);
});


test("reporters do not display PASS when static analysis coverage is partial", () => {
  const partialReport = {
    ...report,
    analysisScope: {
      complete: true,
      assessmentStatus: "partial",
      sourceFiles: 3,
      scannedExtensions: [".js", ".tsx"],
      incompleteReasons: [],
      deadCodeAnalysis: {
        status: "partial",
        coverageWarnings: 2,
        possibleUnusedExports: 4,
        possibleUnusedBindings: 5,
        possibleUnusedCssSelectors: 6,
        possibleUnusedDeclarations: 3,
        unresolvedRelativeImports: 2,
        dependencyCycles: 1
      },
      languageCoverage: {
        javascriptModuleGraph: { supportedExtensions: [".js", ".mjs", ".cjs"], unsupportedModuleFiles: 1 },
        cssSelectors: { parsedExtensions: [".css", ".scss", ".less"], indentedSassFiles: 0 },
        database: { supportedExtensions: [".sql", ".prisma"], scannedFiles: 0 }
      }
    }
  };
  const markdown = formatMarkdownReport(partialReport);
  const html = formatHtmlReport(partialReport);
  assert.match(markdown, /REVIEW REQUIRED — PARTIAL COVERAGE/);
  assert.match(html, /REVIEW REQUIRED — PARTIAL COVERAGE/);
  assert.match(markdown, /unsupported module files: 1/);
  assert.match(html, /unsupported module files: 1/);
  assert.match(markdown, /Possible unused declarations: 3/);
  assert.match(html, /Possible unused declarations: 3/);
  assert.match(markdown, /Dependency cycles: 1/);
  assert.match(html, /Dependency cycles: 1/);
});

test("theme and interaction reports include contrast, CSS token, and toggle evidence safely", () => {
  const themeReport = {
    ...report,
    passed: false,
    summary: {
      viewportsChecked: 2,
      themesChecked: 2,
      themePairsCompared: 1,
      passedViewports: 0,
      failedViewports: 2,
      totalFindings: 1,
      interactionVisualComparisons: 1,
      interactionVisualFailures: 0
    },
    viewports: [
      {
        name: "mobile",
        theme: "light",
        findings: [{
          id: "UIUX-005-1",
          specialist: "ui-ux",
          severity: "medium",
          title: "Text contrast is below WCAG AA",
          location: "#muted",
          recommendation: "Increase contrast."
        }],
        execution: [],
        evidence: {
          contrastSummary: { measured: 8, failed: 1, inconclusive: 2, exempt: 1 },
          themeAudit: {
            themeMarker: "light",
            themeMarkerSource: "data-theme",
            colorTokens: [{ name: "--surface", value: "#ffffff", scope: "root" }],
            hardcodedColorDeclarationCount: 1,
            hardcodedColorDeclarations: [{
              selector: ".muted",
              property: "color",
              value: "#888888",
              source: "stylesheet"
            }]
          },
          themeTransitionAudit: { enabled: true, restoredStable: true },
          interactionExploration: {
            states: [{
              kind: "theme-toggle",
              triggerSelector: "#theme-toggle",
              themeMarker: "dark",
              rootColorScheme: "dark",
              visibleControls: 4,
              overlapCount: 0,
              themeToggleEffect: {
                status: "changed",
                changedTokens: [{ name: "--surface", before: "#ffffff", after: "#121212" }]
              },
              visualComparison: {
                status: "compared",
                passed: true,
                diffPixelRatio: 0
              }
            }]
          }
        },
        themeTokenComparison: {
          changedTokens: [{
            name: "--surface",
            scope: "root",
            lightValue: "#ffffff",
            darkValue: "#121212"
          }],
          unchangedTokens: [],
          onlyInLight: [],
          onlyInDark: []
        }
      },
      {
        name: "mobile",
        theme: "dark",
        findings: [],
        execution: [],
        evidence: {
          contrastSummary: { measured: 8, failed: 0, inconclusive: 2, exempt: 1 },
          themeAudit: {
            themeMarker: "dark",
            themeMarkerSource: "data-theme",
            colorTokens: [{ name: "--surface", value: "#121212", scope: "root" }],
            hardcodedColorDeclarationCount: 0,
            hardcodedColorDeclarations: []
          },
          themeTransitionAudit: { enabled: true, restoredStable: true },
          interactionExploration: { states: [] }
        },
        themeTokenComparison: {
          changedTokens: [{
            name: "--surface",
            scope: "root",
            lightValue: "#ffffff",
            darkValue: "#121212"
          }],
          unchangedTokens: [],
          onlyInLight: [],
          onlyInDark: []
        }
      }
    ]
  };
  const markdown = formatMarkdownReport(themeReport);
  const html = formatHtmlReport(themeReport);
  assert.match(markdown, /Theme and contrast audit/);
  assert.match(markdown, /CSS custom-property differences/);
  assert.match(markdown, /Literal CSS color declarations/);
  assert.match(markdown, /Interactive state exploration/);
  assert.match(markdown, /Toggle effect/);
  assert.match(html, /Theme and contrast audit/);
  assert.match(html, /CSS theme details/);
  assert.match(html, /Literal CSS color declarations/);
  assert.match(html, /Interactive state exploration/);
  assert.match(html, /no-measurable-change|changed/);
  assert.ok(html.includes("&lt;script&gt;") || html.includes("theme-toggle"));
});
