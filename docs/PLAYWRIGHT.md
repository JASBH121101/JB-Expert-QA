# Browser audits with Playwright

The Playwright adapter opens a target URL in Chromium, collects measurable DOM, resource, accessibility, and runtime evidence, and passes it to deterministic specialist rules.

## Setup

```bash
npm install
npx playwright install chromium
```

## Run one viewport

```bash
npm run audit -- https://example.com
npm run audit -- https://example.com --mobile
```

The default viewport is 1365×900; `--mobile` uses 390×844.

## Run the responsive matrix

```bash
npm run audit -- https://example.com --matrix
```

The default matrix checks mobile (390×844), tablet (768×1024), and desktop (1365×900), then reports pass/fail and findings separately for each viewport.

## Implemented specialist evidence

- **Responsive:** document overflow and visible element bounds.
- **UI/UX:** small text, small interactive targets, and large vertical gaps between top-level content blocks.
- **Accessibility:** missing image alt attributes, unlabeled visible form controls, missing document language, and skipped heading levels.
- **Performance:** large transferred resources, slow resources, images without reserved dimensions, and unusually large DOM trees.
- **Functional:** uncaught page JavaScript errors, failed network requests, and HTTP responses with status 400 or above.
- **Consistency:** image-ratio and action-height variation in detected repeated card components.

## Heuristic limitations

Automated checks identify measurable risks, not absolute design truth. Decorative images may intentionally use empty alt text; repeated-card checks require recognizable card selectors; cross-origin resource sizes can be unavailable; third-party errors may not be defects in the site itself; whitespace can be intentional. Review evidence before changing a site.

The first adapter does not yet click through forms, authenticate to protected sites, test every browser engine, or make subjective design decisions.

Only audit websites you own or are authorized to test. Avoid passing credentials in command-line arguments. The adapter supports HTTP(S) pages, including local development URLs.
