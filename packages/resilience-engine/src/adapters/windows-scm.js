const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

export function createWindowsScmAdapter({ run, allowedServices = [], timeoutMs = 10_000 } = {}) {
  if (typeof run !== "function") throw new TypeError("run must be an injected command runner");
  if (!Array.isArray(allowedServices) ||
      allowedServices.some((id) => typeof id !== "string" || !SERVICE_ID.test(id)) ||
      new Set(allowedServices).size !== allowedServices.length) {
    throw new TypeError("allowedServices must contain unique valid service names");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError("timeoutMs must be between 100 and 60000");
  }
  const allowed = new Set(allowedServices);
  return Object.freeze({
    platform: "windows-scm",
    async restartService(serviceId) {
      if (!allowed.has(serviceId)) throw new Error("service is not allowlisted");
      const stop = await run("sc.exe", ["stop", serviceId], {
        shell: false, timeoutMs, windowsHide: true
      });
      if (!stop || (stop.exitCode ?? stop.code) !== 0) {
        throw new Error("Windows service stop failed");
      }
      const start = await run("sc.exe", ["start", serviceId], {
        shell: false, timeoutMs, windowsHide: true
      });
      if (!start || (start.exitCode ?? start.code) !== 0) {
        throw new Error("Windows service start failed");
      }
      return start;
    }
  });
}
