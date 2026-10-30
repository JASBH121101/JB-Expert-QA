# JB Expert QA — Architecture

## Design goals

- Private, independently versioned project.
- Portable Node.js engine with no mandatory hosted AI service.
- Deterministic, evidence-based diagnostics.
- Replaceable adapters and specialist modules.
- Machine-readable reports and reproducible tests.

## Layers

1. **Core engine** — coordinates rules and creates audit reports.
2. **Rule registry** — validates and stores specialist rules.
3. **Specialists** — UI/UX, responsive, accessibility, performance, functional, and consistency.
4. **Adapters** — connect browser automation and project types to the engine.
5. **Profiles** — project-specific thresholds, weights, and rule configuration.
6. **Reporters** — JSON is returned by the API; Markdown and HTML output are planned.

## Diagnostic contract

Each finding has an identifier, specialist, title, description, severity, optional evidence, recommendation, location, and metadata.

## Scoring

Scores are weighted across the specialists actually included in an audit. A critical finding can block approval independently of the numeric score. Rule execution errors also block approval. Weights and penalties are configuration, not universal design truths.

## Privacy and execution

The core does not transmit project data. Browser adapters visit the target site only as part of a user-run audit. Secrets and environment files must never be committed.

## Current scope: 0.3.0

Implemented: rule registry, diagnostic validation, deterministic scoring, six specialist modules, Playwright Chromium adapter, DOM/network evidence collection, responsive multi-viewport matrix, CLI, and automated unit/integration tests.

Planned: screenshot comparison, Lighthouse/axe integrations, richer visual analysis, dashboard, WordPress adapter, and archive packaging.

## Heuristic limitations

Automated checks identify measurable risks, not absolute design truth. Decorative images may intentionally use empty alt text; card consistency rules require recognizable repeated-card selectors; resource timing and transfer sizes may be unavailable for cross-origin resources. Findings should be reviewed before changing a site.
