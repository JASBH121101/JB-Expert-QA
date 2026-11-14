import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  applyEngineUpdate,
  buildUpdatePlan,
  rollbackEngineUpdate,
  verifyUpdateManifest
} from "../src/update-manager/manager.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const integrity = "sha512-" + Buffer.alloc(64, 7).toString("base64");

function makeManifest(version = "0.2.1", now = Date.now()) {
  return {
    schemaVersion: 1,
    channel: "stable",
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    packages: {
      "@jb/expert-qa": {
        version,
        nodeMinMajor: 22,
        dist: {
          tarball: "https://registry.npmjs.org/@jb%2fexpert-qa/-/expert-qa-" + version + ".tgz",
          integrity
        }
      }
    }
  };
}

function signManifest(manifest) {
  const raw = JSON.stringify(manifest);
  return {
    raw,
    signature: sign(null, Buffer.from(raw, "utf8"), privateKey).toString("base64")
  };
}

async function createProject() {
  const root = await mkdtemp(resolve(tmpdir(), "jb-qa-project-"));
  const packageDirectory = resolve(root, "node_modules/@jb/expert-qa");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(resolve(root, "package.json"), JSON.stringify({
    name: "fixture-project",
    version: "1.0.0",
    dependencies: { "@jb/expert-qa": "^0.2.0" }
  }, null, 2) + "\n");
  await writeFile(resolve(packageDirectory, "package.json"), JSON.stringify({
    name: "@jb/expert-qa",
    version: "0.2.0",
    main: "./index.js"
  }, null, 2) + "\n");
  await writeFile(resolve(packageDirectory, "index.js"), "export const version = '0.2.0';\n");
  await writeFile(resolve(root, "package-lock.json"), JSON.stringify({
    name: "fixture-project",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture-project", version: "1.0.0" },
      "node_modules/@jb/expert-qa": {
        version: "0.2.0",
        integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64")
      }
    }
  }, null, 2) + "\n");
  return root;
}

function fixtureNpmRunner(args, cwd) {
  if (args[0] === "install") {
    const requested = args[1].split("@").slice(-1)[0];
    const packageDirectory = resolve(cwd, "node_modules/@jb/expert-qa");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(resolve(cwd, "package.json"), JSON.stringify({
      name: "fixture-project",
      version: "1.0.0",
      dependencies: { "@jb/expert-qa": requested }
    }, null, 2) + "\n");
    writeFileSync(resolve(packageDirectory, "package.json"), JSON.stringify({
      name: "@jb/expert-qa",
      version: requested,
      main: "./index.js"
    }, null, 2) + "\n");
    writeFileSync(resolve(packageDirectory, "index.js"), "export const version = " + JSON.stringify(requested) + ";\n");
    const lock = JSON.parse(readFileSync(resolve(cwd, "package-lock.json"), "utf8"));
    lock.packages["node_modules/@jb/expert-qa"] = {
      version: requested,
      integrity,
      resolved: "https://registry.npmjs.org/@jb%2fexpert-qa/-/expert-qa-" + requested + ".tgz"
    };
    writeFileSync(resolve(cwd, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    return { status: 0, stdout: "", stderr: "" };
  }
  if (args[0] === "ci") {
    const lock = JSON.parse(readFileSync(resolve(cwd, "package-lock.json"), "utf8"));
    const version = lock.packages["node_modules/@jb/expert-qa"].version;
    const packageDirectory = resolve(cwd, "node_modules/@jb/expert-qa");
    writeFileSync(resolve(packageDirectory, "package.json"), JSON.stringify({
      name: "@jb/expert-qa",
      version,
      main: "./index.js"
    }, null, 2) + "\n");
    writeFileSync(resolve(packageDirectory, "index.js"), "export const version = " + JSON.stringify(version) + ";\n");
    return { status: 0, stdout: "", stderr: "" };
  }
  throw new Error("Unexpected npm command: " + args.join(" "));
}

test("verifies signed Ed25519 manifests and rejects tampering", () => {
  const signed = signManifest(makeManifest());
  const verified = verifyUpdateManifest({ ...signed, publicKey: publicKeyPem });
  assert.equal(verified.signatureVerified, true);
  assert.equal(verified.manifest.packages["@jb/expert-qa"].version, "0.2.1");
  assert.throws(() => verifyUpdateManifest({
    ...signed,
    raw: signed.raw.replace("0.2.1", "0.2.2"),
    publicKey: publicKeyPem
  }), /signature verification failed/i);
});

test("rejects expired manifests, untrusted packages and non-registry tarballs", () => {
  const expired = signManifest(makeManifest("0.2.1", Date.now() - 10 * 24 * 60 * 60_000));
  assert.throws(() => verifyUpdateManifest({ ...expired, publicKey: publicKeyPem }), /expired/i);

  const unknown = makeManifest();
  unknown.packages["evil-package"] = unknown.packages["@jb/expert-qa"];
  const unknownSigned = signManifest(unknown);
  assert.throws(() => verifyUpdateManifest({ ...unknownSigned, publicKey: publicKeyPem }), /unsupported engine package/i);

  const badHost = makeManifest();
  badHost.packages["@jb/expert-qa"].dist.tarball = "https://attacker.example/package.tgz";
  const badHostSigned = signManifest(badHost);
  assert.throws(() => verifyUpdateManifest({ ...badHostSigned, publicKey: publicKeyPem }), /registry.npmjs.org/i);
});

test("builds an update plan only for installed direct engine dependencies", async () => {
  const root = await createProject();
  try {
    const plan = await buildUpdatePlan({ projectRoot: root, manifest: makeManifest() });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].currentVersion, "0.2.0");
    assert.equal(plan[0].candidateVersion, "0.2.1");
    assert.equal(plan[0].decision, "candidate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applies a verified patch, records a backup and supports rollback", async () => {
  const root = await createProject();
  try {
    const result = await applyEngineUpdate({
      packageName: "@jb/expert-qa",
      release: makeManifest().packages["@jb/expert-qa"],
      currentVersion: "0.2.0",
      projectRoot: root,
      manifestVerified: true,
      stageCandidate: async () => ({ lockEntry: { integrity } }),
      npmRunner: fixtureNpmRunner
    });
    assert.equal(result.decision, "auto-apply");
    assert.equal(result.installedVersion, "0.2.1");

    const updatedPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    assert.equal(updatedPackage.dependencies["@jb/expert-qa"], "0.2.1");

    const rollback = await rollbackEngineUpdate({
      backupId: result.backupId,
      projectRoot: root,
      npmRunner: fixtureNpmRunner
    });
    assert.equal(rollback.restoredVersion, "0.2.0");

    const restoredPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const restoredLock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
    assert.equal(restoredPackage.dependencies["@jb/expert-qa"], "^0.2.0");
    assert.equal(restoredLock.packages["node_modules/@jb/expert-qa"].version, "0.2.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires approval for minor releases and never installs them silently", async () => {
  const root = await createProject();
  let installCalled = false;
  try {
    await assert.rejects(() => applyEngineUpdate({
      packageName: "@jb/expert-qa",
      release: makeManifest("0.3.0").packages["@jb/expert-qa"],
      currentVersion: "0.2.0",
      projectRoot: root,
      manifestVerified: true,
      stageCandidate: async () => ({ lockEntry: { integrity } }),
      npmRunner: (...args) => {
        installCalled = true;
        return fixtureNpmRunner(...args);
      }
    }), /approval-required/i);
    assert.equal(installCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
