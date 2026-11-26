import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyUpdateManifest } from "../src/update-manager/manager.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = resolve(ROOT, "packages/advisor-engine/package.json");
const PUBLIC_KEY_PATH = resolve(ROOT, "releases/stable/jbae-update-public-key.pem");
const OUTPUT_DIRECTORY = resolve(ROOT, "releases/stable");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertApprovedPackage(packageJson) {
  assert(packageJson && packageJson.name === "@jb/advisor-engine", "Release package must be @jb/advisor-engine");
  assert(packageJson.private !== true, "A private package cannot be published to the public npm registry");
  assert(typeof packageJson.license === "string" && packageJson.license.trim() && packageJson.license !== "UNLICENSED",
    "JBAE public publication is blocked until its package license is explicitly approved (license must not be UNLICENSED)");
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageJson.version),
    "JBAE package version must be a valid semver version");
}

function assertIntegrity(value) {
  const match = typeof value === "string" ? value.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/) : null;
  assert(match, "npm pack must provide a SHA-512 integrity value");
  const bytes = Buffer.from(match[1], "base64");
  assert(bytes.length === 64 && bytes.toString("base64") === match[1], "npm pack returned an invalid SHA-512 digest");
}

export function createSignedAdvisorManifest({ packageJson, integrity, privateKeyPem, publicKeyPem, now = Date.now() }) {
  assertApprovedPackage(packageJson);
  assertIntegrity(integrity);
  assert(typeof privateKeyPem === "string" && privateKeyPem.includes("PRIVATE KEY"),
    "A publisher Ed25519 private key is required through JB_QA_UPDATE_SIGNING_PRIVATE_KEY");
  assert(typeof publicKeyPem === "string" && publicKeyPem.includes("PUBLIC KEY"),
    "The pinned JBAE update public key is missing");

  const privateKey = createPrivateKey(privateKeyPem);
  const trustedPublicKey = createPublicKey(publicKeyPem);
  const derivedPublicKey = createPublicKey(privateKey);
  assert(privateKey.asymmetricKeyType === "ed25519" && trustedPublicKey.asymmetricKeyType === "ed25519",
    "JBAE publisher and trusted keys must use Ed25519");
  assert(derivedPublicKey.export({ type: "spki", format: "der" }).equals(
    trustedPublicKey.export({ type: "spki", format: "der" })
  ), "Publisher private key does not match the pinned JBAE public key");

  const version = packageJson.version;
  const manifest = {
    schemaVersion: 1,
    channel: "stable",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SEVEN_DAYS_MS).toISOString(),
    packages: {
      "@jb/advisor-engine": {
        version,
        nodeMinMajor: 22,
        dist: {
          tarball: "https://registry.npmjs.org/@jb%2fadvisor-engine/-/advisor-engine-" + version + ".tgz",
          integrity
        }
      }
    }
  };
  const raw = JSON.stringify(manifest, null, 2) + "\n";
  const signature = sign(null, Buffer.from(raw, "utf8"), privateKey).toString("base64") + "\n";
  verifyUpdateManifest({ raw, signature, publicKey: publicKeyPem, now });
  return Object.freeze({ manifest, raw, signature });
}

function runNpmPack(packageDirectory, destination) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(executable, ["pack", packageDirectory, "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5 * 60 * 1000
  });
  if (result.error || result.status !== 0) {
    throw new Error("npm pack failed: " + (result.error?.message || result.stderr || result.stdout || "unknown error"));
  }
  let packed;
  try {
    packed = JSON.parse(result.stdout);
  } catch {
    throw new Error("npm pack did not return valid JSON metadata");
  }
  assert(Array.isArray(packed) && packed.length === 1, "npm pack must return exactly one JBAE package artifact");
  assert(packed[0].name === "@jb/advisor-engine", "npm pack returned an unexpected package");
  return packed[0];
}

export async function prepareAdvisorUpdateManifest(options = {}) {
  assert(process.env.JBAE_DISTRIBUTION_APPROVED === "true",
    "Set the repository Actions variable JBAE_DISTRIBUTION_APPROVED=true only after approving public JBAE distribution");
  const packageJson = options.packageJson ?? JSON.parse(await readFile(PACKAGE_PATH, "utf8"));
  const privateKeyPem = options.privateKeyPem ?? process.env.JB_QA_UPDATE_SIGNING_PRIVATE_KEY;
  const publicKeyPem = options.publicKeyPem ?? await readFile(PUBLIC_KEY_PATH, "utf8");
  const outputDirectory = options.outputDirectory ?? OUTPUT_DIRECTORY;
  const now = options.now ?? Date.now();
  let artifactIntegrity = options.integrity;
  let temporaryDirectory;
  try {
    if (!artifactIntegrity) {
      temporaryDirectory = await mkdtemp(resolve(tmpdir(), "jbae-release-pack-"));
      const packed = runNpmPack(resolve(ROOT, "packages/advisor-engine"), temporaryDirectory);
      artifactIntegrity = packed.integrity;
      assert(packed.version === packageJson.version, "Packed JBAE version does not match package.json");
    }
    const signed = createSignedAdvisorManifest({ packageJson, integrity: artifactIntegrity, privateKeyPem, publicKeyPem, now });
    await mkdir(outputDirectory, { recursive: true });
    const manifestPath = resolve(outputDirectory, "jbae-update-manifest.json");
    const signaturePath = manifestPath + ".sig";
    await writeFile(manifestPath, signed.raw, { encoding: "utf8", mode: 0o644 });
    await writeFile(signaturePath, signed.signature, { encoding: "utf8", mode: 0o644 });
    return { ...signed, manifestPath, signaturePath };
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    assert(process.env.JBAE_DISTRIBUTION_APPROVED === "true",
      "Refusing to prepare a public release manifest: JBAE_DISTRIBUTION_APPROVED is not true");
    const result = await prepareAdvisorUpdateManifest();
    console.log("Prepared signed JBAE " + result.manifest.packages["@jb/advisor-engine"].version + " update manifest.");
    console.log("Manifest: " + result.manifestPath);
    console.log("Signature: " + result.signaturePath);
    console.log("The manifest is not a publication; the workflow must verify npm publication before serving it.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
