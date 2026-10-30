# JB Expert QA — Architecture

## Design goals

- Private, independently versioned project.
- Portable Node.js engine with no mandatory hosted AI service.
- Deterministic rule-based diagnostics.
- Replaceable adapters and specialist modules.
- Machine-readable reports and reproducible tests.

## Layers

1. **Core engine** — coordinates rules and creates audit reports.
2. **Rule registry** — validates and stores specialist rules.
3. **Specialists** — UI/UX, responsive, accessibility, performance, functional, consistency.
4. **Adapters** — connect browser automation and external project types to the engine.
5. **Profiles** — project-specific thresholds, weights, and rule configuration.
6. **Reporters** — JSON, Markdown, and HTML output (planned).

## Diagnostic contract

Each finding has an identifier, specialist, title, description, severity, optional evidence, recommendation, location, and metadata.

## Scoring

Scores are weighted across configured specialists. A critical finding can block approval independently of the numeric score. Weights and penalties are configuration, not universal design truths.

## Privacy and execution

The core does not transmit project data. Browser adapters may access the target site as required by the user-run audit. Secrets and environment files must never be committed.

## Current scope: 0.1.0

Implemented: rule registry, diagnostic validation, deterministic scoring, audit orchestration, JSON report object, and Node.js tests.

Not yet implemented: browser adapter, DOM rules, screenshot comparison, Lighthouse/axe integrations, dashboard, WordPress adapter, and archive packaging.
