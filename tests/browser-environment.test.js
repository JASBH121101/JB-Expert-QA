import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserEnvironment } from "../src/adapters/playwright/browser-environment.js";

test("browser process receives only the minimum runtime environment, never API credentials", () => {
  const environment = createBrowserEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    PLAYWRIGHT_BROWSERS_PATH: "/home/runner/.cache/ms-playwright",
    GEMINI_API_KEY: "gemini-secret",
    CLOUDFLARE_API_TOKEN: "cloudflare-secret",
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    GITHUB_TOKEN: "github-secret",
    NODE_OPTIONS: "--require=secret-loader",
    CUSTOM_PASSWORD: "password-value"
  });
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, "/home/runner");
  assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, "/home/runner/.cache/ms-playwright");
  assert.equal(Object.hasOwn(environment, "GEMINI_API_KEY"), false);
  assert.equal(Object.hasOwn(environment, "CLOUDFLARE_API_TOKEN"), false);
  assert.equal(Object.hasOwn(environment, "CLOUDFLARE_ACCOUNT_ID"), false);
  assert.equal(Object.hasOwn(environment, "GITHUB_TOKEN"), false);
  assert.equal(Object.hasOwn(environment, "NODE_OPTIONS"), false);
  assert.equal(Object.hasOwn(environment, "CUSTOM_PASSWORD"), false);
  assert.equal(Object.isFrozen(environment), true);
  assert.equal(Object.getPrototypeOf(environment), null);
});

test("browser environment rejects invalid sources", () => {
  assert.throws(() => createBrowserEnvironment(null), /must be an object/);
  assert.throws(() => createBrowserEnvironment([]), /must be an object/);
});
