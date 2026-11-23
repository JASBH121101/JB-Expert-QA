# JB Expert QA — Local Certification Runner

## Purpose

The Local Certification Runner provides a repository-owned way to run selected JB Expert QA regression and engine-contract checks without GitHub Actions. GitHub remains the source repository; GitHub Actions is not the execution host for this runner.

This is the first decoupling step. Existing GitHub Actions workflows are deliberately retained as the previous certification path until the replacement has completed broader validation in later project blocks.

## Requirements

- Node.js 22 or newer.
- npm dependencies already installed.
- Run commands from the JB-Expert-QA repository root.

Install dependencies once, when network access is available:

    npm install --ignore-scripts --no-audit --no-fund --no-package-lock

The repository currently has no npm lockfile, so `npm ci` cannot be used until a lockfile is added. The install command above avoids creating an untracked lockfile. The runner itself does not install packages, fetch code, call GitHub APIs, call Cloudflare APIs, access production services, or deploy anything.

## Run

Core local profile:

    npm run qa:local

Expanded local profile:

    npm run qa:local:full

Equivalent direct invocation:

    node scripts/local-certification.mjs --profile=core
    node scripts/local-certification.mjs --profile=full --report-dir=.jb-expert-qa/certification

Optional timeout override:

    node scripts/local-certification.mjs --profile=core --timeout-ms=900000

The timeout override applies to each selected check and accepts values from 1,000 to 3,600,000 milliseconds.

## Profiles

### core

Runs these repository-owned npm scripts sequentially:

1. check — syntax validation and the root regression suite.
2. test:package-distributions — independently installable package boundaries.
3. test:engine-contracts — shared engine contract tests.
4. test:threat-lab — safe Threat Lab integration tests.
5. test:autonomous-execution — policy-bounded action authorization, approval gates, execution limits and audit ledger.

### full

Runs all core checks and adds:

1. test:security-guard.
2. test:resilience-engine.
3. test:internationalization.
4. test:dead-code.

The profile is an allowlist of fixed scripts in this repository. User input cannot supply an arbitrary command or shell fragment.

## Reports and exit codes

Each completed run writes a JSON report and a Markdown summary under `.jb-expert-qa/certification` by default. The report records the profile, Node.js version, operating system, duration, command-level outcome, exit code, timeout state, and a bounded redacted output tail.

- PASS — the selected npm script exited with code 0 and its captured TAP summary contains no skipped tests.
- PARTIAL — the selected npm script exited with code 0 but its captured TAP summary reports one or more skipped tests. These runs are not certified as a full pass.
- FAIL — the process could not be started or exited with a non-zero code.
- TIMEOUT — the process exceeded its time limit and was terminated.
- SKIPPED — reserved for a future profile that explicitly records a task as skipped; skipped tasks are not counted as passing.

Exit codes: 0 means the selected profile passed with no detected test skips; 1 means one or more checks failed, timed out, or were partial due to skipped tests; 2 means invalid arguments or a preflight/runner error.

## Safety and scope boundaries

- Tasks run sequentially; there is no parallel load on the host.
- Child processes receive a fixed npm script from the runner allowlist.
- Shell execution is disabled except for the fixed npm.cmd compatibility fallback on Windows.
- Child output is retained only as a bounded tail and redacted before it is shown or written to reports.
- No source is uploaded to an AI provider.
- No repository changes, Git operations, deployments, live-target scans, external accounts, or infrastructure mutations are performed by this runner.

## Known limitations in v1

- A run checks only the current host operating system and installed Node.js version. It does not reproduce a multi-OS or multi-Node CI matrix.
- Node.js TAP summaries in the captured output are parsed for skipped-test counts. Any detected skip changes the task status to PARTIAL and prevents the profile from returning a full pass. Non-TAP test reporters and output truncated before the summary cannot be classified this way.
- Browser binaries are not provisioned by this runner. Install the required Playwright browser separately before executing browser-dependent tests.
- The core profile intentionally does not execute the additional suites in the full profile. The report lists those omitted checks.
- This runner replaces the execution entry point for local use; it does not yet replace package publishing, cross-platform certification, browser provisioning, or every specialized workflow.

A green report is evidence that the selected commands passed on the recorded local environment. It is not an independent security certification or proof of production readiness.
