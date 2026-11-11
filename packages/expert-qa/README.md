# @jb/expert-qa

The complete JB Expert QA engine for JavaScript and web projects. This package includes the canonical engine source, static project analysis, security analysis, Playwright browser audits, interaction exploration, accessibility checks with axe-core, visual viewport analysis, PNG regression comparison, AI-assisted review and the supervised repair agent.

It is not a reduced Core-only edition. All engine modules exported by the monorepo's `src/index.js` are included in this package.

## Install

```bash
npm install --save-dev @jb/expert-qa
npx jb-qa setup --browser chromium
```

The npm package installs Playwright and axe-core. Browser binaries are installed separately by the setup command because Playwright downloads browsers for the host operating system.

On Linux CI images that do not already contain the required system libraries, run:

```bash
npx jb-qa setup --browser chromium --with-deps
```

## Quick start

Create a project policy without overwriting an existing configuration, then scan the project locally:

```bash
npx jb-qa init
npx jb-qa audit .
```

The default static audit is local-first. It does not execute the audited project, connect to your database or upload source files. Reports are written under `.jb-expert-qa/reports/`.

## Complete command set

| Command | Capability |
| --- | --- |
| `jb-qa init` | Create a project audit configuration. |
| `jb-qa audit [path]` | Static source, quality, security, dependency and database audit. |
| `jb-qa setup --browser chromium` | Install the Playwright browser binary. |
| `jb-qa-project [path]` | Static project audit CLI. |
| `jb-qa-url https://example.com --matrix` | Browser, responsive and visual audit. |
| `jb-qa-security [path]` | Focused static security audit. |
| `jb-qa-security-url https://example.com` | Runtime website security audit. |
| `jb-qa-autopilot [path]` | Local audit and optional, explicitly enabled AI remediation workflow. |

### Browser, responsive and interactive audit

```bash
npx jb-qa-url https://example.com --matrix --explore-interactions --screenshots=reports/screenshots --format=html --output=reports/browser-audit.html
```

The browser adapter includes:
- Desktop, tablet and mobile viewport matrices.
- Safe exploration of semantically identified menus, tabs, disclosures, dialogs and other toggle controls.
- Axe-core accessibility checks.
- Runtime page errors, failed requests, HTTP errors and blocked network requests.
- Layout, responsive, UI/UX, performance, functional and consistency specialists.
- Screenshot capture and same-origin/private-network request controls.

For a single mobile viewport, use `--mobile`. For a local development server, explicitly pass `--allow-private-network`; remote URL audits reject private and reserved network destinations by default.

### Visual regression

Capture approved baselines:

```bash
npx jb-qa-url https://example.com --matrix --screenshots=reports/current --baseline-dir=reports/baseline --update-baselines
```

Compare future captures against those baselines:

```bash
npx jb-qa-url https://example.com --matrix --screenshots=reports/current --baseline-dir=reports/baseline --diff-dir=reports/diff --visual-threshold=0.1 --max-diff-ratio=0.005
```

Baseline updates deliberately require a separate explicit flag. A baseline update is evidence capture, not a passing comparison.

### Focused security analysis

```bash
npx jb-qa-security .
npx jb-qa-security-url https://example.com
```

Security rules are heuristic checks and need engineering review. They do not replace penetration testing, a WAF, secure coding controls or a formal security assessment.

### AI review and supervised remediation

AI features are disabled by default. Visual AI review, AI planning and remediation require explicit configuration and opt-in. The deterministic audit remains available without AI credentials.

```bash
npx jb-qa-autopilot .
```

Automatic patch retention is more restrictive: it requires explicit AI deep-analysis, permission to upload selected source files to the configured provider, and test execution. Repairs are isolated in a Git worktree; the engine does not push, open a pull request, merge or deploy.

Provider configuration and free-tier safeguards are documented in the engine architecture. Do not set secrets in source files or commit them.

## Programmatic API

The package root re-exports the complete public API from the engine:

```js
import {
  auditProject,
  auditUrl,
  auditViewports,
  comparePngFiles,
  createAiProviderRouter,
  runAutopilot
} from "@jb/expert-qa";

const staticReport = await auditProject(".");
const browserReport = await auditViewports("https://example.com", {
  interactionExploration: true
});
```

Additional subpath exports are available for `@jb/expert-qa/browser`, `/visual`, `/ai`, `/autopilot` and `/security-bridge`.

## Runtime and dependencies

- Node.js 22 or newer.
- Playwright and a separately installed browser for browser/visual audits.
- axe-core for accessibility analysis.
- pixelmatch and pngjs for screenshot comparison.
- Acorn for supported JavaScript parsing and dead-code analysis.

The package includes every directory under the canonical engine `src/` and all engine configurations under `config/`. Package builds copy these files from the monorepo source so the distributed engine does not drift into a manually maintained subset.

## Privacy and limits

- Static scans operate on local files and do not send source code to an external service.
- OSV dependency lookups are controlled by the selected project configuration and send package names and versions, not source files.
- Browser audits contact the requested target and load its allowed page resources. Same-origin-only and private-network checks are available to constrain that activity.
- AI visual review sends selected screenshots to the explicitly configured provider. AI remediation can send selected, redacted source snippets only after the explicit opt-ins described above.
- Findings are evidence-based but may contain false positives or missed issues. A score or passing report is not a security certification.
- The engine is a development and CI QA tool, not runtime protection or antivirus.

JB Security Guard and JB Malware Engine remain separate packages with their own runtime boundaries; they are not silently installed as dependencies of Expert QA.
