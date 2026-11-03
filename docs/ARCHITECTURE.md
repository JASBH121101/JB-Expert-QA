# JB Expert QA — Architecture

## Design goals

- Private, independently versioned project.
- Portable Node.js engine with no mandatory hosted AI service.
- Deterministic, evidence-based diagnostics.
- Replaceable adapters and extensible specialist modules.
- Machine-readable reports and reproducible tests.

## Layers

1. **Core engine** — coordinates rules and creates audit reports.
2. **Rule registry** — validates and stores built-in and project-specific specialist rules.
3. **Specialists** — browser specialists for UI/UX, responsive, accessibility, performance, functional, and consistency; static project specialists for code quality, security, dependencies, and database review.
4. **Adapters** — Playwright browser adapter and read-only local filesystem adapter.
5. **Visual regression adapter** — PNG capture and local pixel comparison against explicit baselines.
6. **Optional AI layer** — replaceable Gemini provider for screenshot critique and structured remediation planning.
7. **Supervised agent** — isolated local Git worktree, allowlisted patches, bounded test/verification attempts.
8. **Profiles** — project-specific thresholds, weights, and rule configuration.
9. **Reporters** — JSON, Markdown, and HTML report output.

## Diagnostic contract

Each finding has an identifier, specialist, title, description, severity, optional evidence, recommendation, location, and metadata.

## Scoring

Scores are weighted across the specialists actually included in an audit. Each active specialist must have a configured weight. A critical finding can block approval independently of the numeric score. Rule execution errors also block approval. Weights and penalties are configuration, not universal design truths.

## Privacy and execution

The core does not require an external AI API. Browser audits use the URL safety guard. Local project audits read supported text files only, skip environment and credential files, do not follow symlinks, and do not execute project code, install dependencies, or connect to databases. Reports intentionally omit project source contents and detected credential values.

## Current scope: 0.4.0

Implemented: extensible rule registry, validated engine configuration, deterministic scoring, six browser specialists, four static project specialists, Playwright Chromium adapter, safe local filesystem scanner, responsive multi-viewport matrix, PNG screenshots, explicit pixel-diff baselines, optional Gemini screenshot review, structured remediation planning, local worktree-based low-risk repair with explicit opt-ins, JSON/Markdown/HTML reports, and automated tests.

Planned: syntax-aware static analysis, dependency advisory integration under an explicitly approved no-cost strategy, live database schema inspection with read-only credentials, a review dashboard, broader browser-engine coverage, and packaging.

AI is optional. Deterministic rules and pixel comparisons continue to work without model credentials. AI responses never approve releases. Auto-repair is restricted to low-risk source files in src/, requires an explicit source-upload opt-in and an explicit test-run opt-in, creates a local worktree, and never pushes, opens a PR, merges or deploys.

## Heuristic limitations

Automated checks identify measurable risks, not absolute truth. Static rules are pattern-based and can miss vulnerabilities or produce false positives. Dependency checks do not query a vulnerability database or determine whether versions are current. Database rules review source files only; they do not inspect a live database or validate migration state. Findings require human review before changes are made.
