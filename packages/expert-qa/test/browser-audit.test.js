import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { chromium } from "playwright";
import { auditUrl, auditViewports, comparePngBuffers } from "../src/index.js";
import pngjs from "pngjs";

const { PNG } = pngjs;
const browserInstalled = existsSync(chromium.executablePath());
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

test("Playwright audits a local page, explores a safe interaction and captures viewport evidence", {
  skip: !browserInstalled && "Run jb-qa setup --browser chromium to enable browser integration tests."
}, async () => {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JB QA fixture</title></head>
<body>
  <main>
    <h1>Browser audit fixture</h1>
    <button id="menu-toggle" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="qa-menu">Open menu</button>
    <nav id="qa-menu" aria-label="Test navigation" hidden><a href="#section">Section</a></nav>
    <section id="section"><h2>Content</h2><p>Local fixture for the installed complete engine.</p></section>
  </main>
  <script>
    const button = document.getElementById("menu-toggle");
    const menu = document.getElementById("qa-menu");
    button.addEventListener("click", () => {
      const open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      menu.hidden = !open;
    });
  </script>
</body></html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = "http://127.0.0.1:" + address.port + "/";
  const output = await mkdtemp(path.join(os.tmpdir(), "jb-qa-browser-package-"));
  temporaryDirectories.push(output);
  try {
    const single = await auditUrl(url, {
      allowPrivateNetworks: true,
      sameOriginOnly: true,
      interactionExploration: true,
      maxInteractionActions: 3,
      runAxe: true,
      screenshotPath: path.join(output, "single.png")
    });
    assert.ok(single.evidence.interactionCandidates >= 1);
    assert.ok(single.evidence.interactionActionsAttempted >= 1);
    assert.ok(single.evidence.interactionStatesChecked >= 1);
    assert.ok(Array.isArray(single.viewports) === false);
    assert.ok((await readFile(path.join(output, "single.png"))).length > 0);

    const matrix = await auditViewports(url, {
      allowPrivateNetworks: true,
      sameOriginOnly: true,
      interactionExploration: true,
      maxInteractionActions: 3,
      screenshotDir: path.join(output, "matrix"),
      viewports: [
        { name: "mobile", width: 390, height: 844 },
        { name: "desktop", width: 1365, height: 900 }
      ]
    });
    assert.equal(matrix.summary.viewportsChecked, 2);
    assert.ok(matrix.viewports.every((item) => item.evidence.interactionActionsAttempted >= 1));
    assert.ok(matrix.viewports.every((item) => existsSync(item.screenshotPath)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("visual regression comparison is present and operational in the installed package", () => {
  const baseline = new PNG({ width: 2, height: 2 });
  baseline.data.fill(255);
  const actual = PNG.sync.write(baseline);
  const result = comparePngBuffers(actual, actual);
  assert.equal(result.status, "compared");
  assert.equal(result.passed, true);
  assert.equal(result.diffPixels, 0);
});
