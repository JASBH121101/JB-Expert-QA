import {
  applyEngineUpdate,
  buildUpdatePlan,
  loadSignedUpdateManifest,
  rollbackEngineUpdate
} from "./manager.js";

function parseUpdateArgs(tokens) {
  const values = new Map();
  const flags = new Set(["--check", "--approve"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (flags.has(token)) {
      if (values.has(token)) throw new TypeError(token + " was supplied more than once");
      values.set(token, true);
      continue;
    }
    const equals = token.indexOf("=");
    const key = equals >= 0 ? token.slice(0, equals) : token;
    if (!["--manifest", "--signature", "--public-key", "--apply", "--rollback"].includes(key)) {
      throw new TypeError("Unknown update option: " + token);
    }
    if (values.has(key)) throw new TypeError(key + " was supplied more than once");
    const value = equals >= 0 ? token.slice(equals + 1) : tokens[++index];
    if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
      throw new TypeError(key + " requires a value");
    }
    values.set(key, value.trim());
  }
  return values;
}

function printPlan(plan, print) {
  if (!plan.length) {
    print("No JB engine package is declared directly in this project.");
    return;
  }
  for (const item of plan) {
    print([
      item.packageName,
      item.currentVersion ?? "not installed",
      "->",
      item.candidateVersion,
      "|",
      item.status,
      "|",
      item.decision
    ].join(" "));
  }
}

export async function runUpdateCommand(tokens = [], {
  cwd = process.cwd(),
  env = process.env,
  print = console.log
} = {}) {
  const options = parseUpdateArgs(tokens);
  const modes = ["--check", "--apply", "--rollback"].filter((key) => options.has(key));
  if (modes.length > 1) throw new TypeError("Choose only one of --check, --apply or --rollback");

  if (options.has("--rollback")) {
    if (options.has("--manifest") || options.has("--signature") || options.has("--public-key") ||
        options.has("--approve")) {
      throw new TypeError("Rollback does not accept manifest, signature, public-key or approval options");
    }
    const result = await rollbackEngineUpdate({
      backupId: options.get("--rollback"),
      projectRoot: cwd
    });
    print("Rollback complete: " + result.packageName + " restored using backup " + result.backupId);
    return result;
  }

  const manifestSource = options.get("--manifest");
  if (!manifestSource) {
    throw new TypeError("Update checks require --manifest <file-or-HTTPS-URL>; no release channel is configured yet");
  }
  const verified = await loadSignedUpdateManifest({
    manifest: manifestSource,
    signature: options.get("--signature"),
    publicKeyPath: options.get("--public-key"),
    publicKey: env.JB_QA_UPDATE_PUBLIC_KEY
  });
  const plan = await buildUpdatePlan({ projectRoot: cwd, manifest: verified.manifest });

  if (!options.has("--apply")) {
    if (options.has("--approve")) throw new TypeError("--approve is only valid with --apply");
    print("Signed update manifest verified. No project files were changed.");
    printPlan(plan, print);
    return { signatureVerified: verified.signatureVerified, plan };
  }

  const packageName = options.get("--apply");
  const item = plan.find((entry) => entry.packageName === packageName);
  if (!item) throw new TypeError("No installed direct dependency update is available for " + packageName);
  if (item.decision !== "candidate") throw new TypeError("No newer version is available for " + packageName);
  const result = await applyEngineUpdate({
    packageName,
    release: verified.manifest.packages[packageName],
    currentVersion: item.currentVersion,
    projectRoot: cwd,
    manifestVerified: verified.signatureVerified,
    userApproved: options.has("--approve")
  });
  print("Update installed: " + result.packageName + " " + result.previousVersion +
    " -> " + result.installedVersion);
  print("Rollback backup: " + result.backupId);
  return result;
}
