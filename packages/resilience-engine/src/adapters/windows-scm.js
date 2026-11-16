const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

export function createWindowsScmAdapter({
  run, allowedServices = [], timeoutMs = 10_000, pollIntervalMs = 250,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  clock = Date.now
} = {}) {
  if (typeof run !== "function") throw new TypeError("run must be an injected command runner");
  if (!Array.isArray(allowedServices) ||
      allowedServices.some((id) => typeof id !== "string" || !SERVICE_ID.test(id)) ||
      new Set(allowedServices).size !== allowedServices.length) {
    throw new TypeError("allowedServices must contain unique valid service names");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError("timeoutMs must be between 100 and 60000");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 1000) {
    throw new TypeError("pollIntervalMs must be between 10 and 1000");
  }
  if (typeof sleep !== "function" || typeof clock !== "function") {
    throw new TypeError("sleep and clock must be functions");
  }
  const allowed = new Set(allowedServices);

  function assertSuccess(result, action) {
    const exitCode = result?.exitCode ?? result?.code;
    if (!result || exitCode !== 0) throw new Error("Windows service " + action + " command failed");
    return result;
  }

  async function waitForState(serviceId, expectedState) {
    const startedAt = clock();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0 ||
        !Number.isSafeInteger(startedAt + timeoutMs)) {
      throw new Error("Windows service state wait clock is invalid");
    }
    const deadline = startedAt + timeoutMs;
    while (clock() <= deadline) {
      const remaining = deadline - clock();
      if (remaining < 0) break;
      const response = assertSuccess(await run(
        "sc.exe", ["query", serviceId],
        { shell: false, timeoutMs: Math.max(1, Math.min(timeoutMs, remaining || 1)), windowsHide: true }
      ), "query");
      const output = [response.stdout, response.output, response.stderr]
        .filter((value) => typeof value === "string").join("\n");
      const match = output.match(/\bSTATE\s*:\s*\d+\s+([A-Z_]+)\b/i);
      const state = match?.[1]?.toUpperCase() ?? null;
      if (state === expectedState && clock() <= deadline) return response;
      const afterQuery = deadline - clock();
      if (afterQuery <= 0) break;
      await sleep(Math.min(pollIntervalMs, afterQuery));
    }
    throw new Error("Windows service did not reach " + expectedState + " before timeout");
  }

  return Object.freeze({
    platform: "windows-scm",
    async restartService(serviceId) {
      if (!allowed.has(serviceId)) throw new Error("service is not allowlisted");
      assertSuccess(await run(
        "sc.exe", ["stop", serviceId], { shell: false, timeoutMs, windowsHide: true }
      ), "stop");
      await waitForState(serviceId, "STOPPED");
      assertSuccess(await run(
        "sc.exe", ["start", serviceId], { shell: false, timeoutMs, windowsHide: true }
      ), "start");
      const running = await waitForState(serviceId, "RUNNING");
      return Object.freeze({
        serviceId,
        stopped: true,
        running: true,
        platform: "windows-scm",
        commandResult: running
      });
    }
  });
}
