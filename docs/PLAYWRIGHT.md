# Browser audits with Playwright

The Playwright adapter opens a target URL in Chromium, collects measurable DOM evidence, and passes that evidence to deterministic specialist rules.

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

## Run the full viewport matrix

```bash
npm run audit -- https://example.com --matrix
```

The default matrix checks mobile (390×844), tablet (768×1024), and desktop (1365×900), then reports pass/fail and findings separately for each viewport.

## Current scope

Implemented: horizontal document overflow, visible elements beyond viewport bounds, mobile fixed-width heuristics, small text, unusually large vertical gaps, and small interactive targets.

The DOM collector is heuristic. A large whitespace region can be intentional; fixed-width detection currently uses inline CSS and width attributes; stylesheet-only fixed widths may instead be caught through measured overflow. This adapter does not yet click through forms, authenticate to protected sites, test every browser engine, or make subjective design decisions.

Only audit websites you own or are authorized to test. Avoid passing credentials in command-line arguments. The adapter supports HTTP(S) pages, including local development URLs.
