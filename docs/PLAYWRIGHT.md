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
# Also exercise safe menus, tabs, accordions and dialogs
npm run audit -- https://example.com --matrix --explore-interactions
~~~

The default viewport is 1365×900; **--mobile** uses 390×844. The matrix checks mobile (390×844), tablet (768×1024), and desktop (1365×900).

## Dual light/dark theme audit

Use the matrix with **--themes=light,dark** to run every configured viewport twice. Playwright emulates `prefers-color-scheme`; the report also records the root `color-scheme`, explicit theme markers (`data-theme`, `data-bs-theme`, and recognizable root/body classes), and root CSS color tokens.

~~~bash
npm run audit -- https://example.com --matrix --themes=light,dark
~~~

For applications that use an explicit theme selector, force the corresponding root attribute or class as well. When the app persists its theme in `localStorage`, supply the actual key used by that application so the selected mode is seeded before app scripts run:

~~~bash
npm run audit -- https://example.com --matrix --themes=light,dark --theme-attribute=data-theme
npm run audit -- https://example.com --matrix --themes=light,dark --theme-attribute=class --theme-storage-key=theme
~~~

Use only an attribute/class convention and storage key confirmed in the target application. The override is intentionally opt-in; JB Expert QA does not guess a site's persistence key or forcibly replace a user's theme by default.

When capturing screenshots and comparing references, each theme has independent artifacts and baselines (for example, `light-mobile.png` and `dark-mobile.png`):

~~~bash
npm run audit -- https://example.com --matrix --themes=light,dark --screenshots=artifacts/themes
npm run audit -- https://example.com --matrix --themes=light,dark --screenshots=artifacts/themes --baseline-dir=visual-baselines --update-baselines
npm run audit -- https://example.com --matrix --themes=light,dark --screenshots=artifacts/themes --baseline-dir=visual-baselines --diff-dir=artifacts/theme-diffs --format=html --output=artifacts/theme-report.html
~~~

The deterministic contrast analyzer calculates WCAG text contrast from computed foreground colors and composited solid background-color layers. Normal text uses 4.5:1 and large text uses 3:1. Placeholders are sampled separately. It also checks detectable non-text component fills, visible borders, focus outlines, and inline SVG fills/strokes against their adjacent solid backgrounds using 3:1 (WCAG 1.4.11). Controls identified as disabled are recorded as exempt rather than failed. Background images/gradients, backdrop filters, ancestor opacity, unsupported color formats, and transparent background chains are marked **inconclusive** rather than reported as a pass or a failure. This is deliberately conservative; it does not yet determine pixel-level contrast over images, complex pseudo-element overlays, or every non-text control boundary.

The report compares root/body custom-property values between the light and dark runs for each viewport. It lists changed, unchanged, light-only, and dark-only tokens. It also inventories literal color declarations from readable CSS rules; literal colors are evidence for review, not automatic failures. Cross-origin stylesheets whose CSSOM is inaccessible are counted separately.

When both themes are requested, each viewport also performs an in-session round trip (starting theme → alternate theme → starting theme). It re-emulates the browser color preference, updates the configured storage key/attribute when supplied, then compares the restored CSS tokens and rendered text styles with the initial state. Any persistent token or text-style drift is reported as a review finding. This check is bounded and does not click the application's theme toggle, so it cannot trigger unrelated user actions.

The dual-theme option is opt-in to preserve existing single-theme matrix behavior and existing baseline filenames. Normal audits do not call any hosted AI service; AI visual critique remains a separate, explicit option.


## Private and local destinations

Remote audits block loopback, private, link-local, reserved IP addresses and local/reserved hostnames by default. The adapter re-checks HTTP(S) browser requests so redirects and page resources aimed at local networks are blocked as well.

For a local development server or a trusted private test environment, explicitly opt in:

~~~bash
npm run audit -- http://127.0.0.1:3000 --allow-private-network
npm run audit -- http://192.168.1.20 --matrix --allow-private-network
~~~

Do not use the opt-in flag for untrusted URLs. Only audit sites and networks you own or are authorized to test. The hostname check uses DNS answers observed by the Node.js process; it is a defense-in-depth safeguard, not a replacement for network egress controls against a hostile DNS rebinding environment.

## Isolated local preview audits

For local preview environments that must not contact third-party services, set `sameOriginOnly: true` when calling `auditUrl` or `auditViewports`. The target page and all browser resources must then use the exact same origin; HTTP(S) requests and WebSocket connections to other origins are blocked and recorded as blocked requests.

~~~js
const report = await auditViewports("http://127.0.0.1:4173/", {
  allowPrivateNetworks: true,
  sameOriginOnly: true,
  viewports: [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1365, height: 900 }
  ],
  screenshotDir: "artifacts/screenshots"
});
~~~

Use this mode with a temporary local server for previews that should not reach production databases, APIs, storage, analytics, or third-party hosts. It is an origin boundary, not a substitute for serving only safe preview files from the local server.

## Export reports

~~~bash
npm run audit -- https://example.com --matrix --format=markdown --output=reports/site-audit.md
npm run audit -- https://example.com --format=html --output=reports/site-audit.html
~~~

Formats: **json** (default), **markdown**, and **html**. Reports include target, status, summary, findings, recommendations, and rule execution details. HTML and Markdown output escape report content before rendering.

## Implemented specialist evidence

- **Responsive:** document overflow and visible element bounds.
- **UI/UX:** small text, small interactive targets, large vertical gaps, and overlapping or obscured interactive controls. For each intersecting control pair, the browser checks five points in the shared visible area and records the overlap percentage, hit-test winner, blocking selector, positioning, and stacking order.
- **Accessibility:** axe-core WCAG checks, missing image alt attributes, unlabeled visible form controls, missing document language, and skipped heading levels.
- **Performance:** large transferred resources, slow resources, images without reserved dimensions, and unusually large DOM trees.
- **Functional:** uncaught page JavaScript errors, failed network requests, and HTTP responses with status 400 or above.
- **Consistency:** image-ratio and action-height variation in detected repeated card components.

axe-core runs locally in the browser as a free open-source accessibility engine; it does not call a hosted AI service.

## Interactive overlap detection

The browser collector measures visible links, buttons, form controls, role=button elements, and keyboard-focusable targets at the active viewport. It compares their visible bounding boxes, excludes ancestor/descendant pairs (for example, an icon nested inside its own button), and checks five points in each meaningful intersection using the browser hit-test stack.

Findings include both selectors, the shared area, percentage of the smaller target covered, which target is blocked, the element covering it where identifiable, and the relevant positioning/z-index values. A mostly covered control is high severity; smaller or unconfirmed intersections are lower severity. The report is viewport-specific, so a mobile collision can be reported without claiming that the same controls collide on desktop.

Interactive exploration also recognizes explicit theme controls by accessible label, text, class/id, or `aria-pressed` (for example, dark mode, light mode, appearance, and tema). When safely activated, the report records the resulting theme marker, root `color-scheme`, and visible controls. Storage state is restored between candidate scenarios, and storage restoration is limited to the audited page origin.

The default detector reads the initial rendered page state. To inspect controls that are closed or collapsed by default, enable **interactive state exploration**:

~~~bash
npm run audit -- https://example.com --matrix --explore-interactions
npm run audit -- https://example.com --matrix --explore-interactions --max-interaction-actions=12
~~~

Interaction states can also use independent screenshot baselines and local pixel diffs. Their artifacts are stored below the viewport/theme directories, under `interaction-states/`:

~~~bash
# Create or intentionally refresh both page and interaction-state baselines
npm run audit -- https://example.com --matrix --themes=light,dark --screenshots=artifacts/themes --baseline-dir=visual-baselines --update-baselines --explore-interactions

# Compare the main viewport captures and all captured interaction states
npm run audit -- https://example.com --matrix --themes=light,dark --screenshots=artifacts/themes --baseline-dir=visual-baselines --diff-dir=artifacts/theme-diffs --explore-interactions --format=html --output=artifacts/theme-report.html
~~~

A missing or deliberately updated interaction-state baseline does not count as a pass. The viewport result is held for review when a captured interaction state has no accepted baseline or exceeds the configured pixel-difference threshold.

Exploration is opt-in. It only activates visible, enabled controls with recognizable disclosure semantics or toggle intent: collapsed `aria-expanded` controls, controls referencing hidden `aria-controls` targets, menu/dialog/listbox popups, tabs, closed `details/summary` disclosures, supported Bootstrap toggles, popover triggers, and clearly named menu/sidebar/drawer/dropdown/filter/expand controls. It skips links, submit/reset buttons, and controls whose labels suggest destructive or transactional actions (for example delete, save, send, purchase, or pay).

Each candidate is opened from a fresh load of the audited page, measured as a separate state, and then the original page is restored. The same-origin request policy remains active. The report records the trigger selector, state name, number of controls measured, overlaps, attempted actions, and any skipped controls. The screenshot and axe accessibility scan continue to represent the initial page state.

This approach can expose mobile hamburger menus, sidebars, dropdowns, tabs, accordions, and dialogs that are not visible on first load. It is intentionally bounded (8 candidates by default; configurable up to 30) and does not guess at every generic button. A custom control with no accessible name, state attribute, controlled target, or recognizable toggle class may still require an explicit test. Authenticated workflows, complex multi-step forms, hover-only tooltips, and actions that need application data are not automatically exercised. Intentional layered controls still need human review; geometry is evidence, not a subjective visual design verdict.

## Heuristic limitations

Automated checks identify measurable risks, not absolute design truth. Decorative images may intentionally use empty alt text; repeated-card checks require recognizable card selectors; cross-origin resource sizes can be unavailable; third-party errors may not be defects in the site itself; whitespace can be intentional. Review evidence before changing a site.

The adapter does not yet click through forms, authenticate to protected sites, exercise every hidden menu/modal state, test every browser engine, or make subjective design decisions.


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
