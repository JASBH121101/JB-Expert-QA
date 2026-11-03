import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeWebSocketUrl,
  createUrlSafetyGuard,
  isPublicAddress
} from "../src/adapters/playwright/url-safety.js";

test("public address classifier accepts public IPv4 and IPv6 addresses", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
});

test("public address classifier rejects private, loopback and reserved addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.10",
    "192.0.2.10",
    "192.168.1.1",
    "198.51.100.20",
    "203.0.113.10",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1"
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("URL guard permits public IP literals and blocks private IP literals", async () => {
  const guard = createUrlSafetyGuard();
  assert.equal((await guard("https://8.8.8.8/")).hostname, "8.8.8.8");
  await assert.rejects(guard("http://127.0.0.1/"), /private|reserved/i);
  await assert.rejects(guard("http://169.254.169.254/latest/meta-data/"), /private|reserved/i);
});

test("URL guard rejects local hostnames, unsupported schemes and embedded credentials", async () => {
  const guard = createUrlSafetyGuard();
  await assert.rejects(guard("http://localhost:3000/"), /Local and reserved/);
  await assert.rejects(guard("http://service.internal/"), /Local and reserved/);
  await assert.rejects(guard("file:///etc/passwd"), /Only http and https/);
  await assert.rejects(guard("https://user:pass@example.com/"), /embedded credentials/);
});

test("URL guard rejects hostnames resolving to any private address", async () => {
  const guard = createUrlSafetyGuard({
    dnsLookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.1.2.3", family: 4 }
    ]
  });
  await assert.rejects(guard("https://mixed.example/"), /private or reserved/);
});

test("URL guard allows a hostname only when all DNS answers are public", async () => {
  const guard = createUrlSafetyGuard({
    dnsLookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 }
    ]
  });
  const parsed = await guard("https://public.example/");
  assert.equal(parsed.hostname, "public.example");
});

test("private network access requires an explicit opt-in", async () => {
  const guard = createUrlSafetyGuard({ allowPrivateNetworks: true });
  assert.equal((await guard("http://127.0.0.1:3000/")).hostname, "127.0.0.1");
});

test("hostname DNS answers are rechecked for every guarded request", async () => {
  let calls = 0;
  const guard = createUrlSafetyGuard({
    dnsLookup: async () => {
      calls += 1;
      return [{
        address: calls === 1 ? "93.184.216.34" : "127.0.0.1",
        family: 4
      }];
    }
  });
  await guard("https://qa.example.com/");
  await assert.rejects(guard("https://qa.example.com/"), /private or reserved/);
  assert.equal(calls, 2);
});

test("WebSocket destinations are checked with the HTTP network policy", async () => {
  const checkedProtocols = [];
  const httpGuard = async (input) => {
    const parsed = input instanceof URL ? input : new URL(input);
    checkedProtocols.push(parsed.protocol);
    if (parsed.hostname === "127.0.0.1") throw new TypeError("Private destination blocked");
    return parsed;
  };
  const safe = await assertSafeWebSocketUrl("wss://public.example/ws", httpGuard);
  assert.equal(safe.protocol, "wss:");
  assert.deepEqual(checkedProtocols, ["https:"]);
  await assert.rejects(
    assertSafeWebSocketUrl("ws://127.0.0.1:3000/socket", httpGuard),
    /Private destination blocked/
  );
});
