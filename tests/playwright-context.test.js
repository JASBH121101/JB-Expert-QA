import test from "node:test";
import assert from "node:assert/strict";
import { collectPageContext } from "../src/adapters/playwright/context.js";

test("context collector requests DOM metrics from browser page", async () => {
  let receivedSettings;
  const page = {
    async evaluate(callback, settings) {
      receivedSettings = settings;
      assert.equal(typeof callback, "function");
      return {
        viewport: { width: 390, height: 844 },
        documentScrollWidth: 420,
        elements: [],
        textElements: [],
        interactiveElements: [],
        verticalGaps: []
      };
    }
  };

  const context = await collectPageContext(page, {
    thresholds: { minimumBodyFontPx: 13 }
  });

  assert.deepEqual(receivedSettings, {
    thresholds: { minimumBodyFontPx: 13 }
  });
  assert.equal(context.viewport.width, 390);
  assert.equal(context.documentScrollWidth, 420);
});
