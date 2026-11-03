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
3. **Specialists** — built-in UI/UX, responsive, accessibility, performance, functional, and consistency checks; projects may register additional specialist IDs.
4. **Adapters** — connect browser automation and project types to the engine.
5. **Profiles** — project-specific thresholds, weights, and rule configuration.
6. **Reporters** — JSON, Markdown, and HTML report output.

## Diagnostic contract

Each finding has an identifier, specialist, title, description, severity, optional evidence, recommendation, location, and metadata.

## Scoring

Scores are weighted across the specialists actually included in an audit. Each active specialist must have a configured weight. A critical finding can block approval independently of the numeric score. Rule execution errors also block approval. Weights and penalties are configuration, not universal design truths.

## Privacy and execution

The core does not transmit project data and does not require an external AI API. Browser adapters visit the target site only as part of a user-run audit. Secrets and environment files must never be committed.

## Current scope: 0.3.1

Implemented: rule registry, extensible specialist IDs, engine configuration validation, diagnostic validation, deterministic scoring, six built-in specialist modules, Playwright Chromium adapter, DOM/network evidence collection, responsive multi-viewport matrix, CLI, JSON/Markdown/HTML reporters, and automated unit/integration tests.

Planned: source-code and dependency auditing, screenshot comparison, richer visual analysis, dashboard, WordPress adapter, and archive packaging.

## Heuristic limitations

Automated checks identify measurable risks, not absolute design truth. Decorative images may intentionally use empty alt text; card consistency rules require recognizable repeated-card selectors; resource timing and transfer sizes may be unavailable for cross-origin resources. Findings should be reviewed before changing a site.
