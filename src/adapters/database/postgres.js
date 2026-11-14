const DEFAULTS = Object.freeze({
  connectionTimeoutMs: 5000,
  statementTimeoutMs: 5000,
  lockTimeoutMs: 1000
});

const SQL = Object.freeze({
  metadata: `/* jb-expert-qa:metadata */
    SELECT current_database() AS database_name,
           current_user AS audit_role,
           current_setting('server_version') AS server_version,
           current_setting('transaction_read_only') AS transaction_read_only`,
  tables: `/* jb-expert-qa:tables */
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           c.relkind,
           GREATEST(COALESCE(c.reltuples::bigint, 0), 0) AS estimated_rows,
           pg_catalog.pg_total_relation_size(c.oid)::bigint AS total_bytes,
           c.relrowsecurity AS row_level_security,
           c.relforcerowsecurity AS force_row_level_security,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_constraint pk
             WHERE pk.conrelid = c.oid AND pk.contype = 'p'
           ) AS has_primary_key
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND left(n.nspname, 3) <> 'pg_'
    ORDER BY n.nspname, c.relname`,
  constraints: `/* jb-expert-qa:constraints */
    SELECT n.nspname AS schema_name,
           t.relname AS table_name,
           con.conname AS constraint_name,
           con.contype AS constraint_type,
           con.convalidated AS is_validated,
           con.condeferrable AS is_deferrable,
           CASE WHEN con.contype = 'f' THEN ARRAY(
             SELECT a.attname::text
             FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, position)
             JOIN pg_catalog.pg_attribute a
               ON a.attrelid = con.conrelid AND a.attnum = k.attnum
             ORDER BY k.position
           ) ELSE ARRAY[]::text[] END AS columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND left(n.nspname, 3) <> 'pg_'
    ORDER BY n.nspname, t.relname, con.conname`,
  indexes: `/* jb-expert-qa:indexes */
    SELECT n.nspname AS schema_name,
           t.relname AS table_name,
           i.relname AS index_name,
           ix.indisvalid AS is_valid,
           ix.indisready AS is_ready,
           ix.indisunique AS is_unique,
           ix.indisprimary AS is_primary,
           (ix.indpred IS NOT NULL) AS is_partial,
           pg_catalog.pg_get_expr(ix.indpred, ix.indrelid) AS index_predicate,
           ARRAY(
             SELECT CASE WHEN k.attnum > 0 THEN a.attname::text ELSE NULL END
             FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY AS k(attnum, position)
             LEFT JOIN pg_catalog.pg_attribute a
               ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
             WHERE k.position <= ix.indnkeyatts
             ORDER BY k.position
           ) AS key_columns
    FROM pg_catalog.pg_index ix
    JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
    JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND left(n.nspname, 3) <> 'pg_'
    ORDER BY n.nspname, t.relname, i.relname`,
  policies: `/* jb-expert-qa:policies */
    SELECT schemaname AS schema_name,
           tablename AS table_name,
           policyname AS policy_name,
           roles,
           cmd AS command
    FROM pg_catalog.pg_policies
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      AND left(schemaname, 3) <> 'pg_'
    ORDER BY schemaname, tablename, policyname`,
  role: `/* jb-expert-qa:role */
    SELECT rolsuper AS is_superuser,
           rolcreatedb AS can_create_database,
           rolcreaterole AS can_create_role,
           rolreplication AS can_replicate,
           rolbypassrls AS bypasses_rls
    FROM pg_catalog.pg_roles
    WHERE rolname = current_user`,
  stats: `/* jb-expert-qa:stats */
    SELECT schemaname AS schema_name,
           relname AS table_name,
           seq_scan,
           idx_scan,
           n_live_tup,
           n_dead_tup,
           last_analyze,
           last_autoanalyze
    FROM pg_catalog.pg_stat_user_tables
    ORDER BY schemaname, relname`,
  extensions: `/* jb-expert-qa:extensions */
    SELECT extname AS extension_name, extversion AS version
    FROM pg_catalog.pg_extension
    ORDER BY extname`
});

function dbBool(value) {
  return value === true || value === 1 || value === "1" ||
    value === "t" || value === "true" || value === "on";
}

function partialIndexSupportsForeignKey(index, foreignKeyColumns) {
  if (!dbBool(index.is_partial)) return true;

  // A partial index limited only to non-null values of one FK column
  // still covers every row that can reference a parent key.
  const predicate = String(index.index_predicate ?? "").trim();
  const match = predicate.match(
    /^\(?\s*(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))\s+IS\s+NOT\s+NULL\s*\)?$/i
  );
  if (!match) return false;

  const predicateColumn = match[1]
    ? match[1].replace(/""/g, '"')
    : match[2].toLowerCase();

  return foreignKeyColumns.includes(predicateColumn);
}

function rowsOf(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function safeConnectionConfig(connectionString, options) {
  if (typeof connectionString !== "string" || !connectionString.trim()) {
    throw new TypeError("A PostgreSQL connection string is required.");
  }

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new TypeError("The PostgreSQL connection string is invalid.");
  }

  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname || !url.pathname || url.pathname === "/") {
    throw new TypeError("A valid postgres:// or postgresql:// URL with host and database is required.");
  }

  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("The PostgreSQL port is invalid.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const sslMode = url.searchParams.get("sslmode")?.toLowerCase() ?? null;
  if (sslMode === "disable" && !isLoopback) {
    throw new TypeError("TLS cannot be disabled for non-loopback PostgreSQL connections.");
  }

  return {
    host: hostname,
    port,
    database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: options.connectionTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs + 1000,
    application_name: "jb-expert-qa-read-only"
  };
}

export async function createPostgresClient(input = {}) {
  const config = typeof input?.host === "string" && typeof input?.database === "string"
    ? input
    : safeConnectionConfig(input.connectionString, {
      ...DEFAULTS,
      ...(input.options ?? {})
    });

  let pg;
  try {
    pg = await import("pg");
  } catch {
    throw new Error("The optional PostgreSQL driver 'pg' is not installed. Install pg locally before running a live database audit.");
  }

  const Client = pg.Client ?? pg.default?.Client;
  if (typeof Client !== "function") {
    throw new Error("The installed PostgreSQL driver does not expose Client.");
  }

  return new Client(config);
}

function finding(id, title, severity, description, recommendation, location = null, metadata = {}) {
  return {
    id,
    specialist: "database",
    title,
    severity,
    description,
    recommendation,
    location,
    evidence: metadata,
    metadata
  };
}

function buildReport(snapshot) {
  const diagnostics = [];
  const tables = snapshot.tables;
  const constraints = snapshot.constraints;
  const indexes = snapshot.indexes;
  const policies = snapshot.policies;

  for (const table of tables) {
    const key = table.schema_name + "." + table.table_name;
    if (!dbBool(table.has_primary_key)) {
      diagnostics.push(finding(
        "DB-LIVE-NO-PRIMARY-KEY-" + key.replace(/[^a-z0-9]+/gi, "-"),
        "Table without a primary key",
        "medium",
        "The table has no primary-key constraint in the inspected PostgreSQL catalog.",
        "Review whether the table needs a stable primary key for integrity, replication, and reliable updates.",
        key,
        { estimatedRows: Number(table.estimated_rows ?? 0) }
      ));
    }

    if (dbBool(table.row_level_security)) {
      const hasPolicy = policies.some((policy) =>
        policy.schema_name === table.schema_name && policy.table_name === table.table_name
      );
      if (!hasPolicy) {
        diagnostics.push(finding(
          "DB-LIVE-RLS-NO-POLICY-" + key.replace(/[^a-z0-9]+/gi, "-"),
          "Row-level security enabled without a visible policy",
          "medium",
          "RLS is enabled, but no policy was returned for this table. Access may be denied by default; confirm that this is intentional.",
          "Review the table's RLS policy design and test access with the actual application role.",
          key,
          { forceRowLevelSecurity: dbBool(table.force_row_level_security) }
        ));
      }
    }
  }

  for (const constraint of constraints) {
    const key = constraint.schema_name + "." + constraint.table_name;
    if (!dbBool(constraint.is_validated)) {
      diagnostics.push(finding(
        "DB-LIVE-UNVALIDATED-CONSTRAINT-" + constraint.constraint_name,
        "Constraint is not validated",
        "high",
        "PostgreSQL reports this constraint as NOT VALID, so existing rows may not have been checked against it.",
        "Verify existing data and validate the constraint when operationally safe.",
        key,
        { constraint: constraint.constraint_name, type: constraint.constraint_type }
      ));
    }

    if (constraint.constraint_type === "f") {
      const fkColumns = Array.isArray(constraint.columns) ? constraint.columns : [];
      const hasSupportingIndex = indexes.some((index) => {
        if (index.schema_name !== constraint.schema_name ||
            index.table_name !== constraint.table_name ||
            !dbBool(index.is_valid) ||
            !dbBool(index.is_ready)) return false;
        const indexColumns = Array.isArray(index.key_columns) ? index.key_columns : [];
        return fkColumns.length > 0 &&
          indexColumns.length >= fkColumns.length &&
          fkColumns.every((column, position) => indexColumns[position] === column) &&
          partialIndexSupportsForeignKey(index, fkColumns);
      });

      if (fkColumns.length > 0 && !hasSupportingIndex) {
        diagnostics.push(finding(
          "DB-LIVE-FK-NO-INDEX-" + constraint.constraint_name,
          "Foreign key without a supporting leading-column index",
          "medium",
          "No valid, ready index with the foreign-key columns as its leading columns was found. A partial index is accepted only when its predicate preserves all rows eligible for the foreign-key lookup.",
          "Review delete/update workloads and add a supporting index if query patterns and write costs justify it.",
          key,
          { constraint: constraint.constraint_name, columns: fkColumns }
        ));
      }
    }
  }

  for (const index of indexes) {
    if (!dbBool(index.is_valid) || !dbBool(index.is_ready)) {
      diagnostics.push(finding(
        "DB-LIVE-INVALID-INDEX-" + index.index_name,
        "Index is invalid or not ready",
        "high",
        "PostgreSQL reports this index as invalid or not ready for query planning.",
        "Inspect the index build failure and plan a safe reindex or replacement after reviewing locks and workload.",
        index.schema_name + "." + index.table_name,
        { index: index.index_name, isValid: dbBool(index.is_valid), isReady: dbBool(index.is_ready) }
      ));
    }
  }

  if (dbBool(snapshot.role?.is_superuser)) {
    diagnostics.push(finding(
      "DB-LIVE-ROLE-SUPERUSER",
      "Audit connection uses a PostgreSQL superuser",
      "critical",
      "The connected role has superuser privileges. This is excessive for routine application diagnostics.",
      "Use a dedicated least-privilege audit role with catalog visibility and no write, ownership, or superuser privileges.",
      null,
      { role: snapshot.metadata.audit_role }
    ));
  } else if (dbBool(snapshot.role?.bypasses_rls)) {
    diagnostics.push(finding(
      "DB-LIVE-ROLE-BYPASS-RLS",
      "Audit role bypasses row-level security",
      "high",
      "The connected role has BYPASSRLS, so row-level security policies do not constrain its access.",
      "Use a dedicated audit role without BYPASSRLS and verify the application role separately.",
      null,
      { role: snapshot.metadata.audit_role }
    ));
  }

  if (dbBool(snapshot.role?.can_create_role) || dbBool(snapshot.role?.can_create_database) ||
      dbBool(snapshot.role?.can_replicate)) {
    diagnostics.push(finding(
      "DB-LIVE-ROLE-ELEVATED-ATTRIBUTES",
      "Audit role has elevated database attributes",
      "medium",
      "The connected role can create roles/databases or initiate replication.",
      "Remove attributes not required for the audit and use a dedicated least-privilege role.",
      null,
      {
        canCreateRole: dbBool(snapshot.role?.can_create_role),
        canCreateDatabase: dbBool(snapshot.role?.can_create_database),
        canReplicate: dbBool(snapshot.role?.can_replicate)
      }
    ));
  }

  for (const stat of snapshot.stats) {
    const live = Number(stat.n_live_tup ?? 0);
    const dead = Number(stat.n_dead_tup ?? 0);
    const sequential = Number(stat.seq_scan ?? 0);
    const indexed = Number(stat.idx_scan ?? 0);
    const key = stat.schema_name + "." + stat.table_name;

    if (live > 5000 && sequential > Math.max(indexed * 5, 1000)) {
      diagnostics.push(finding(
        "DB-LIVE-SEQUENTIAL-SCAN-" + key.replace(/[^a-z0-9]+/gi, "-"),
        "High sequential-scan activity",
        "low",
        "PostgreSQL statistics show substantially more sequential scans than index scans on a table with an estimated row count above 5,000.",
        "Review actual query plans and workload before adding indexes; sequential scans can be optimal for small or low-selectivity queries.",
        key,
        { sequentialScans: sequential, indexScans: indexed, estimatedLiveRows: live }
      ));
    }

    const deadRatio = live + dead > 0 ? dead / (live + dead) : 0;
    if (dead > 1000 && deadRatio >= 0.2) {
      diagnostics.push(finding(
        "DB-LIVE-DEAD-TUPLES-" + key.replace(/[^a-z0-9]+/gi, "-"),
        "Elevated dead-tuple estimate",
        "low",
        "Statistics show more than 1,000 dead tuples and a dead-tuple ratio of at least 20%.",
        "Review autovacuum settings and table churn; verify with fresh statistics before changing maintenance settings.",
        key,
        { liveTuples: live, deadTuples: dead, deadRatio: Number(deadRatio.toFixed(3)) }
      ));
    }
  }

  const migrationTables = tables
    .filter((table) => /(^|_)(migrations|prisma_migrations|knex_migrations|drizzle_migrations)$/i.test(table.table_name))
    .map((table) => table.schema_name + "." + table.table_name);

  return Object.freeze({
    engine: "JB Expert QA",
    specialist: "database",
    auditVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    database: Object.freeze({
      engine: "postgresql",
      name: snapshot.metadata.database_name,
      serverVersion: snapshot.metadata.server_version,
      auditRole: snapshot.metadata.audit_role,
      transactionReadOnly: true
    }),
    summary: Object.freeze({
      schemas: new Set(tables.map((table) => table.schema_name)).size,
      tables: tables.length,
      constraints: constraints.length,
      indexes: indexes.length,
      policies: policies.length,
      extensions: snapshot.extensions.length,
      findings: diagnostics.length,
      critical: diagnostics.filter((item) => item.severity === "critical").length,
      high: diagnostics.filter((item) => item.severity === "high").length,
      medium: diagnostics.filter((item) => item.severity === "medium").length,
      low: diagnostics.filter((item) => item.severity === "low").length
    }),
    coverage: Object.freeze({
      metadataOnly: true,
      applicationRowsRead: 0,
      catalogQueries: 8,
      migrationTablesDetected: migrationTables
    }),
    diagnostics: Object.freeze(diagnostics),
    inventory: Object.freeze({
      tables: Object.freeze(tables.map((table) => ({
        schema: table.schema_name,
        name: table.table_name,
        estimatedRows: Number(table.estimated_rows ?? 0),
        totalBytes: Number(table.total_bytes ?? 0),
        hasPrimaryKey: dbBool(table.has_primary_key),
        rowLevelSecurity: dbBool(table.row_level_security),
        forceRowLevelSecurity: dbBool(table.force_row_level_security)
      }))),
      extensions: Object.freeze(snapshot.extensions.map((extension) => ({
        name: extension.extension_name,
        version: extension.version
      })))
    })
  });
}

export async function auditPostgresDatabase({
  connectionString,
  clientFactory = createPostgresClient,
  options = {}
} = {}) {
  const normalizedOptions = { ...DEFAULTS, ...options };
  for (const [key, value] of Object.entries(normalizedOptions)) {
    if (!Number.isInteger(value) || value < 100 || value > 30000) {
      throw new TypeError(key + " must be an integer between 100 and 30000.");
    }
  }

  const config = safeConnectionConfig(connectionString, normalizedOptions);
  let client;
  let connected = false;
  let transactionOpen = false;
  try {
    client = await clientFactory(config);
    if (!client || typeof client.connect !== "function" ||
        typeof client.query !== "function" || typeof client.end !== "function") {
      throw new TypeError("The PostgreSQL client factory returned an invalid client.");
    }
    await client.connect();
    connected = true;
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '" + normalizedOptions.statementTimeoutMs + "ms'");
    await client.query("SET LOCAL lock_timeout = '" + normalizedOptions.lockTimeoutMs + "ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");

    const readOnlyResult = await client.query("SHOW transaction_read_only");
    const readOnlyValue = rowsOf(readOnlyResult)[0]?.transaction_read_only;
    if (!["on", "true", "1"].includes(String(readOnlyValue).toLowerCase())) {
      throw new Error("PostgreSQL did not confirm a read-only transaction; audit aborted.");
    }

    const snapshot = {};
    for (const [key, query] of Object.entries(SQL)) {
      snapshot[key] = rowsOf(await client.query(query));
    }
    if (!snapshot.metadata[0]) {
      throw new Error("PostgreSQL returned no database metadata.");
    }

    await client.query("ROLLBACK");
    transactionOpen = false;

    return buildReport({
      metadata: snapshot.metadata[0],
      tables: snapshot.tables,
      constraints: snapshot.constraints,
      indexes: snapshot.indexes,
      policies: snapshot.policies,
      role: snapshot.role[0] ?? {},
      stats: snapshot.stats,
      extensions: snapshot.extensions
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = message
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted PostgreSQL connection string]")
      .replace(/password\s*[=:]\s*\S+/gi, "password=[redacted]");
    throw new Error("PostgreSQL database audit failed: " + safeMessage);
  } finally {
    if (client && connected && transactionOpen) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    if (client && typeof client.end === "function") {
      try { await client.end(); } catch {}
    }
  }
}
