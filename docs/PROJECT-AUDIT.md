# Local project audits

JB Expert QA can inspect a local source tree without executing the project or sending its files to an external service.

## Run

~~~bash
npm run audit:project -- .
npm run audit:project -- ../ERP-Perfume --format=markdown
npm run audit:project -- ../Cat-logo --format=html --output=reports/project-audit.html
~~~

The scanner reads supported text files, skips dependency/build/VCS folders, never follows symbolic links, enforces file-count and size limits, and does not open local environment or credential files such as environment files, package-manager auth files, private keys, or certificate containers. It reports the presence of skipped sensitive files without including their contents.

## Current static specialists

- **Code quality:** unusually large source files and absence of recognizable test files.
- **Security:** likely hardcoded credentials (redacted from output), dynamic code execution, raw HTML sinks, disabled TLS verification, and local sensitive files.
- **Dependencies:** floating package versions, missing root lockfiles, malformed package manifests, and risky install lifecycle scripts.
- **Database:** destructive SQL operations, PostgreSQL SECURITY DEFINER functions without an explicit per-function search_path, unsafe Prisma raw-query APIs, Prisma and SQL foreign-key fields that may lack a supporting leading index, broad grants to `PUBLIC`, elevated PostgreSQL role attributes, and `CREATE INDEX CONCURRENTLY` inside explicit transactions.

## Important limits

This is deterministic static analysis, not a generative AI review or a complete security scanner. Pattern matching can miss vulnerabilities and can report false positives. Review each item in context.

The project auditor does not execute source files, install packages, access a database, resolve dependency CVEs, or query an online advisory service. It cannot certify that dependencies are safe or current. Database checks are limited to visible SQL and recognized source patterns; they do not inspect a live database schema or migration history.

All scanning is read-only. Findings are recommendations for a human reviewer; the engine does not repair project files.
