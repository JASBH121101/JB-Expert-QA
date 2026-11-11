# @jb/expert-qa

JB Expert QA Core is a local-first static project auditor for web and JavaScript projects. It is installed independently; JB Security Guard and JB Malware Engine are not dependencies.

## Install

```bash
npm install --save-dev @jb/expert-qa
```

## First run

```bash
npx jb-qa init
npx jb-qa audit
```

The audit writes an HTML report under `.jb-expert-qa/reports/`. JSON and Markdown are also available:

```bash
npx jb-qa audit . --format json --output .jb-expert-qa/report.json
npx jb-qa audit ./src --format markdown --output .jb-expert-qa/report.md
```

## What Core checks

- Source structure, code-quality and maintainability rules.
- Common security patterns and possible credential exposure; environment and credential files are skipped.
- Conservative unused-code, unresolved relative-import and dependency-cycle analysis for supported JavaScript module syntax.
- Project scan completeness and bounded file, size and depth coverage.
- HTML, Markdown and JSON reports with findings, severity, locations and recommendations.

## Privacy and execution model

- Audits read supported local text files only.
- The audited application is not executed.
- `node_modules`, build output, VCS metadata, environment files, credential files, generated QA reports and symbolic links are excluded.
- The report does not contain source file contents or detected secret values.
- Dependency advisory lookups are disabled by default. They can be enabled explicitly in `jb-expert-qa.config.json`; when enabled, package names and exact versions may be sent to OSV.dev, not source code or credentials.
- Browser screenshots, browser-based accessibility checks and visual regression are intentionally not part of Core. They are not installed by this package.

## Supported runtime

Node.js 22 or newer. This package is a development/CI tool, not runtime middleware and not a security certification.

## API

```js
import { auditProject, formatReport } from "@jb/expert-qa";

const report = await auditProject("./");
const html = formatReport(report, "html");
```

Findings are heuristic where the underlying analysis is heuristic. A passing score does not prove that a project is free of vulnerabilities.
