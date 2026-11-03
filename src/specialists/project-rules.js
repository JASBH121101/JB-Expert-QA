function finding(id, title, description, severity, path, recommendation, metadata = {}, line = null) {
  return {
    id, title, description, severity,
    location: line ? path + ":" + line : path,
    recommendation,
    evidence: { path, line, redacted: metadata.valueRedacted === true },
    metadata
  };
}
function commentLine(line) { return /^\s*(?:\/\/|\/\*|\*|#|--)/.test(line); }
function placeholder(value) {
  const text = value.trim().toLowerCase();
  return text.length < 12 ||
    /^(?:example|sample|dummy|fake|test|placeholder|changeme|change_me|redacted|<.*>|\*+|x+)$/i.test(text) ||
    /^(?:your|replace)[_-].+/i.test(text) ||
    /(?:process\.env|import\.meta\.env|env\.[a-z_]+)/i.test(text);
}

export const codeQualityRules = [
  {
    id: "code-quality.file-size",
    specialist: "code-quality",
    evaluate(context) {
      const limit = context.thresholds?.maxFileLines ?? 800;
      return (context.projectFiles ?? []).filter((file) => file.lineCount > limit).map((file) =>
        finding("CODE-SIZE-" + file.path.replace(/[^a-z0-9]+/gi, "-"),
          "Large source file",
          "This file contains " + file.lineCount + " lines, above the configured review threshold of " + limit + ".",
          "medium", file.path,
          "Consider separating unrelated responsibilities into smaller modules.",
          { lineCount: file.lineCount, threshold: limit }));
    }
  },
  {
    id: "code-quality.test-presence",
    specialist: "code-quality",
    evaluate(context) {
      const files = context.projectFiles ?? [];
      const sourceCount = files.filter((file) =>
        /\.(?:[cm]?[jt]sx?|vue|svelte|py|php|java|kt|go|rs)$/i.test(file.path) &&
        !/(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)/i.test(file.path)).length;
      const testCount = files.filter((file) =>
        /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file.path)).length;
      if (!sourceCount || testCount) return [];
      return [finding("CODE-TESTS-001", "No test files detected",
        "The scanned source tree contains code files but no recognizable test or spec files.",
        "low", ".", "Add automated tests for critical business rules, calculations, authentication, and data persistence.",
        { sourceFiles: sourceCount, testFiles: testCount })];
    }
  }
];

export const securityRules = [
  {
    id: "security.hardcoded-credentials",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      const assignment = /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|private[_-]?key|secret)\b\s*[:=]\s*["']([^"']{12,})["']/i;
      const tokenPattern = /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|AIza[0-9A-Za-z_-]{30,}|sk_live_[A-Za-z0-9]{16,})\b/;
      for (const file of context.projectFiles ?? []) {
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (commentLine(line)) continue;
          const assigned = assignment.exec(line);
          const token = tokenPattern.exec(line);
          if ((assigned && !placeholder(assigned[1])) || token) {
            findings.push(finding("SEC-SECRET-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + (index + 1),
              "Possible hardcoded credential",
              "A credential-like value was detected. Its contents are intentionally excluded from this report.",
              "critical", file.path,
              "Remove the value from source control, rotate the credential if it was real, and load it from a managed environment secret.",
              { detector: token ? "known-token-format" : "sensitive-assignment", valueRedacted: true }, index + 1));
          }
        }
      }
      return findings;
    }
  },
  {
    id: "security.dynamic-code",
    specialist: "security",
    evaluate(context) {
      const patterns = [
        { regex: /\beval\s*\(/, label: "Dynamic eval execution", severity: "high" },
        { regex: /\bnew\s+Function\s*\(/, label: "Dynamic Function constructor", severity: "high" },
        { regex: /\.innerHTML\s*=/, label: "Direct HTML injection sink", severity: "medium" },
        { regex: /\binsertAdjacentHTML\s*\(/, label: "HTML insertion API", severity: "medium" },
        { regex: /\bdangerouslySetInnerHTML\b/, label: "React raw HTML rendering", severity: "medium" },
        { regex: /\brejectUnauthorized\s*:\s*false\b/, label: "TLS certificate verification disabled", severity: "high" }
      ];
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (commentLine(line)) continue;
          for (const pattern of patterns) {
            if (!pattern.regex.test(line)) continue;
            findings.push(finding(
              "SEC-CODE-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + (index + 1) + "-" + pattern.label.replace(/[^a-z0-9]+/gi, "-"),
              pattern.label,
              "A potentially unsafe code pattern was detected. Static matching cannot determine whether untrusted input reaches this operation.",
              pattern.severity, file.path,
              "Review the data flow and trust boundary. Prefer safe APIs, contextual output encoding, and verified TLS.",
              { detector: pattern.label, requiresManualReview: true }, index + 1));
          }
        }
      }
      return findings;
    }
  },
  {
    id: "security.local-secret-files",
    specialist: "security",
    evaluate(context) {
      const paths = [...(context.projectScan?.environmentFiles ?? []), ...(context.projectScan?.sensitiveFiles ?? [])];
      return paths.map((path) => finding(
        "SEC-LOCAL-FILE-" + path.replace(/[^a-z0-9]+/gi, "-"),
        "Sensitive local file present",
        "A local environment or credential file was found. Its contents were not opened or copied into the audit report.",
        "medium", path,
        "Confirm the file is excluded from version control and use an example template containing placeholder values instead.",
        { contentsRead: false }));
    }
  }
];

export const dependencyRules = [
  {
    id: "dependencies.floating-versions",
    specialist: "dependencies",
    evaluate(context) {
      const findings = [];
      for (const manifest of context.packageManifests ?? []) {
        if (!manifest.data) continue;
        for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
          for (const [name, version] of Object.entries(manifest.data[section] ?? {})) {
            if (typeof version !== "string" || !/^(?:\*|latest|x)$/i.test(version.trim())) continue;
            findings.push(finding(
              "DEP-FLOAT-" + manifest.path.replace(/[^a-z0-9]+/gi, "-") + "-" + name.replace(/[^a-z0-9]+/gi, "-"),
              "Dependency version is not constrained",
              "Package \"" + name + "\" uses the version specifier \"" + version + "\".",
              "medium", manifest.path,
              "Use a deliberate version range and commit the package manager lockfile for reproducible installs.",
              { packageName: name, specifier: version, section }));
          }
        }
      }
      return findings;
    }
  },
  {
    id: "dependencies.lockfile",
    specialist: "dependencies",
    evaluate(context) {
      const manifests = (context.packageManifests ?? []).filter((item) => item.path === "package.json");
      if (!manifests.length) return [];
      const lockNames = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]);
      const rootLock = (context.projectScan?.lockFiles ?? []).some((path) => lockNames.has(path.split("/").pop()));
      if (rootLock) return [];
      return [finding("DEP-LOCK-001", "No root JavaScript lockfile detected",
        "A root package.json exists, but no npm, pnpm, Yarn, or Bun lockfile was found at the project root.",
        "medium", "package.json",
        "Commit the lockfile for the package manager used by CI and production deployments.",
        { packageManagersChecked: ["npm", "pnpm", "yarn", "bun"] })];
    }
  },
  {
    id: "dependencies.lifecycle-scripts",
    specialist: "dependencies",
    evaluate(context) {
      const findings = [];
      const risky = /(?:\bcurl\b|\bwget\b|powershell|invoke-webrequest|\bbash\s+-c\b|\bsh\s+-c\b|\bnode\s+-e\b)/i;
      for (const manifest of context.packageManifests ?? []) {
        if (!manifest.data?.scripts) continue;
        for (const hook of ["preinstall", "install", "postinstall"]) {
          const command = manifest.data.scripts[hook];
          if (typeof command !== "string" || !risky.test(command)) continue;
          findings.push(finding("DEP-LIFECYCLE-" + hook + "-" + manifest.path.replace(/[^a-z0-9]+/gi, "-"),
            "Review package installation script",
            "The " + hook + " lifecycle script invokes a shell or download utility and should be reviewed before dependency installation.",
            "high", manifest.path,
            "Inspect every command and downloaded artifact; avoid executing remote scripts without pinning and integrity verification.",
            { hook, commandRedacted: true }));
        }
      }
      return findings;
    }
  },
  {
    id: "dependencies.invalid-manifest",
    specialist: "dependencies",
    evaluate(context) {
      return (context.packageManifests ?? []).filter((item) => item.parseError).map((item) =>
        finding("DEP-MANIFEST-" + item.path.replace(/[^a-z0-9]+/gi, "-"),
          "Package manifest could not be parsed",
          "The package manifest is not valid JSON, so dependency metadata could not be analyzed.",
          "high", item.path, "Correct the JSON syntax and rerun the project audit."));
    }
  }
];

export const databaseRules = [
  {
    id: "database.destructive-sql",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const destructive = /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE(?:\s+TABLE)?)\b/i;
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          if (commentLine(lines[index]) || !destructive.test(lines[index])) continue;
          findings.push(finding("DB-DESTRUCTIVE-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + (index + 1),
            "Potentially destructive database migration",
            "A destructive SQL operation was found. The audit cannot determine whether the operation is intentional or whether data has been backed up.",
            "high", file.path,
            "Review the migration, require an explicit approval, verify backups, and test rollback or recovery procedures.",
            { operationReviewRequired: true }, index + 1));
        }
      }
      return findings;
    }
  },
  {
    id: "database.security-definer",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql" || !/\bsecurity\s+definer\b/i.test(file.content)) continue;
        if (/\bset\s+search_path\b/i.test(file.content)) continue;
        findings.push(finding("DB-POSTGRES-001-" + file.path.replace(/[^a-z0-9]+/gi, "-"),
          "SECURITY DEFINER function without an explicit search_path",
          "The SQL file declares SECURITY DEFINER but no explicit SET search_path was found in the file.",
          "high", file.path,
          "Set a trusted search_path on each SECURITY DEFINER function and schema-qualify referenced objects.",
          { database: "postgresql", requiresManualReview: true }));
      }
      return findings;
    }
  },
  {
    id: "database.raw-query",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const unsafe = /\$(?:query|execute)RawUnsafe\s*\(/;
      for (const file of context.projectFiles ?? []) {
        if (!/\.[cm]?[jt]sx?$/i.test(file.path)) continue;
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          if (commentLine(lines[index]) || !unsafe.test(lines[index])) continue;
          findings.push(finding("DB-RAW-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + (index + 1),
            "Unsafe raw database query API",
            "An unsafe raw-query API was detected. Static analysis cannot determine whether all interpolated values are trusted.",
            "high", file.path,
            "Prefer parameterized query APIs and verify that untrusted values cannot alter SQL structure.",
            { requiresManualReview: true }, index + 1));
        }
      }
      return findings;
    }
  }
];

export const projectRules = Object.freeze([
  ...codeQualityRules, ...securityRules, ...dependencyRules, ...databaseRules
]);
