const NPM_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const OSV_QUERY_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns/";
const SEMVER_EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function packageNameFromLocation(location) {
  const parts = location.split("/");
  const index = parts.lastIndexOf("node_modules");
  if (index < 0 || index + 1 >= parts.length) return null;
  if (parts[index + 1].startsWith("@")) {
    return parts[index + 2] ? parts[index + 1] + "/" + parts[index + 2] : null;
  }
  return parts[index + 1];
}

function addPackage(target, name, version, source) {
  if (typeof name !== "string" || !name.trim() ||
      typeof version !== "string" || !SEMVER_EXACT.test(version.trim())) return;
  const normalizedName = name.trim();
  const normalizedVersion = version.trim();
  const key = normalizedName + "@" + normalizedVersion;
  if (!target.has(key)) {
    target.set(key, { name: normalizedName, version: normalizedVersion, source });
  }
}

function readNpmLock(lock) {
  const packages = new Map();
  if (lock && lock.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages)) {
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (!location || !entry || entry.link === true) continue;
      const name = entry.name || packageNameFromLocation(location);
      addPackage(packages, name, entry.version, "lockfile");
    }
    return [...packages.values()];
  }

  function visit(dependencies, parent = "") {
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return;
    for (const [name, entry] of Object.entries(dependencies)) {
      if (!entry || typeof entry !== "object") continue;
      addPackage(packages, entry.name || name, entry.version, "lockfile");
      visit(entry.dependencies, parent + name + "/");
    }
  }
  visit(lock?.dependencies);
  return [...packages.values()];
}

export function extractNpmDependencies(scan, { maxPackages = 1000 } = {}) {
  const packages = new Map();
  const supportedLockfiles = [];
  const invalidLockfiles = [];
  const unsupportedLockfiles = [];
  let lockfileCount = 0;

  for (const file of scan?.files ?? []) {
    const name = file.path.split("/").pop();
    if (!NPM_LOCKFILES.has(name) &&
        ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].includes(name)) {
      unsupportedLockfiles.push(file.path);
      continue;
    }
    if (!NPM_LOCKFILES.has(name)) continue;
    lockfileCount += 1;
    try {
      const lock = JSON.parse(file.content);
      const entries = readNpmLock(lock);
      supportedLockfiles.push(file.path);
      for (const entry of entries) addPackage(packages, entry.name, entry.version, file.path);
    } catch {
      invalidLockfiles.push(file.path);
    }
  }

  let directOnly = false;
  if (lockfileCount === 0) {
    directOnly = true;
    for (const manifest of scan?.manifests ?? []) {
      if (manifest.path !== "package.json" || !manifest.data) continue;
      for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries(manifest.data[section] ?? {})) {
          addPackage(packages, name, version, "pinned-manifest");
        }
      }
    }
  }

  const allPackages = [...packages.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const truncated = allPackages.length > maxPackages;
  return Object.freeze({
    packages: Object.freeze(allPackages.slice(0, maxPackages)),
    totalPackagesFound: allPackages.length,
    supportedLockfiles: Object.freeze(supportedLockfiles),
    unsupportedLockfiles: Object.freeze(unsupportedLockfiles),
    invalidLockfiles: Object.freeze(invalidLockfiles),
    directOnly,
    truncated
  });
}

function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  return Promise.all(workers).then(() => results);
}

function severityFromVulnerability(vulnerability) {
  const labels = [
    vulnerability?.database_specific?.severity,
    ...(vulnerability?.affected ?? []).map((item) => item?.ecosystem_specific?.severity)
  ].filter((value) => typeof value === "string").map((value) => value.toLowerCase());
  const known = labels.find((value) => ["critical", "high", "moderate", "medium", "low"].includes(value));
  if (known) return known === "moderate" ? "medium" : known;

  for (const item of vulnerability?.severity ?? []) {
    const score = Number(item?.score);
    if (!Number.isFinite(score)) continue;
    if (score >= 9) return "critical";
    if (score >= 7) return "high";
    if (score >= 4) return "medium";
    return "low";
  }
  return "medium";
}

function fixedVersions(vulnerability) {
  const values = [];
  for (const affected of vulnerability?.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (typeof event.fixed === "string" && event.fixed) values.push(event.fixed);
      }
    }
  }
  return [...new Set(values)].slice(0, 8);
}

async function requestJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error("OSV.dev returned HTTP " + response.status);
    const text = await response.text();
    if (text.length > 8_000_000) throw new Error("OSV.dev response exceeded the 8 MB safety limit");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("OSV.dev returned invalid JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function scanNpmAdvisories(scan, options = {}, { fetchImpl = globalThis.fetch } = {}) {
  const settings = {
    enabled: options.enabled ?? false,
    required: options.required ?? false,
    maxPackages: options.maxPackages ?? 1000,
    batchSize: options.batchSize ?? 100,
    maxVulnerabilities: options.maxVulnerabilities ?? 200,
    timeoutMs: options.timeoutMs ?? 8000
  };
  if (!settings.enabled) {
    return Object.freeze({
      enabled: false, provider: "OSV.dev", status: "disabled", complete: false,
      packagesDiscovered: 0, packagesQueried: 0, vulnerabilitiesFound: 0,
      networkRequests: 0, findings: Object.freeze([]), truncated: false
    });
  }

  const extracted = extractNpmDependencies(scan, { maxPackages: settings.maxPackages });
  const packages = extracted.packages;
  const findings = [];
  const advisoryMap = new Map();
  let networkRequests = 0;
  let detailErrors = 0;
  let queryError = null;
  let truncated = extracted.truncated;

  if (!packages.length) {
    const hasLock = (scan?.lockFiles ?? []).length > 0;
    const status = extracted.invalidLockfiles.length ? "partial" :
      extracted.unsupportedLockfiles.length || hasLock ? "unsupported-lockfile" : "skipped-no-resolved-versions";
    return Object.freeze({
      enabled: true, required: settings.required, provider: "OSV.dev", ecosystem: "npm",
      status, complete: false, directOnly: extracted.directOnly,
      packagesDiscovered: extracted.totalPackagesFound, packagesQueried: 0,
      packagesSkipped: 0, vulnerabilitiesFound: 0, networkRequests: 0,
      supportedLockfiles: extracted.supportedLockfiles,
      unsupportedLockfiles: extracted.unsupportedLockfiles,
      invalidLockfiles: extracted.invalidLockfiles,
      findings: Object.freeze([]), truncated: false,
      message: "No exact npm package versions were available for advisory lookup."
    });
  }

  if (typeof fetchImpl !== "function") {
    return Object.freeze({
      enabled: true, required: settings.required, provider: "OSV.dev", ecosystem: "npm",
      status: "unavailable", complete: false, directOnly: extracted.directOnly,
      packagesDiscovered: extracted.totalPackagesFound, packagesQueried: 0,
      vulnerabilitiesFound: 0, networkRequests: 0, findings: Object.freeze([]),
      truncated, error: "Fetch is not available in this Node.js runtime."
    });
  }

  try {
    for (let offset = 0; offset < packages.length; offset += settings.batchSize) {
      const batch = packages.slice(offset, offset + settings.batchSize);
      const queries = batch.map((item) => ({
        package: { name: item.name, ecosystem: "npm" },
        version: item.version
      }));
      let active = queries.map((query, index) => ({ query, index }));
      const perPackage = batch.map(() => new Map());
      let page = 0;

      while (active.length && page < 10) {
        networkRequests += 1;
        const payload = await requestJson(fetchImpl, OSV_QUERY_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ queries: active.map((item) => item.query) })
        }, settings.timeoutMs);
        if (!Array.isArray(payload.results) || payload.results.length !== active.length) {
          throw new Error("OSV.dev batch response did not match the submitted package count");
        }

        const next = [];
        for (let index = 0; index < payload.results.length; index += 1) {
          const result = payload.results[index] ?? {};
          const originalIndex = active[index].index;
          for (const vulnerability of result.vulns ?? []) {
            if (typeof vulnerability?.id !== "string") continue;
            perPackage[originalIndex].set(vulnerability.id, vulnerability.modified ?? null);
          }
          if (typeof result.next_page_token === "string" && result.next_page_token) {
            next.push({
              index: originalIndex,
              query: { ...queries[originalIndex], page_token: result.next_page_token }
            });
          }
        }
        active = next;
        page += 1;
      }
      if (active.length) truncated = true;

      for (let index = 0; index < batch.length; index += 1) {
        for (const [id, modified] of perPackage[index]) {
          if (!advisoryMap.has(id)) advisoryMap.set(id, []);
          advisoryMap.get(id).push({
            package: batch[index],
            modified
          });
        }
      }
    }
  } catch (error) {
    queryError = error instanceof Error ? error.message : String(error);
  }

  if (queryError) {
    return Object.freeze({
      enabled: true, required: settings.required, provider: "OSV.dev", ecosystem: "npm",
      status: "unavailable", complete: false, directOnly: extracted.directOnly,
      packagesDiscovered: extracted.totalPackagesFound, packagesQueried: packages.length,
      packagesSkipped: Math.max(0, extracted.totalPackagesFound - packages.length),
      vulnerabilitiesFound: 0, networkRequests, findings: Object.freeze([]),
      truncated, supportedLockfiles: extracted.supportedLockfiles,
      unsupportedLockfiles: extracted.unsupportedLockfiles,
      invalidLockfiles: extracted.invalidLockfiles,
      error: queryError
    });
  }

  const advisoryIds = [...advisoryMap.keys()];
  if (advisoryIds.length > settings.maxVulnerabilities) truncated = true;
  const selectedIds = advisoryIds.slice(0, settings.maxVulnerabilities);
  const details = await mapLimit(selectedIds, 6, async (id) => {
    try {
      networkRequests += 1;
      return await requestJson(fetchImpl, OSV_VULN_URL + encodeURIComponent(id), {
        method: "GET",
        headers: { accept: "application/json" }
      }, settings.timeoutMs);
    } catch {
      detailErrors += 1;
      return { id, summary: "Advisory details could not be retrieved", detailsUnavailable: true };
    }
  });

  for (let index = 0; index < selectedIds.length; index += 1) {
    const id = selectedIds[index];
    const vulnerability = details[index] ?? { id, summary: "Advisory details unavailable" };
    const matches = advisoryMap.get(id) ?? [];
    for (const match of matches) {
      const fixed = fixedVersions(vulnerability);
      findings.push({
        id,
        summary: String(vulnerability.summary || vulnerability.details || "Known vulnerability").split(/\r?\n/)[0].slice(0, 280),
        severity: severityFromVulnerability(vulnerability),
        packageName: match.package.name,
        installedVersion: match.package.version,
        fixedVersions: fixed,
        modified: vulnerability.modified ?? match.modified ?? null,
        references: (vulnerability.references ?? []).map((item) => item?.url).filter((url) =>
          typeof url === "string" && /^https?:\/\//i.test(url)).slice(0, 5),
        detailsUnavailable: vulnerability.detailsUnavailable === true
      });
    }
  }

  const unsupported = extracted.unsupportedLockfiles.length > 0 || extracted.invalidLockfiles.length > 0;
  const complete = !truncated && detailErrors === 0 && !unsupported && !extracted.directOnly;
  const status = complete ? "complete" : "partial";
  return Object.freeze({
    enabled: true, required: settings.required, provider: "OSV.dev", ecosystem: "npm",
    status, complete, directOnly: extracted.directOnly,
    packagesDiscovered: extracted.totalPackagesFound, packagesQueried: packages.length,
    packagesSkipped: Math.max(0, extracted.totalPackagesFound - packages.length),
    vulnerabilitiesFound: selectedIds.length,
    vulnerablePackageVersions: findings.length,
    networkRequests,
    supportedLockfiles: extracted.supportedLockfiles,
    unsupportedLockfiles: extracted.unsupportedLockfiles,
    invalidLockfiles: extracted.invalidLockfiles,
    truncated, detailErrors,
    findings: Object.freeze(findings.map((item) => Object.freeze(item))),
    message: extracted.directOnly
      ? "Only exact direct dependency versions were checked because no supported npm lockfile was found; transitive dependencies were not covered."
      : unsupported
        ? "One or more lockfiles could not be analyzed; advisory coverage is partial."
        : truncated
          ? "The advisory result was capped to the configured package, page, or vulnerability limit."
          : detailErrors
            ? "Some advisory records could not be expanded; affected package IDs are retained with reduced detail."
            : null
  });
}
