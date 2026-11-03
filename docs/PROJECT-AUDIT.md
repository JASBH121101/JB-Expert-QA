# Local project audits

JB Expert QA can inspect a local source tree without executing the project or sending its files to an external service.

## Run

~~~bash
npm run audit:project -- .
npm run audit:project -- ../ERP-Perfume --format=markdown
npm run audit:project -- ../Cat-logo --format=html --output=reports/project-audit.html
npm run audit:project -- ../ERP-Perfume --config=../ERP-Perfume/jb-expert-qa.config.json --format=markdown
~~~

## Project-specific profiles

The project auditor accepts a JSON policy file through `--config=PATH`. This keeps engine code shared while letting each repository set its own profile, scoring weights, severity penalties, score threshold, source-size threshold, and scanner limits.

Example:

~~~bash
npm run audit:project -- . --config=./jb-expert-qa.config.json
npm run audit:project -- . --config=./jb-expert-qa.config.json --format=markdown --output=reports/qa.md
~~~

The `scan` section supports `maxFiles`, `maxFileBytes`, `maxTotalBytes`, and `maxDepth`. Omitted values use the safe engine defaults. Invalid values and unknown scanner options stop the audit instead of silently falling back. Config files contain policy only; do not put API keys, credentials, or customer information in them.

A repository may keep its own `jb-expert-qa.config.json` and pass it to CI. The shared engine's default profile remains unchanged for projects without a custom file.

The scanner reads supported text files, skips dependency/build/VCS folders, never follows symbolic links, enforces file-count and size limits, and does not open local environment or credential files such as environment files, package-manager auth files, private keys, or certificate containers. Environment filenames are matched case-insensitively. It reports the presence of skipped sensitive files without including their contents.

An audit is marked incomplete and cannot pass when the scan reaches its file/depth limit, skips oversized files, or cannot read supported files. Increase the scan limits or resolve the access errors, then rerun the audit.

## Current static specialists

- **Code quality:** scan completeness, unusually large source files, and absence of recognizable test files.
- **Security:** likely hardcoded credentials (redacted from output), dynamic code execution, raw HTML sinks, disabled TLS verification, and local sensitive files.
- **Dependencies:** floating package versions, missing root lockfiles, malformed package manifests, and risky install lifecycle scripts.
- **Database:** destructive SQL operations, PostgreSQL SECURITY DEFINER functions without an explicit per-function search_path, unsafe Prisma raw-query APIs, Prisma and SQL foreign-key fields that may lack a supporting leading index, broad grants to `PUBLIC`, elevated PostgreSQL role attributes, and `CREATE INDEX CONCURRENTLY` inside explicit transactions.

## HTML sink classification

HTML-producing assignments are classified rather than all receiving the same penalty:

- Static markup with no dynamic interpolation is not reported as an injection finding.
- Dynamic markup using a recognized escaping helper (for example, `esc()` or `escapeHtml()`) or a local renderer that calls one is retained as an informational review item. The analyzer does not prove that every interpolation is escaped in the correct HTML text, attribute, or URL context.
- Common untrusted-input sources reaching a sink without a recognized escaping call are high severity.
- Dynamic sinks whose data flow cannot be resolved remain medium severity and require manual review.

The source checks are intentionally heuristic. A helper name is not proof that the implementation is correct, and untrusted input that passes through an unrecognized variable or wrapper may not be classified as high severity. Prefer `textContent` and DOM node APIs where practical, and review all dynamic HTML generation before release.

## Important limits

This is deterministic static analysis, not a generative AI review or a complete security scanner. Pattern matching can miss vulnerabilities and can report false positives. Review each item in context.

The project auditor does not execute source files, install packages, access a database, resolve dependency CVEs, or query an online advisory service. It cannot certify that dependencies are safe or current. Database checks are limited to visible SQL and recognized source patterns; they do not inspect a live database schema or migration history.

All scanning is read-only. Findings are recommendations for a human reviewer; the engine does not repair project files.
