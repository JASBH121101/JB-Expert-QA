# JB Expert QA — QA Control Center (Block 4)

## Purpose

The QA Control Center is a local browser dashboard over the seven built-in audit adapters. It is a user interface and local evidence store, not a replacement for the existing static, Playwright, Security or Visual auditors.

## Start

From the JB Expert QA repository root, run:

    npm run dashboard

For an independently installed package, run:

    npx jb-qa-dashboard

The server binds only to 127.0.0.1. Open the exact loopback URL printed by the process and keep the terminal session running. The default port is 4173; override it with --port=4174. Stop the server with Ctrl+C.

## Capabilities

- Reads the live engine registry and allows one or more compatible engines to be selected.
- Runs selected audits sequentially to avoid concurrent browser sessions and overlapping local work.
- Supports local project targets for Static QA and static Security QA, and website targets for browser engines and runtime Security QA.
- Stores compact run metadata, score, findings, outcome and comparison summaries locally.
- Compares a run with the previous run for the same engine and exact target identity. It reports score change, finding-count change, newly observed findings and resolved findings.
- Creates a downloadable Markdown internal report for each saved run.
- QA Intelligence aggregates the latest snapshot per engine and target, ranks retained findings by severity, summarizes engine coverage, and shows the latest 12 score observations.
- Provides a downloadable consolidated Markdown report covering the bounded local history.
- Visual QA saves per-viewport screenshots for later review from the local dashboard.

The Control Center stores a compact finding list (up to 100 per run) rather than duplicating the entire audit response in history. It does not create visual baselines automatically or overwrite approved baselines.

## Storage

History is written under:

    .jb-expert-qa/dashboard/history.json
    .jb-expert-qa/dashboard/screenshots/<run-id>/

The dashboard applies restrictive directory/file permissions where the host operating system supports them. The storage area can contain project names, website addresses and QA finding metadata. Keep it local and do not commit it to a public repository.

## Local security boundary

- Binds only to IPv4 loopback (127.0.0.1); no LAN interface or public host binding is supported.
- Requires the local same-origin browser origin for audit execution and rejects cross-site Fetch Metadata.
- Sends no CORS permission headers and applies a restrictive Content Security Policy and browser security headers.
- Limits JSON request bodies, headers, concurrent audits, and run frequency.
- Uses a fixed route allowlist and accepts only a registered engine ID plus its required target field.
- Does not accept caller-supplied auditor options, shell commands, arbitrary actions, source patches, Git operations or deployment requests.
- Static project auditors remain read-only; browser auditors retain their existing URL safety checks, including the default denial of private network targets.
- The dashboard itself does not install dependencies or access GitHub, Cloudflare, production databases or third-party dashboard services.

Only run the dashboard on a trusted local device. Loopback binding and same-origin checks are defense-in-depth, not a substitute for operating-system account security.

## Result semantics

- **Passed:** the underlying auditor reported a passing score and no rule execution errors, with no recorded findings.
- **Passed with observations:** the underlying auditor passed, but findings were recorded for review.
- **Not passed:** the underlying auditor did not pass or reported rule execution errors.

Individual certificates and consolidated reports are internal QA summaries of the selected or retained local scope. The consolidated posture is based on the newest saved record for each engine/target pair; engine coverage means an engine appears somewhere in history and does not prove all engines assessed the same target. Neither report is independent third-party certification, a penetration test, an accessibility conformance statement, or proof of production readiness. A first run has no historical comparison; later runs compare only with the most recent record for the same engine and target.

## Verification

    node --test tests/dashboard.test.js
    npm run qa:local
    npm run test:package-distributions
