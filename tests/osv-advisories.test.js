import test from "node:test";
import assert from "node:assert/strict";
import { extractNpmDependencies, scanNpmAdvisories } from "../src/adapters/advisories/osv.js";

function npmScan(lock, manifests = []) {
  return {
    files: lock ? [{
      path: "package-lock.json",
      content: JSON.stringify(lock)
    }] : [],
    lockFiles: lock ? ["package-lock.json"] : [],
    manifests
  };
}

test("npm lockfile extraction finds scoped, nested and transitive package versions", () => {
  const scan = npmScan({
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/express": { version: "4.18.2" },
      "node_modules/@scope/widget": { version: "2.1.0" },
      "node_modules/express/node_modules/cookie": { version: "0.5.0" },
      "node_modules/local-link": { link: true, version: "1.0.0" }
    }
  });
  const extracted = extractNpmDependencies(scan);
  assert.equal(extracted.totalPackagesFound, 3);
  assert.deepEqual(extracted.packages.map((item) => item.name), ["@scope/widget", "cookie", "express"]);
  assert.equal(extracted.directOnly, false);
  assert.deepEqual(extracted.supportedLockfiles, ["package-lock.json"]);
});

test("OSV batch lookup returns normalized findings and requests advisory details", async () => {
  const scan = npmScan({
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/express": { version: "4.18.2" },
      "node_modules/lodash": { version: "4.17.21" }
    }
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://api.osv.dev/v1/querybatch") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          results: [
            { vulns: [{ id: "GHSA-test-1234", modified: "2026-01-01T00:00:00Z" }] },
            { vulns: [] }
          ]
        })
      };
    }
    assert.equal(url, "https://api.osv.dev/v1/vulns/GHSA-test-1234");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: "GHSA-test-1234",
        summary: "Test vulnerability in Express",
        modified: "2026-01-02T00:00:00Z",
        severity: [{ type: "CVSS_V3", score: "9.8" }],
        affected: [{
          package: { name: "express", ecosystem: "npm" },
          ranges: [{ events: [{ introduced: "0" }, { fixed: "4.18.3" }] }]
        }],
        references: [{ type: "ADVISORY", url: "https://example.invalid/advisory" }]
      })
    };
  };

  const result = await scanNpmAdvisories(scan, { enabled: true }, { fetchImpl });
  assert.equal(result.status, "complete");
  assert.equal(result.complete, true);
  assert.equal(result.packagesQueried, 2);
  assert.equal(result.vulnerabilitiesFound, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].packageName, "express");
  assert.equal(result.findings[0].installedVersion, "4.18.2");
  assert.equal(result.findings[0].severity, "critical");
  assert.deepEqual(result.findings[0].fixedVersions, ["4.18.3"]);
  assert.equal(result.networkRequests, 2);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].options.body).queries[0].package.ecosystem, "npm");
});

test("pinned direct dependencies are checked but marked partial without a lockfile", async () => {
  const scan = npmScan(null, [{
    path: "package.json",
    data: { dependencies: { express: "4.18.2", unpinned: "^1.0.0" } }
  }]);
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ results: [{ vulns: [] }] })
    };
  };
  const result = await scanNpmAdvisories(scan, { enabled: true }, { fetchImpl });
  assert.equal(result.status, "partial");
  assert.equal(result.complete, false);
  assert.equal(result.directOnly, true);
  assert.equal(result.packagesQueried, 1);
  assert.equal(result.networkRequests, 1);
  assert.match(result.message, /transitive dependencies were not covered/);
});

test("OSV lookup skips unsupported ranges and never calls the network when disabled", async () => {
  const scan = npmScan(null, [{
    path: "package.json",
    data: { dependencies: { express: "^4.18.2" } }
  }]);
  let requests = 0;
  const fetchImpl = async () => { requests += 1; throw new Error("network must not be called"); };
  const disabled = await scanNpmAdvisories(scan, {}, { fetchImpl });
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.networkRequests, 0);
  assert.equal(requests, 0);

  const enabled = await scanNpmAdvisories(scan, { enabled: true }, { fetchImpl });
  assert.equal(enabled.status, "skipped-no-resolved-versions");
  assert.equal(enabled.packagesQueried, 0);
  assert.equal(requests, 0);
});

test("OSV service failures are reported as unavailable, not as a clean scan", async () => {
  const scan = npmScan(null, [{
    path: "package.json",
    data: { dependencies: { express: "4.18.2" } }
  }]);
  const result = await scanNpmAdvisories(scan, { enabled: true }, {
    fetchImpl: async () => { throw new Error("simulated network failure"); }
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.complete, false);
  assert.match(result.error, /simulated network failure/);
  assert.equal(result.vulnerabilitiesFound, 0);
});

test("package and vulnerability caps are reported as partial coverage", async () => {
  const scan = npmScan({
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/alpha": { version: "1.0.0" },
      "node_modules/beta": { version: "2.0.0" }
    }
  });
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      results: [
        { vulns: [{ id: "OSV-ONE" }, { id: "OSV-TWO" }] }
      ]
    })
  });
  const result = await scanNpmAdvisories(scan, {
    enabled: true, maxPackages: 1, maxVulnerabilities: 1
  }, { fetchImpl });
  assert.equal(result.status, "partial");
  assert.equal(result.truncated, true);
  assert.equal(result.packagesQueried, 1);
  assert.equal(result.packagesSkipped, 1);
});
