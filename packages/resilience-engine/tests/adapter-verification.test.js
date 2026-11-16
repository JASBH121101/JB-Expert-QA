import test from "node:test";
import assert from "node:assert/strict";
import { createLinuxSystemdAdapter } from "../src/adapters/linux-systemd.js";
import { createWindowsScmAdapter } from "../src/adapters/windows-scm.js";

test("Linux systemd adapter verifies that the service is active without a shell", async () => {
  const calls = [];
  const adapter = createLinuxSystemdAdapter({
    allowedServices: ["catalog-api.service"],
    run: async (...args) => {
      calls.push(args);
      return args[1][0] === "is-active" ? { code: 0 } : { code: 0 };
    }
  });
  const result = await adapter.verifyService("catalog-api.service");
  assert.deepEqual(result, { healthy: true, state: "active" });
  assert.equal(calls[0][0], "systemctl");
  assert.deepEqual(calls[0][1], ["is-active", "--quiet", "catalog-api.service"]);
  assert.equal(calls[0][2].shell, false);
});

test("Linux systemd adapter reports inactive services and rejects unallowlisted verification", async () => {
  const adapter = createLinuxSystemdAdapter({
    allowedServices: ["catalog-api.service"],
    run: async () => ({ code: 3 })
  });
  assert.deepEqual(await adapter.verifyService("catalog-api.service"), {
    healthy: false, state: "inactive"
  });
  await assert.rejects(() => adapter.verifyService("attacker; id"), /allowlisted/);
});

test("Windows SCM adapter verifies a parsed RUNNING state", async () => {
  const calls = [];
  const adapter = createWindowsScmAdapter({
    allowedServices: ["JBService"],
    run: async (...args) => {
      calls.push(args);
      return { code: 0, stdout: "SERVICE_NAME: JBService\n        STATE              : 4  RUNNING" };
    }
  });
  assert.deepEqual(await adapter.verifyService("JBService"), {
    healthy: true, state: "RUNNING"
  });
  assert.deepEqual(calls[0][0], "sc.exe");
  assert.deepEqual(calls[0][1], ["query", "JBService"]);
  assert.equal(calls[0][2].shell, false);
});

test("Windows SCM adapter fails verification for inactive and malformed state responses", async () => {
  const inactive = createWindowsScmAdapter({
    allowedServices: ["JBService"],
    run: async () => ({ code: 0, stdout: "STATE : 1 STOPPED" })
  });
  assert.deepEqual(await inactive.verifyService("JBService"), {
    healthy: false, state: "STOPPED"
  });

  const malformed = createWindowsScmAdapter({
    allowedServices: ["JBService"],
    run: async () => ({ code: 0, stdout: "unexpected response" })
  });
  await assert.rejects(() => malformed.verifyService("JBService"), /could not be parsed/);
});
