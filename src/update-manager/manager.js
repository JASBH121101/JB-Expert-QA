import {
  createPublicKey,
  randomUUID,
  verify as verifySignature
} from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  classifyUpdate,
  evaluateHybridUpdate,
  ENGINE_PACKAGES
} from "./policy.js";

const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const INTEGRITY_PATTERN = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/;
const BACKUP_ID_PATTERN = /^\d{14}-[a-f0-9]{8}$/;
const MAX_MANIFEST_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 8 * 1024;
const MAX_JS_FILES_TO_CHECK = 500;

function fail(message) {
  throw new Error(message);
}

function assertHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(label + " must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") fail(label + " must use HTTPS");
  return url;
}

function decodeIntegrity(integrity) {
  const match = typeof integrity === "string" ? integrity.match(INTEGRITY_PATTERN) : null;
  if (!match) fail("Manifest package integrity must use sha256, sha384 or sha512");
  const digest = Buffer.from(match[2], "base64");
  const expectedLength = { "256": 32, "384": 48, "512": 64 }[match[1]];
  if (digest.length !== expectedLength || digest.toString("base64") !== match[2]) {
    fail("Manifest package integrity contains an invalid digest");
  }
}

function validateManifest(manifest, now = Date.now()) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Update manifest must be a JSON object");
  }
  if (manifest.schemaVersion !== 1) fail("Unsupported update manifest schemaVersion");
  if (!["stable", "beta"].includes(manifest.channel)) fail("Manifest channel must be stable or beta");
  if (typeof manifest.issuedAt !== "string" || typeof manifest.expiresAt !== "string") {
    fail("Manifest issuedAt and expiresAt must be ISO date strings");
  }
  const issuedAt = Date.parse(manifest.issuedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    fail("Manifest issuedAt/expiresAt timestamps are invalid");
  }
  if (issuedAt > now + 5 * 60 * 1000) fail("Update manifest appears to be issued in the future");
  if (now >= expiresAt) fail("Update manifest has expired");
  if (expiresAt - issuedAt > MAX_MANIFEST_AGE_MS) {
    fail("Update manifest validity period exceeds the 30-day safety limit");
  }
  if (!manifest.packages || typeof manifest.packages !== "object" || Array.isArray(manifest.packages)) {
    fail("Manifest packages must be an object keyed by package name");
  }

  for (const [name, release] of Object.entries(manifest.packages)) {
    if (!ENGINE_PACKAGES.includes(name)) fail("Manifest contains an unsupported engine package: " + name);
    if (!release || typeof release !== "object" || Array.isArray(release)) {
      fail("Manifest release entry is invalid for " + name);
    }
    const classification = classifyUpdate("0.0.0", release.version);
    if (classification.status === "invalid-version") fail("Invalid release version for " + name);
    if (typeof release.nodeMinMajor !== "number" ||
        !Number.isInteger(release.nodeMinMajor) || release.nodeMinMajor < 22) {
      fail("Manifest nodeMinMajor must be an integer of at least 22 for " + name);
    }
    if (!release.dist || typeof release.dist !== "object") {
      fail("Manifest dist metadata is required for " + name);
    }
    decodeIntegrity(release.dist.integrity);
    const tarball = assertHttpsUrl(release.dist.tarball, "Manifest tarball URL");
    const packageLeaf = name.split("/").at(-1);
    const expectedTarballPath = "/" + name.replace("/", "%2f") +
      "/-/" + packageLeaf + "-" + release.version + ".tgz";
    if (tarball.hostname !== "registry.npmjs.org" ||
        tarball.username || tarball.password || tarball.port ||
        tarball.search || tarball.hash || tarball.pathname !== expectedTarballPath) {
      fail("Engine tarball URL must match the exact versioned artifact path on registry.npmjs.org");
    }
  }
  return manifest;
}

export function verifyUpdateManifest({ raw, signature, publicKey, now = Date.now() } = {}) {
  if (typeof raw !== "string" || !raw.trim()) fail("Update manifest is empty");
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) fail("Update manifest exceeds the 256 KiB size limit");
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature.trim())) {
    fail("Detached manifest signature is missing or invalid");
  }
  if (typeof publicKey !== "string" || !publicKey.trim()) {
    fail("A trusted Ed25519 public key is required");
  }

  let key;
  try {
    key = createPublicKey(publicKey);
  } catch (error) {
    fail("Unable to parse trusted update public key: " +
      (error instanceof Error ? error.message : String(error)));
  }
  if (key.asymmetricKeyType !== "ed25519") fail("Trusted update key must be Ed25519");

  const signatureBytes = Buffer.from(signature.trim(), "base64");
  if (signatureBytes.length !== 64 ||
      signatureBytes.toString("base64") !== signature.trim()) {
    fail("Detached manifest signature must be a valid Ed25519 base64 signature");
  }
  if (!verifySignature(null, Buffer.from(raw, "utf8"), key, signatureBytes)) {
    fail("Update manifest signature verification failed");
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail("Update manifest is not valid JSON: " +
      (error instanceof Error ? error.message : String(error)));
  }
  return Object.freeze({
    manifest: Object.freeze(validateManifest(manifest, now)),
    signatureVerified: true
  });
}

async function readTextSource(source, fetchImpl, {
  maxBytes = MAX_MANIFEST_BYTES,
  label = "Source"
} = {}) {
  if (typeof source !== "string" || !source.trim()) fail("Manifest source is required");
  if (source.startsWith("https://")) {
    assertHttpsUrl(source, label + " URL");
    const response = await fetchImpl(source, { redirect: "error" });
    if (!response.ok) fail("Unable to fetch " + label + " (HTTP " + response.status + ")");
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      fail(label + " exceeds the " + maxBytes + "-byte size limit");
    }

    if (typeof response.body?.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => {});
            fail(label + " exceeds the " + maxBytes + "-byte size limit");
          }
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock?.();
      }
      return Buffer.concat(chunks).toString("utf8");
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      fail(label + " exceeds the " + maxBytes + "-byte size limit");
    }
    return text;
  }

  const sourcePath = resolve(source);
  const details = await stat(sourcePath);
  if (!details.isFile()) fail(label + " source must be a regular file");
  if (details.size > maxBytes) fail(label + " exceeds the " + maxBytes + "-byte size limit");
  return readFile(sourcePath, "utf8");
}

async function loadPublicKey({ publicKeyPath, publicKey }) {
  if (typeof publicKey === "string" && publicKey.trim()) return publicKey;
  if (typeof publicKeyPath !== "string" || !publicKeyPath.trim()) {
    fail("Provide --public-key or JB_QA_UPDATE_PUBLIC_KEY before checking updates");
  }
  return readFile(resolve(publicKeyPath), "utf8");
}

export async function loadSignedUpdateManifest({
  manifest,
  signature,
  publicKey,
  publicKeyPath,
  fetchImpl = fetch,
  now = Date.now()
} = {}) {
  const raw = await readTextSource(manifest, fetchImpl, { maxBytes: MAX_MANIFEST_BYTES, label: "Update manifest" });
  const signatureSource = signature ??
    (manifest.startsWith("https://") ? manifest + ".sig" : resolve(manifest) + ".sig");
  const detachedSignature = await readTextSource(signatureSource, fetchImpl, { maxBytes: MAX_SIGNATURE_BYTES, label: "Detached manifest signature" });
  const trustedKey = await loadPublicKey({ publicKeyPath, publicKey });
  return verifyUpdateManifest({
    raw,
    signature: detachedSignature.trim(),
    publicKey: trustedKey,
    now
  });
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail("Unable to read " + label + ": " +
      (error instanceof Error ? error.message : String(error)));
  }
}

async function installedPackage(projectRoot, packageName) {
  const packagePath = resolve(projectRoot, "node_modules", ...packageName.split("/"), "package.json");
  try {
    return await readJson(packagePath, "installed package " + packageName);
  } catch (error) {
    if (String(error?.message).includes("ENOENT")) return null;
    throw error;
  }
}

function dependencySpec(packageJson, packageName) {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (Object.hasOwn(packageJson[section] ?? {}, packageName)) {
      return { section, value: packageJson[section][packageName] };
    }
  }
  return null;
}

export async function buildUpdatePlan({ projectRoot = process.cwd(), manifest } = {}) {
  const root = resolve(projectRoot);
  const projectPackage = await readJson(resolve(root, "package.json"), "project package.json");
  const plan = [];
  for (const packageName of ENGINE_PACKAGES) {
    const release = manifest.packages[packageName];
    const declared = dependencySpec(projectPackage, packageName);
    if (!release || !declared) continue;
    if (/^(?:workspace:|file:|link:)/.test(String(declared.value))) {
      plan.push({ packageName, currentVersion: null, candidateVersion: release.version, status: "local-dependency", releaseType: null, decision: "blocked" });
      continue;
    }
    const installed = await installedPackage(root, packageName);
    if (!installed?.version) {
      plan.push({
        packageName,
        currentVersion: null,
        candidateVersion: release.version,
        status: "dependency-not-installed",
        releaseType: null,
        decision: "blocked"
      });
      continue;
    }
    const classification = classifyUpdate(installed.version, release.version);
    plan.push({
      packageName,
      dependencySection: declared.section,
      currentSpec: declared.value,
      currentVersion: installed.version,
      candidateVersion: release.version,
      status: classification.status,
      releaseType: classification.releaseType,
      decision: classification.newer ? "candidate" : "no-update"
    });
  }
  return plan;
}

function runNpm(args, cwd) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    timeout: 10 * 60 * 1000
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function assertCommandSuccess(result, label) {
  if (result.error || result.status !== 0) {
    fail(label + " failed: " + (result.error?.message || result.stderr || result.stdout || "npm exited unsuccessfully"));
  }
}

async function walkJavaScript(directory, output = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walkJavaScript(path, output);
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      output.push(path);
      if (output.length > MAX_JS_FILES_TO_CHECK) fail("Package contains too many JavaScript files for safe staged validation");
    }
  }
  return output;
}

async function validatePackageLayout({ installRoot, packageName, release }) {
  const packageDirectory = resolve(installRoot, "node_modules", ...packageName.split("/"));
  const packageJson = await readJson(resolve(packageDirectory, "package.json"), "staged " + packageName);
  if (packageJson.name !== packageName || packageJson.version !== release.version) {
    fail("Staged package name/version do not match the signed manifest");
  }
  const lock = await readJson(resolve(installRoot, "package-lock.json"), "staging package-lock.json");
  const lockEntry = lock.packages?.["node_modules/" + packageName];
  if (lockEntry?.version !== release.version || lockEntry.integrity !== release.dist.integrity) {
    fail("Staged package version/integrity does not match the signed manifest");
  }
  const resolvedTarball = assertHttpsUrl(lockEntry.resolved, "Resolved package tarball URL");
  const expectedTarball = assertHttpsUrl(release.dist.tarball, "Signed package tarball URL");
  if (resolvedTarball.hostname !== "registry.npmjs.org" ||
      resolvedTarball.pathname !== expectedTarball.pathname) {
    fail("Resolved package tarball does not match the signed registry artifact");
  }
  if (packageJson.engines?.node) {
    const minimum = String(packageJson.engines.node).match(/^\s*>=\s*(\d+)/);
    if (minimum && Number(process.versions.node.split(".")[0]) < Number(minimum[1])) {
      fail("Current Node.js version does not satisfy the staged package engine requirement");
    }
  }

  const paths = [];
  const addTarget = (target) => {
    if (typeof target !== "string") return;
    if (!target.startsWith("./") || target.includes("\0")) {
      fail("Package entry points must be relative paths inside the package");
    }
    const absolute = resolve(packageDirectory, target);
    const relativeTarget = relative(packageDirectory, absolute);
    if (isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))) {
      fail("Package export escapes its installation directory");
    }
    if (!target.includes("*")) paths.push(absolute);
  };
  addTarget(packageJson.main);
  if (typeof packageJson.exports === "string") addTarget(packageJson.exports);
  else if (packageJson.exports && typeof packageJson.exports === "object") {
    const visit = (value) => {
      if (typeof value === "string") addTarget(value);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(packageJson.exports);
  }
  if (typeof packageJson.bin === "string") addTarget(packageJson.bin);
  else if (packageJson.bin && typeof packageJson.bin === "object") {
    Object.values(packageJson.bin).forEach(addTarget);
  }

  for (const path of paths) {
    try {
      const actualPath = await realpath(path);
      const actualRelative = relative(packageDirectory, actualPath);
      if (isAbsolute(actualRelative) || actualRelative === ".." ||
          actualRelative.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))) {
        fail("Package entry point resolves outside its installation directory");
      }
      await readFile(actualPath);
    } catch (error) {
      if (error instanceof Error && error.message.includes("resolves outside")) throw error;
      fail("Package entry point is missing: " + path.slice(packageDirectory.length + 1));
    }
  }

  for (const path of await walkJavaScript(packageDirectory)) {
    const checked = spawnSync(process.execPath, ["--check", path], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000
    });
    if (checked.error || checked.status !== 0) {
      fail("JavaScript syntax check failed for " + path.slice(packageDirectory.length + 1));
    }
  }
  return { packageJson, lockEntry };
}

async function stagePackage({ packageName, release, npmRunner = runNpm }) {
  const directory = await mkdtemp(resolve(tmpdir(), "jb-qa-update-"));
  try {
    await writeFile(resolve(directory, "package.json"), JSON.stringify({
      name: "jb-qa-update-validation",
      version: "1.0.0",
      private: true
    }, null, 2) + "\n", "utf8");
    const result = npmRunner([
      "install",
      packageName + "@" + release.version,
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund"
    ], directory);
    assertCommandSuccess(result, "Staged npm install");
    return await validatePackageLayout({ installRoot: directory, packageName, release });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeBackup({
  projectRoot,
  packageName,
  candidateVersion,
  previousVersion,
  previousIntegrity
}) {
  const root = resolve(projectRoot);
  const packagePath = resolve(root, "package.json");
  const lockPath = resolve(root, "package-lock.json");
  const id = new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + randomUUID().slice(0, 8);
  const backupDirectory = resolve(root, ".jb-expert-qa", "update-backups", id);
  await mkdir(backupDirectory, { recursive: true });
  await copyFile(packagePath, resolve(backupDirectory, "package.json"));
  await copyFile(lockPath, resolve(backupDirectory, "package-lock.json"));
  await writeFile(resolve(backupDirectory, "metadata.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    packageName,
    candidateVersion,
    previousVersion,
    previousIntegrity,
    createdAt: new Date().toISOString()
  }, null, 2) + "\n", "utf8");
  return { id, backupDirectory };
}

async function restoreBackup({ projectRoot, backupId, npmRunner = runNpm }) {
  if (!BACKUP_ID_PATTERN.test(backupId)) fail("Invalid update backup ID");
  const root = resolve(projectRoot);
  const backupDirectory = resolve(root, ".jb-expert-qa", "update-backups", backupId);
  const metadata = await readJson(resolve(backupDirectory, "metadata.json"), "update backup metadata");
  if (metadata.schemaVersion !== 1 || metadata.id !== backupId ||
      !ENGINE_PACKAGES.includes(metadata.packageName)) {
    fail("Update backup metadata is invalid");
  }
  await copyFile(resolve(backupDirectory, "package.json"), resolve(root, "package.json"));
  await copyFile(resolve(backupDirectory, "package-lock.json"), resolve(root, "package-lock.json"));
  const result = npmRunner(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  assertCommandSuccess(result, "npm rollback");
  const restoredPackage = await installedPackage(root, metadata.packageName);
  const restoredLock = await readJson(resolve(root, "package-lock.json"), "restored package-lock.json");
  const restoredEntry = restoredLock.packages?.["node_modules/" + metadata.packageName];
  if (!restoredPackage || restoredPackage.version !== metadata.previousVersion ||
      restoredEntry?.version !== metadata.previousVersion ||
      (metadata.previousIntegrity && restoredEntry.integrity !== metadata.previousIntegrity)) {
    fail("Rollback verification failed: restored package version or integrity does not match the backup");
  }
  return {
    backupId,
    packageName: metadata.packageName,
    restoredVersion: metadata.previousVersion
  };
}

export async function applyEngineUpdate({
  packageName,
  release,
  currentVersion,
  projectRoot = process.cwd(),
  manifestVerified = false,
  userApproved = false,
  stageCandidate = stagePackage,
  npmRunner = runNpm
} = {}) {
  const root = resolve(projectRoot);
  if (!ENGINE_PACKAGES.includes(packageName)) fail("Unsupported engine package");
  if (!manifestVerified) fail("Refusing to install an update without a verified signed manifest");
  if (!release || typeof release !== "object") fail("Signed release metadata is required");
  const classification = classifyUpdate(currentVersion, release.version);
  if (!classification.newer) fail("No newer version is available for " + packageName);

  const projectPackagePath = resolve(root, "package.json");
  const lockPath = resolve(root, "package-lock.json");
  const projectPackage = await readJson(projectPackagePath, "project package.json");
  const declared = dependencySpec(projectPackage, packageName);
  if (!declared) fail(packageName + " is not a direct dependency of this project");
  if (/^(?:workspace:|file:|link:)/.test(String(declared.value))) {
    fail("Local workspace/file dependencies are not eligible for package auto-updates");
  }
  const installed = await installedPackage(root, packageName);
  if (!installed || installed.version !== currentVersion) {
    fail("Installed version changed since the update plan was created; run update --check again");
  }
  const lock = await readJson(lockPath, "project package-lock.json");
  const currentLockEntry = lock.packages?.["node_modules/" + packageName];
  if (!currentLockEntry || currentLockEntry.version !== currentVersion || !currentLockEntry.integrity) {
    fail("A matching npm package-lock.json version and integrity entry are required before updates can be applied");
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < release.nodeMinMajor) fail("Current Node.js version is below the signed manifest requirement");

  if (classification.status === "prerelease") {
    fail("Prerelease engine updates are not available through the stable CLI path");
  }
  if (classification.releaseType !== "patch" && !userApproved) {
    fail("Update blocked by hybrid policy: approval-required (minor-or-major-release)");
  }

  const stageResult = await stageCandidate({ packageName, release, npmRunner });
  if (stageResult?.lockEntry?.integrity !== release.dist.integrity) {
    fail("Staged package integrity does not match the signed manifest");
  }

  const { id } = await writeBackup({
    projectRoot: root,
    packageName,
    candidateVersion: release.version,
    previousVersion: currentVersion,
    previousIntegrity: currentLockEntry.integrity
  });

  try {
    const saveFlag = {
      dependencies: "--save-prod",
      devDependencies: "--save-dev",
      optionalDependencies: "--save-optional"
    }[declared.section];
    const result = npmRunner([
      "install",
      packageName + "@" + release.version,
      saveFlag,
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund"
    ], root);
    assertCommandSuccess(result, "Project npm install");

    const testResult = npmRunner(["test"], root);
    assertCommandSuccess(testResult, "Post-install project tests (npm test)");

    const validation = await validatePackageLayout({ installRoot: root, packageName, release });
    if (validation.packageJson.version !== release.version) {
      fail("Installed version does not match the signed manifest after project tests");
    }
    const policy = evaluateHybridUpdate({
      packageName,
      currentVersion,
      candidateVersion: release.version,
      channel: "stable",
      integrityVerified: validation.lockEntry.integrity === release.dist.integrity,
      signatureVerified: manifestVerified,
      compatibilityVerified: nodeMajor >= release.nodeMinMajor,
      testsPassed: true,
      userApproved
    });
    if (!["auto-apply", "apply-after-approval"].includes(policy.decision)) {
      fail("Update blocked by hybrid policy: " + policy.decision + " (" + policy.reason + ")");
    }

    return {
      decision: policy.decision,
      packageName,
      previousVersion: currentVersion,
      installedVersion: release.version,
      backupId: id,
      integrity: release.dist.integrity
    };
  } catch (error) {
    try {
      await restoreBackup({ projectRoot: root, backupId: id, npmRunner });
    } catch (rollbackError) {
      fail("Update failed and automatic rollback also failed. Backup " + id +
        " is retained. Update error: " + (error instanceof Error ? error.message : String(error)) +
        ". Rollback error: " + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)));
    }
    fail("Update failed; previous package.json, lockfile and dependency tree were restored. " +
      (error instanceof Error ? error.message : String(error)));
  }
}

export async function rollbackEngineUpdate({
  backupId,
  projectRoot = process.cwd(),
  npmRunner = runNpm
} = {}) {
  return restoreBackup({ projectRoot, backupId, npmRunner });
}
