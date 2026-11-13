# JB Expert QA — Database QA

## Scope

The existing \`database\` specialist performs static analysis of project files. It can identify selected destructive SQL statements, PostgreSQL \`SECURITY DEFINER\` risks, unsafe raw-query APIs, broad grants, elevated role attributes, foreign-key index gaps, Prisma relation-index gaps, and concurrent-index operations inside explicit transactions.

This extension adds an opt-in **live PostgreSQL metadata audit**. PostgreSQL is the first live adapter; Neon is supported through its PostgreSQL protocol. MySQL and SQLite are future adapters and are not claimed as supported yet.

## Safety model

- The adapter opens one connection and immediately starts \`BEGIN READ ONLY\`.
- It verifies \`transaction_read_only = on\` before running catalog queries.
- It uses fixed, internal SQL statements against PostgreSQL system catalogs and statistics views. It does not accept or execute user-provided SQL.
- It reads schema metadata and aggregate statistics only. It does not select application table rows.
- It applies statement and lock timeouts and always rolls back before closing the connection.
- It never prints or includes the connection URL, username password, or host in the report.
- The CLI accepts the name of an environment variable, never a database URL as a command-line argument.
- It does not modify schema, data, indexes, roles, grants, extensions, migrations, or database settings.
- A read-only transaction is an additional safeguard, not a substitute for a dedicated least-privilege database role.

A live audit is not risk-free: catalog access creates a database connection and executes bounded read queries. Run it against a staging database first. Do not provide production credentials during this initial phase.

## Install the optional PostgreSQL driver

The core package does not bundle a database driver. In a local development checkout, install the driver without changing the repository manifest or lockfile:

\`\`\`sh
npm install --no-save --package-lock=false pg@^8
\`\`\`

## Run a local or staging audit

Set a connection URL in the environment; do not put it in shell command history or a CLI argument.

\`\`\`sh
export QA_DATABASE_URL='postgresql://read_only_user:...@host:5432/database?sslmode=require'
npm run audit:database -- --env=QA_DATABASE_URL --confirm-read-only
\`\`\`

To write the JSON report to a local file:

\`\`\`sh
npm run audit:database -- --env=QA_DATABASE_URL --confirm-read-only --output=reports/database-qa.json
\`\`\`

The CLI refuses to run without \`--confirm-read-only\`. The adapter forces TLS certificate verification and rejects non-PostgreSQL URL schemes.

## First live checks

The initial adapter reports:
- Tables without primary keys.
- Foreign keys without a valid, ready index whose leading columns support the foreign key. A partial index is accepted only when its predicate is exactly a foreign-key column `IS NOT NULL`; partial indexes with additional restrictions remain conservatively excluded.
- Constraints marked \`NOT VALID\`.
- Invalid or not-ready indexes.
- Tables with row-level security enabled but no visible policy.
- Superuser, \`BYPASSRLS\`, and elevated role attributes on the audit connection.
- Advisory sequential-scan and dead-tuple statistics.
- Installed extension names and versions.
- Common migration-table names, when present.

Sequential scans and dead tuples are advisory signals, not automatic proof of a defect. Confirm query plans, data distribution, and workload before changing indexes or autovacuum settings.

## Next milestones

1. PostgreSQL catalog coverage, regression fixtures, and staging validation.
2. Additional PostgreSQL checks: partitioning, sequences/identity columns, privileges, materialized views, RLS policy semantics, migration drift, and safe EXPLAIN-only query-plan inspection.
3. MySQL adapter with equivalent read-only safeguards.
4. SQLite adapter with immutable/read-only opening and schema introspection.
5. Optional repair proposals as reviewed SQL/migration drafts only. Execution remains disabled and requires a separate explicit approval design.

## Limitations

The first version does not inspect application row contents, run arbitrary SQL, perform writes, create backups, validate backup restorability, change permissions, or certify production readiness. It cannot infer whether a missing index is wrong for a workload. The audit role may not see every object; catalog visibility limitations must be considered when interpreting results. A successful connection and report are not a security certification.
