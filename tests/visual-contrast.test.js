import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeContrastSamples,
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  summarizeContrastResults
} from "../src/adapters/visual/contrast.js";

test("CSS RGB and hexadecimal colors are parsed", () => {
  assert.deepEqual(parseCssColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseCssColor("#00000080"), {
    r: 0, g: 0, b: 0, a: 128 / 255
  });
  assert.deepEqual(parseCssColor("rgb(10, 20, 30)"), {
    r: 10, g: 20, b: 30, a: 1
  });
  assert.equal(parseCssColor("not-a-color"), null);
});

test("WCAG relative luminance and contrast ratio match reference values", () => {
  assert.equal(relativeLuminance(parseCssColor("#000")), 0);
  assert.equal(relativeLuminance(parseCssColor("#fff")), 1);
  assert.equal(contrastRatio(parseCssColor("#000"), parseCssColor("#fff")), 21);
});

test("contrast analyzer applies 4.5:1 normal text and 3:1 large text thresholds", () => {
  const results = analyzeContrastSamples([
    {
      selector: "#normal-low",
      foreground: "rgb(119, 119, 119)",
      backgroundStatus: "resolved",
      backgroundLayers: ["rgb(255, 255, 255)"],
      fontSizePx: 16,
      fontWeight: 400
    },
    {
      selector: "#large-pass",
      foreground: "rgb(120, 120, 120)",
      backgroundStatus: "resolved",
      backgroundLayers: ["rgb(255, 255, 255)"],
      fontSizePx: 24,
      fontWeight: 400
    }
  ]);
  assert.equal(results[0].status, "measured");
  assert.equal(results[0].passed, false);
  assert.equal(results[0].requiredRatio, 4.5);
  assert.equal(results[1].requiredRatio, 3);
  assert.equal(results[1].passed, true);
});

test("transparent layers are composited over the nearest opaque ancestor", () => {
  const results = analyzeContrastSamples([{
    selector: "#transparent-child",
    foreground: "#000",
    backgroundStatus: "resolved",
    backgroundLayers: ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"],
    fontSizePx: 16,
    fontWeight: 400
  }]);
  assert.equal(results[0].contrastRatio, 21);
  assert.equal(results[0].passed, true);
});

test("unresolvable backgrounds stay inconclusive and do not become failures", () => {
  const results = analyzeContrastSamples([{
    selector: "#image-background",
    foreground: "#fff",
    backgroundStatus: "inconclusive",
    backgroundReason: "background-image-or-gradient",
    backgroundLayers: [],
    fontSizePx: 16,
    fontWeight: 400
  }]);
  assert.equal(results[0].status, "inconclusive");
  assert.equal(results[0].passed, null);
  assert.equal(summarizeContrastResults(results).inconclusive, 1);
});

test("non-text components use a 3:1 threshold and disabled controls are exempt", () => {
  const results = analyzeContrastSamples([
    {
      selector: "#weak-boundary",
      kind: "component-boundary",
      componentPart: "top",
      foreground: "#aaaaaa",
      backgroundStatus: "resolved",
      backgroundLayers: ["#ffffff"],
      state: "default"
    },
    {
      selector: "#disabled-copy",
      kind: "text",
      foreground: "#aaaaaa",
      backgroundStatus: "resolved",
      backgroundLayers: ["#ffffff"],
      fontSizePx: 16,
      fontWeight: 400,
      state: "disabled"
    }
  ]);
  assert.equal(results[0].requiredRatio, 3);
  assert.equal(results[0].passed, false);
  assert.equal(results[1].status, "exempt");
  assert.equal(summarizeContrastResults(results).exempt, 1);
});

test("interaction labels do not override disabled component exemptions", () => {
  const results = analyzeContrastSamples([{
    selector: "#disabled-button",
    kind: "text",
    foreground: "#aaaaaa",
    backgroundStatus: "resolved",
    backgroundLayers: ["#ffffff"],
    fontSizePx: 16,
    fontWeight: 400,
    state: "disabled",
    interactionState: "hover"
  }]);
  assert.equal(results[0].state, "disabled");
  assert.equal(results[0].interactionState, "hover");
  assert.equal(results[0].status, "exempt");
});

test("contrast thresholds reject invalid configuration", () => {
  assert.throws(() => analyzeContrastSamples([], { normalTextRatio: 0 }), /between 1 and 21/);
});
