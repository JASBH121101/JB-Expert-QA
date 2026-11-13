# @jb/expert-qa

Complete local-first quality assurance for web projects: static code and project checks, browser-based URL audits, responsive and interaction exploration, accessibility checks, visual regression, security review, and optional AI-assisted remediation.

## Install

```bash
npm install --save-dev @jb/expert-qa
```

Node.js 22 or newer is required. The package is independently installable and does not require JB Security Guard or JB Malware Engine.

## First run: static project audit

```bash
npx jb-qa init
npx jb-qa audit
```

The default report is HTML under `.jb-expert-qa/reports/`. Choose JSON or Markdown explicitly:

```bash
npx jb-qa audit . --format json --output .jb-expert-qa/report.json
npx jb-qa audit ./src --format markdown --output .jb-expert-qa/report.md
```

## Browser, responsive and accessibility audit

Install Chromium once on the machine or CI runner:

```bash
npx jb-qa setup --browser chromium
```

Start your application locally, then audit it:

```bash
npx jb-qa-url http://localhost:5173
npx jb-qa-url http://localhost:5173 --matrix
```

The browser auditor can capture screenshots, inspect accessibility findings with axe-core, explore a bounded set of safe interactive states, and compare PNG screenshots. It blocks service workers and applies URL safety checks. For local development targets, explicitly configure the local/private-network allowance in the API or approved CLI configuration; do not disable URL safety checks for untrusted targets.

## Additional commands

| Command | Purpose |
| --- | --- |
| `jb-qa-project [path]` | Static project audit |
| `jb-qa-url <url> --matrix` | Browser and viewport audit |
| `jb-qa-security [path]` | Focused static security audit |
| `jb-qa-security-url <url>` | Runtime website security audit |
| `jb-qa-autopilot [path]` | AI-assisted analysis and optional remediation |
| `jb-qa-db [path]` | Focused database schema, migration, ORM, query-safety and performance audit |

AI features are opt-in. The autopilot does not apply patches by default. Applying low-risk changes requires the explicit approval flags enforced by the CLI; review diffs and run project tests before accepting any change. Source upload to an AI provider is a separate explicit opt-in.

## JavaScript API

```js
import { auditProject, auditDatabaseProject, auditUrl, auditViewports, comparePngBuffers } from "@jb/expert-qa";

const staticReport = await auditProject("./");
const databaseReport = await auditDatabaseProject("./");
const browserReport = await auditUrl("https://example.com");
const responsiveReport = await auditViewports("https://example.com");
// comparePngBuffers(baselineBuffer, actualBuffer) returns a structured visual diff.
```

The root export also exposes specialist rule groups, provider adapters, visual review, remediation planning, autopilot controls, and the security-bridge contracts. Optional subpath exports are available for `./browser`, `./visual`, `./ai`, `./autopilot`, `./security-bridge`, and `./version`.

## Privacy and execution boundaries

- Static audits read supported local project files; they do not execute the audited application.
- Browser audits navigate only to the requested target and enforce URL safety controls. Use only targets you own or are authorized to assess.
- Dependency advisory lookups are disabled by default. Enabling them may send package names and exact versions to the advisory service; source files and credentials are not sent for that lookup.
- AI calls are not made by default. Provider selection and source-sharing permissions must be configured explicitly.
- Reports should be treated as security-sensitive project metadata even though source contents and detected credential values are redacted.

## Limitations

Findings are heuristic and can include false positives or miss issues. A passing score is not a security certification. Browser exploration is bounded and does not prove every application state is correct. AI-generated remediation is untrusted until reviewed and tested.

JB Expert QA is a development/CI quality tool, not runtime middleware. Use JB Security Guard for server-side request controls and a separately validated malware scanner for file inspection.

## Database Auditor

```bash
npx jb-qa-db . --format=html
npx jb-qa-db ./ --format=json --output=.jb-expert-qa/reports/database.json
```

The focused auditor checks SQL and Prisma schema/migration files plus source and configuration files for destructive DDL, unsafe raw queries, ORM auto-sync, disabled database TLS verification, selected SQL performance patterns, PostgreSQL privilege issues, missing foreign-key indexes and visible migration rollback gaps. It is local and static: it does not connect to a live database, read rows, execute queries, run EXPLAIN, modify schemas or make network requests. Findings are heuristic and require human review.
