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
        if (file.extension !== ".sql") continue;
        for (const statement of sqlStatements(file.content)) {
          if (!/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.test(statement.text) ||
              !/\bSECURITY\s+DEFINER\b/i.test(statement.text)) continue;
          const asMatch = /\bAS\s+(?:\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$|')/i.exec(statement.text);
          const declaration = asMatch ? statement.text.slice(0, asMatch.index) : statement.text;
          if (/\bSET\s+search_path\b/i.test(declaration)) continue;
          const line = statementLine(file.content, statement);
          findings.push(finding("DB-POSTGRES-001-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "SECURITY DEFINER function without an explicit search_path",
            "This SECURITY DEFINER function declaration has no explicit SET search_path before its function body. Another function in the same file does not satisfy this check.",
            "high", file.path,
            "Set a trusted search_path on this function and schema-qualify referenced objects.",
            { database: "postgresql", requiresManualReview: true }, line));
        }
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


function sqlStatements(content) {
  const statements = [];
  let start = 0;
  let index = 0;
  let text = "";

  const push = (end) => {
    if (text.trim()) statements.push({ text, offset: start });
    text = "";
    start = end;
  };

  while (index < content.length) {
    if (content.startsWith("--", index)) {
      while (index < content.length && content[index] !== "\n" && content[index] !== "\r") {
        text += " ";
        index += 1;
      }
      continue;
    }

    if (content.startsWith("/*", index)) {
      let depth = 1;
      text += "  ";
      index += 2;
      while (index < content.length && depth > 0) {
        if (content.startsWith("/*", index)) {
          depth += 1;
          text += "  ";
          index += 2;
        } else if (content.startsWith("*/", index)) {
          depth -= 1;
          text += "  ";
          index += 2;
        } else {
          const current = content[index++];
          text += current === "\n" || current === "\r" ? current : " ";
        }
      }
      continue;
    }

    const current = content[index];
    if (current === "'" || current === '"') {
      const quote = current;
      text += current;
      index += 1;
      while (index < content.length) {
        const value = content[index++];
        text += value;
        if (value === quote) {
          if (content[index] === quote) {
            text += content[index++];
            continue;
          }
          break;
        }
        if (value === "\\" && index < content.length) text += content[index++];
      }
      continue;
    }

    if (current === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(content.slice(index))?.[0];
      if (tag) {
        text += tag;
        index += tag.length;
        const closing = content.indexOf(tag, index);
        if (closing < 0) {
          text += content.slice(index);
          index = content.length;
        } else {
          text += content.slice(index, closing + tag.length);
          index = closing + tag.length;
        }
        continue;
      }
    }

    if (current === ";") {
      push(index + 1);
      index += 1;
      continue;
    }

    text += current;
    index += 1;
  }

  push(content.length);
  return statements;
}

function sqlIdentifier(value) {
  return value.trim().replace(/"/g, "").replace(/\s+/g, "").toLowerCase();
}

function sqlColumns(value) {
  return value.split(",").map((part) => {
    const match = part.trim().match(/^"?([A-Za-z_][A-Za-z0-9_$]*)"?/);
    return match?.[1]?.toLowerCase() ?? null;
  }).filter(Boolean);
}

function tableKeyFromStatement(statement) {
  const match = /\b(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:ONLY\s+)?)(("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?)/i.exec(statement);
  return match ? sqlIdentifier(match[1]) : null;
}

function sourceLine(content, offset) {
  return content.slice(0, offset).split(/\r\n|\n|\r/).length;
}

function statementLine(content, statement) {
  const leadingWhitespace = statement.text.match(/^\s*/)?.[0].length ?? 0;
  return sourceLine(content, statement.offset + leadingWhitespace);
}

export const postgresPrismaRules = [
  {
    id: "database.prisma-relation-index",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const modelPattern = /(?:^|\n)[ \t]*model[ \t]+([A-Za-z_]\w*)[ \t]*\{([\s\S]*?)^[ \t]*\}/gm;
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".prisma") continue;
        for (const modelMatch of file.content.matchAll(modelPattern)) {
          const modelName = modelMatch[1];
          const body = modelMatch[2];
          const modelStart = modelMatch.index + modelMatch[0].indexOf("{") + 1;
          const safeBody = body
            .replace(/\/\/[^\r\n]*/g, "")
            .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\r\n]/g, " "));
          const indexed = new Set();
          for (const indexMatch of safeBody.matchAll(/@@(?:index|unique)\s*\(\s*\[([^\]]+)\]/g)) {
            const firstField = indexMatch[1].split(",")[0].trim().match(/^[A-Za-z_]\w*/)?.[0];
            if (firstField) indexed.add(firstField);
          }
          const singleColumnUnique = new Set();
          for (const line of safeBody.split(/\r\n|\n|\r/)) {
            const field = line.match(/^\s*([A-Za-z_]\w*)\s+\S+[^@\r\n]*(?:@id|@unique)\b/);
            if (field) singleColumnUnique.add(field[1]);
          }
          const reported = new Set();
          const relationPattern = /@relation\s*\(([\s\S]*?)\)/g;
          for (const relationMatch of safeBody.matchAll(relationPattern)) {
            const fieldsMatch = relationMatch[1].match(/\bfields\s*:\s*\[([^\]]+)\]/);
            if (!fieldsMatch) continue;
            const foreignKeys = fieldsMatch[1].split(",").map((value) => value.trim()).filter(Boolean);
            for (const foreignKey of foreignKeys) {
              const fieldName = foreignKey.match(/^[A-Za-z_]\w*/)?.[0];
              if (!fieldName || reported.has(fieldName)) continue;
              if (indexed.has(fieldName) || singleColumnUnique.has(fieldName)) continue;
              reported.add(fieldName);
              const absoluteOffset = modelStart + relationMatch.index;
              const line = sourceLine(file.content, absoluteOffset);
              findings.push(finding(
                "DB-PRISMA-INDEX-" + modelName + "-" + fieldName,
                "Prisma relation field may lack a supporting index",
                "Model " + modelName + " uses " + fieldName + " as a relation scalar field, but no single-column unique constraint or index with that field as its leading column was detected.",
                "medium", file.path,
                "Review query patterns and add @@index([" + fieldName + "]) when appropriate. Composite indexes only support lookups efficiently when this field is a leading column.",
                { database: "postgresql", model: modelName, foreignKeyField: fieldName, heuristic: true }, line
              ));
            }
          }
        }
      }
      return findings;
    }
  },
  {
    id: "database.public-broad-grants",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        for (const statement of sqlStatements(file.content)) {
          const broadAll = /\bGRANT\s+ALL(?:\s+PRIVILEGES)?\b[\s\S]*?\bTO\s+PUBLIC\b/i.test(statement.text);
          const schemaCreate = /\bGRANT\s+CREATE\s+ON\s+SCHEMA\b[\s\S]*?\bTO\s+PUBLIC\b/i.test(statement.text);
          if (!broadAll && !schemaCreate) continue;
          const line = statementLine(file.content, statement);
          findings.push(finding(
            "DB-PUBLIC-GRANT-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "Broad PostgreSQL privileges granted to PUBLIC",
            "A SQL grant gives all privileges or schema creation rights to the PUBLIC role, potentially exposing database capabilities to every database role.",
            "high", file.path,
            "Restrict the grant to the minimum required application or maintenance role and verify the effective privileges after migration.",
            { database: "postgresql", grantee: "PUBLIC", requiresManualReview: true }, line
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "database.privileged-role-attributes",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const privileged = /\b(?:SUPERUSER|BYPASSRLS|CREATEROLE|REPLICATION)\b/i;
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        for (const statement of sqlStatements(file.content)) {
          if (!/\b(?:CREATE|ALTER)\s+(?:ROLE|USER)\b/i.test(statement.text) || !privileged.test(statement.text)) continue;
          const line = statementLine(file.content, statement);
          findings.push(finding(
            "DB-PRIVILEGED-ROLE-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "Privileged PostgreSQL role attribute detected",
            "A role definition changes a high-privilege attribute such as SUPERUSER, BYPASSRLS, CREATEROLE, or REPLICATION.",
            "high", file.path,
            "Verify that the role is a tightly controlled administrative identity and that application runtime roles do not receive unnecessary elevated attributes.",
            { database: "postgresql", requiresManualReview: true }, line
          ));
        }
      }
      return findings;
    }
  }
];

export const postgresMigrationRules = [
  {
    id: "database.foreign-key-index",
    specialist: "database",
    evaluate(context) {
      const sqlFiles = (context.projectFiles ?? []).filter((file) => file.extension === ".sql");
      const statements = sqlFiles.flatMap((file) =>
        sqlStatements(file.content).map((statement) => ({ ...statement, file })));
      const indexes = [];

      for (const item of statements) {
        const createIndex = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(?:ONLY\s+)?(("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?)\s*(?:USING\s+\w+\s*)?\(([^)]+)\)/i.exec(item.text);
        if (createIndex) {
          indexes.push({ table: sqlIdentifier(createIndex[1]), columns: sqlColumns(createIndex[4]) });
        }

        const table = tableKeyFromStatement(item.text);
        if (!table) continue;
        if (/^\s*CREATE\s+TABLE\b/i.test(item.text)) {
          for (const constraint of item.text.matchAll(/\b(?:PRIMARY\s+KEY|UNIQUE)\s*\(([^)]+)\)/gi)) {
            indexes.push({ table, columns: sqlColumns(constraint[1]) });
          }
        } else if (/^\s*ALTER\s+TABLE\b/i.test(item.text)) {
          for (const constraint of item.text.matchAll(/\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|UNIQUE)\s*\(([^)]+)\)/gi)) {
            indexes.push({ table, columns: sqlColumns(constraint[1]) });
          }
        }
      }

      const findings = [];
      for (const item of statements) {
        const table = tableKeyFromStatement(item.text);
        if (!table || !/^\s*(?:CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(item.text)) continue;
        const foreignKeys = [...item.text.matchAll(/\bFOREIGN\s+KEY\s*\(([^)]+)\)/gi)]
          .map((match) => ({ columns: sqlColumns(match[1]), offset: match.index }));
        if (/^\s*CREATE\s+TABLE\b/i.test(item.text)) {
          for (const match of item.text.matchAll(/^[ \t]*(?!(?:CONSTRAINT|FOREIGN|PRIMARY|UNIQUE|CHECK)\b)("?[\w$]+"?)[ \t]+[^,\r\n]*\bREFERENCES\b/gim)) {
            foreignKeys.push({ columns: sqlColumns(match[1]), offset: match.index });
          }
        }

        for (const foreignKey of foreignKeys) {
          const columns = foreignKey.columns;
          if (!columns.length) continue;
          const indexed = indexes.some((index) =>
            index.table === table &&
            index.columns.length >= columns.length &&
            columns.every((column, position) => index.columns[position] === column));
          if (indexed) continue;

          const line = sourceLine(item.file.content, item.offset + foreignKey.offset);
          findings.push(finding(
            "DB-FK-INDEX-" + item.file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "Foreign key may lack a supporting index",
            "The referencing columns (" + columns.join(", ") + ") have no matching index with the same leading column order among the scanned SQL files. PostgreSQL does not automatically create an index on referencing columns.",
            "medium", item.file.path,
            "Review join and delete/update patterns; add an index on the referencing columns in the same order when query workload and write costs justify it.",
            { database: "postgresql", table, foreignKeyColumns: columns, heuristic: true }, line
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "database.concurrent-index-transaction",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        const statements = sqlStatements(file.content);
        const hasExplicitTransaction = statements.some((item) =>
          /^\s*(?:BEGIN|START\s+TRANSACTION)\b/i.test(item.text));
        if (!hasExplicitTransaction) continue;

        for (const statement of statements) {
          if (!/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement.text)) continue;
          const line = statementLine(file.content, statement);
          findings.push(finding(
            "DB-CONCURRENT-INDEX-" + file.path.replace(/[^a-z0-9]+/gi, "-") + "-" + line,
            "CREATE INDEX CONCURRENTLY appears inside an explicit transaction",
            "PostgreSQL does not allow CREATE INDEX CONCURRENTLY to run inside a transaction block, while this migration file contains an explicit transaction boundary.",
            "high", file.path,
            "Move the concurrent index operation into a migration step that runs outside a transaction, or use a regular index build only when the locking impact is acceptable.",
            { database: "postgresql", requiresMigrationReview: true }, line
          ));
        }
      }
      return findings;
    }
  }
];

export const projectRules = Object.freeze([
  ...codeQualityRules, ...securityRules, ...dependencyRules, ...databaseRules, ...postgresPrismaRules,
  ...postgresMigrationRules
]);
