function finding(id, title, description, severity, path, recommendation, metadata = {}, line = null) {
  return {
    id, title, description, severity,
    location: line ? path + ":" + line : path,
    recommendation,
    evidence: { path, line, redacted: false },
    metadata
  };
}

function isCommentLine(line) {
  return /^\s*(?:\/\/|\/\*|\*|#|--)/.test(line);
}

function lineAt(source, offset) {
  return source.slice(0, offset).split(/\r\n|\n|\r/).length;
}

function fileLabel(path) {
  return path.replace(/[^a-z0-9]+/gi, "-");
}

const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".php", ".py", ".rb", ".java", ".kt", ".go", ".rs", ".cs",
  ".json", ".yml", ".yaml", ".toml", ".sql", ".prisma"
]);

const DATABASE_CONTEXT = /\b(?:database|dataSource|connection|pool|postgres(?:ql)?|mysql|mariadb|sqlite|prisma|sequelize|typeorm|knex|pg\.Pool|queryRunner|sqlalchemy|pdo|mysqli|mongodb)\b/i;

export const operationalDatabaseRules = [
  {
    id: "database.orm-destructive-sync",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const patterns = [
        {
          regex: /\.sync\s*\(\s*\{[^}]*\bforce\s*:\s*true\b/gi,
          title: "ORM schema sync can drop existing data",
          severity: "critical",
          recommendation: "Remove force synchronization from application startup. Use reviewed, versioned migrations and verify a backup before any destructive schema change."
        },
        {
          regex: /\b(?:synchronize|dropSchema)\s*:\s*true\b/gi,
          title: "Automatic ORM schema synchronization is enabled",
          severity: "high",
          recommendation: "Disable automatic schema synchronization in deployed environments and apply reviewed, versioned migrations instead."
        },
        {
          regex: /\.sync\s*\(\s*\{[^}]*\balter\s*:\s*true\b/gi,
          title: "ORM may alter the schema at runtime",
          severity: "medium",
          recommendation: "Avoid runtime schema alteration in production. Generate and review a migration, then apply it through the deployment process."
        }
      ];

      for (const file of context.projectFiles ?? []) {
        if (!CODE_EXTENSIONS.has(file.extension)) continue;
        for (const pattern of patterns) {
          pattern.regex.lastIndex = 0;
          for (const match of file.content.matchAll(pattern.regex)) {
            const line = lineAt(file.content, match.index);
            if (isCommentLine(file.content.split(/\r\n|\n|\r/)[line - 1] ?? "")) continue;
            findings.push(finding(
              "DB-ORM-SYNC-" + fileLabel(file.path) + "-" + line + "-" + pattern.severity,
              pattern.title,
              "An ORM configuration can change or recreate database schema automatically. Static analysis cannot determine which environment executes this code.",
              pattern.severity, file.path, pattern.recommendation,
              { detector: "orm-schema-sync", environmentDependent: true, requiresManualReview: true }, line
            ));
          }
        }
      }
      return findings;
    }
  },
  {
    id: "database.connection-tls",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const patterns = [
        /\brejectUnauthorized\s*:\s*false\b/ig,
        /\bsslmode\s*=\s*disable\b/ig,
        /\bssl\s*:\s*false\b/ig,
        /\b(?:tls|ssl)\s*:\s*\{\s*(?:enabled|rejectUnauthorized)\s*:\s*false\b/ig
      ];

      for (const file of context.projectFiles ?? []) {
        if (!CODE_EXTENSIONS.has(file.extension) || !DATABASE_CONTEXT.test(file.content)) continue;
        for (const pattern of patterns) {
          pattern.lastIndex = 0;
          for (const match of file.content.matchAll(pattern)) {
            const line = lineAt(file.content, match.index);
            if (isCommentLine(file.content.split(/\r\n|\n|\r/)[line - 1] ?? "")) continue;
            findings.push(finding(
              "DB-TLS-" + fileLabel(file.path) + "-" + line,
              "Database TLS verification may be disabled",
              "A database-related configuration appears to disable TLS or certificate verification. Environment-specific configuration may override this value.",
              "high", file.path,
              "Require TLS for remote database connections, keep certificate verification enabled, and trust only the expected database certificate authority.",
              { detector: "database-tls-disabled", requiresManualReview: true }, line
            ));
          }
        }
      }
      return findings;
    }
  },
  {
    id: "database.dynamic-raw-query",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      const rawCall = /\b(?:sequelize|knex|queryRunner|manager|dataSource|connection|pool|client|cursor|db)\s*\.\s*(?:query|execute|raw|exec|prepare)\s*\(|\bDB\s*::\s*(?:select|statement|unprepared|raw)\s*\(|\b(?:mysqli_query|mysql_query|pg_query)\s*\(|->\s*(?:query|exec)\s*\(/ig;
      const dynamicSql = /\x60[^\r\n]*\$\{|\b(?:f|F)['"][^'"\r\n]*\{[A-Za-z_][\w.]*\}|['"][^'"\r\n]{0,500}['"]\s*\+\s*[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*\s*\+\s*['"][^'"\r\n]{0,500}['"]|"[^"\r\n]*\{\$[A-Za-z_][\w$]*\}/;

      for (const file of context.projectFiles ?? []) {
        if (!CODE_EXTENSIONS.has(file.extension)) continue;
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (isCommentLine(line)) continue;
          rawCall.lastIndex = 0;
          const calls = [...line.matchAll(rawCall)];
          if (!calls.length || !dynamicSql.test(line)) continue;
          if (/\$(?:query|execute)RawUnsafe\s*\(/i.test(line)) continue;
          findings.push(finding(
            "DB-RAW-DYNAMIC-" + fileLabel(file.path) + "-" + (index + 1),
            "Raw database query contains dynamic SQL construction",
            "A raw query call and string interpolation or concatenation appear on the same line. This heuristic cannot prove data flow, but the query should be reviewed for SQL injection.",
            "high", file.path,
            "Use parameterized query APIs for every variable value. Do not concatenate untrusted input into SQL identifiers, predicates, or clauses.",
            { detector: "dynamic-raw-query", requiresManualReview: true, heuristic: true }, index + 1
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "database.query-performance-patterns",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        if (file.extension !== ".sql") continue;
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (isCommentLine(line)) continue;

          if (/\bSELECT\s+(?:DISTINCT\s+)?\*\s+FROM\b/i.test(line)) {
            findings.push(finding(
              "DB-PERF-SELECT-STAR-" + fileLabel(file.path) + "-" + (index + 1),
              "SQL query selects every column",
              "SELECT * can transfer unused columns and make result contracts sensitive to schema changes. Treat this as a review hint, not a correctness failure.",
              "low", file.path,
              "Select only the columns required by the caller and compare query plans and transferred row size before changing the query.",
              { detector: "select-star", heuristic: true }, index + 1
            ));
          }

          if (/\b(?:NOT\s+)?(?:LIKE|ILIKE)\s*(['"])\s*%/i.test(line)) {
            findings.push(finding(
              "DB-PERF-LEADING-WILDCARD-" + fileLabel(file.path) + "-" + (index + 1),
              "Leading wildcard may prevent a normal index lookup",
              "A LIKE/ILIKE pattern begins with a wildcard. A conventional B-tree index generally cannot support this prefix search efficiently.",
              "medium", file.path,
              "Review EXPLAIN/EXPLAIN ANALYZE with representative data. Consider full-text search, trigram indexes, or a search-specific index where supported.",
              { detector: "leading-wildcard-like", heuristic: true }, index + 1
            ));
          }
        }
      }
      return findings;
    }
  },
  {
    id: "database.migration-reversibility",
    specialist: "database",
    evaluate(context) {
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        if (!/\.(?:php|[cm]?[jt]s)$/i.test(file.path) ||
            !/(?:^|\/)(?:migrations?|database)(?:\/|$)/i.test(file.path)) continue;
        const up = /\b(?:public\s+)?(?:async\s+)?up\s*\(/i.exec(file.content);
        if (!up || /\b(?:public\s+)?(?:async\s+)?down\s*\(/i.test(file.content)) continue;
        const line = lineAt(file.content, up.index);
        findings.push(finding(
          "DB-MIGRATION-DOWN-" + fileLabel(file.path) + "-" + line,
          "Migration has no visible rollback method",
          "An up migration was found without a matching down method in this file. Some changes are intentionally irreversible, but recovery should be explicitly designed.",
          "medium", file.path,
          "Add a tested rollback operation where safe, or document the deliberate one-way migration and its recovery procedure.",
          { detector: "migration-reversibility", heuristic: true, requiresManualReview: true }, line
        ));
      }
      return findings;
    }
  }
];
