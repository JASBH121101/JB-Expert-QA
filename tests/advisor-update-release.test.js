import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createSignedAdvisorManifest } from "../scripts/create-advisor-update-manifest.mjs";
import { verifyUpdateManifest } from "../src/update-manager/manager.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const packageJson = {
  name: "@jb/advisor-engine",
  version: "0.1.1",
  license: "MIT",
  private: false
};
const integrity = "sha512-" + Buffer.alloc(64, 11).toString("base64");

test("creates a valid, short-lived Ed25519 JBAE update manifest", () => {
  const now = Date.parse("2026-11-26T20:00:00.000Z");
  const result = createSignedAdvisorManifest({ packageJson, integrity, privateKeyPem, publicKeyPem, now });
  const verified = verifyUpdateManifest({ raw: result.raw, signature: result.signature, publicKey: publicKeyPem, now });
  assert.equal(verified.signatureVerified, true);
  assert.equal(verified.manifest.channel, "stable");
  assert.equal(verified.manifest.packages["@jb/advisor-engine"].version, "0.1.1");
  assert.equal(
    verified.manifest.packages["@jb/advisor-engine"].dist.tarball,
    "https://registry.npmjs.org/@jb%2fadvisor-engine/-/advisor-engine-0.1.1.tgz"
  );
  assert.equal(Date.parse(verified.manifest.expiresAt) - Date.parse(verified.manifest.issuedAt), 7 * 24 * 60 * 60 * 1000);
});

test("refuses to sign a package whose license is UNLICENSED or missing", () => {
  assert.throws(() => createSignedAdvisorManifest({
    packageJson: { ...packageJson, license: "UNLICENSED" }, integrity, privateKeyPem, publicKeyPem
  }), /license must not be UNLICENSED/i);
  assert.throws(() => createSignedAdvisorManifest({
    packageJson: { ...packageJson, license: undefined }, integrity, privateKeyPem, publicKeyPem
  }), /license must not be UNLICENSED/i);
});

test("refuses private packages and mismatched publisher keys", () => {
  assert.throws(() => createSignedAdvisorManifest({
    packageJson: { ...packageJson, private: true }, integrity, privateKeyPem, publicKeyPem
  }), /private package/i);
  const other = generateKeyPairSync("ed25519");
  const otherPrivate = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => createSignedAdvisorManifest({
    packageJson, integrity, privateKeyPem: otherPrivate, publicKeyPem
  }), /does not match/i);
});

test("rejects malformed artifact integrity and altered signed bytes", () => {
  assert.throws(() => createSignedAdvisorManifest({
    packageJson, integrity: "sha512-not-a-real-digest", privateKeyPem, publicKeyPem
  }), /SHA-512 integrity/i);
  const result = createSignedAdvisorManifest({ packageJson, integrity, privateKeyPem, publicKeyPem });
  assert.throws(() => verifyUpdateManifest({
    raw: result.raw.replace("0.1.1", "0.1.2"),
    signature: result.signature,
    publicKey: publicKeyPem
  }), /signature verification failed/i);
});
