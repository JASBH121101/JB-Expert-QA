const SAFE_BROWSER_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP",
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "LD_LIBRARY_PATH", "FONTCONFIG_PATH", "DBUS_SESSION_BUS_ADDRESS",
  "LANG", "LC_ALL", "TZ", "CI", "PLAYWRIGHT_BROWSERS_PATH"
]);

/**
 * Build a minimal environment for the untrusted browser process.
 * API tokens and application secrets remain in the trusted Node.js process.
 */
export function createBrowserEnvironment(source = process.env) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Browser environment source must be an object");
  }
  const environment = Object.create(null);
  for (const key of SAFE_BROWSER_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  return Object.freeze(environment);
}
