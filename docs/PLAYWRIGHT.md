# Browser audits with Playwright

The Playwright adapter opens a target URL in Chromium, collects measurable DOM, resource, accessibility, and runtime evidence, and passes it to deterministic specialist rules.

## Setup

~~~bash
npm install
npx playwright install chromium
~~~

## Run an audit

~~~bash
npm run audit -- https://example.com
npm run audit -- https://example.com --mobile
npm run audit -- https://example.com --matrix
~~~

The default viewport is 1365×900; **--mobile** uses 390×844. The matrix checks mobile (390×844), tablet (768×1024), and desktop (1365×900).

## Private and local destinations

Remote audits block loopback, private, link-local, reserved IP addresses and local/reserved hostnames by default. The adapter re-checks HTTP(S) browser requests so redirects and page resources aimed at local networks are blocked as well.

For a local development server or a trusted private test environment, explicitly opt in:

~~~bash
npm run audit -- http://127.0.0.1:3000 --allow-private-network
npm run audit -- http://192.168.1.20 --matrix --allow-private-network
~~~

Do not use the opt-in flag for untrusted URLs. Only audit sites and networks you own or are authorized to test. The hostname check uses DNS answers observed by the Node.js process; it is a defense-in-depth safeguard, not a replacement for network egress controls against a hostile DNS rebinding environment.

## Export reports

~~~bash
npm run audit -- https://example.com --matrix --format=markdown --output=reports/site-audit.md
npm run audit -- https://example.com --format=html --output=reports/site-audit.html
~~~

Formats: **json** (default), **markdown**, and **html**. Reports include target, status, summary, findings, recommendations, and rule execution details. HTML and Markdown output escape report content before rendering.

## Implemented specialist evidence

- **Responsive:** document overflow and visible element bounds.
- **UI/UX:** small text, small interactive targets, and large vertical gaps between top-level content blocks.
- **Accessibility:** axe-core WCAG checks, missing image alt attributes, unlabeled visible form controls, missing document language, and skipped heading levels.
- **Performance:** large transferred resources, slow resources, images without reserved dimensions, and unusually large DOM trees.
- **Functional:** uncaught page JavaScript errors, failed network requests, and HTTP responses with status 400 or above.
- **Consistency:** image-ratio and action-height variation in detected repeated card components.

axe-core runs locally in the browser as a free open-source accessibility engine; it does not call a hosted AI service.

## Heuristic limitations

Automated checks identify measurable risks, not absolute design truth. Decorative images may intentionally use empty alt text; repeated-card checks require recognizable card selectors; cross-origin resource sizes can be unavailable; third-party errors may not be defects in the site itself; whitespace can be intentional. Review evidence before changing a site.

The adapter does not yet click through forms, authenticate to protected sites, test every browser engine, or make subjective design decisions.


## Screenshot capture and visual regression

Capture a viewport matrix without using a model:

~~~bash
npm run audit -- https://example.com --matrix --screenshots=artifacts/screenshots
~~~

Create or deliberately refresh the visual baselines (this is an explicit operation):

~~~bash
npm run audit -- https://example.com --matrix --screenshots=artifacts/screenshots --baseline-dir=visual-baselines --update-baselines
~~~

Compare future captures against those references and save difference images:

~~~bash
npm run audit -- https://example.com --matrix --screenshots=artifacts/screenshots --baseline-dir=visual-baselines --diff-dir=artifacts/diffs --format=html --output=artifacts/visual-report.html
~~~

A missing baseline is reported as **baseline-missing** and does not pass. A baseline update is reported separately and also does not count as a comparison pass. Dimension changes are failures. Pixel-diff thresholds are configurable through **--visual-threshold=0.1** and **--max-diff-ratio=0.005**. Store baselines in version control only when the team has reviewed and accepted them. Do not use automatic baseline updates in normal CI runs.

## Optional AI visual critique

The AI reviewer sends only the selected screenshots and bounded browser findings to the configured Gemini endpoint. It does not send project source code as part of visual review and it does not write to the target site.

~~~bash
GEMINI_API_KEY=your_key npm run audit -- https://example.com --matrix --screenshots=artifacts/screenshots --ai-visual-review --format=html --output=artifacts/ai-visual-report.html
~~~

Set GEMINI_API_KEY as a local environment variable or a CI secret. Optional model selection uses GEMINI_VISION_MODEL. AI review is never enabled by default; it requires the explicit --ai-visual-review flag. When the key is missing or quota is unavailable, the report says the review was not configured or unavailable; deterministic QA still runs. AI comments always require human review and never affect release approval automatically.
