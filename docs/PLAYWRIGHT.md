# Browser audits with Playwright

The Playwright adapter opens a target URL in Chromium, collects measurable DOM evidence, and passes that evidence to the deterministic specialist rules.

## Setup

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm run audit -- https://example.com
npm run audit -- https://example.com --mobile
```

The first profile targets a desktop viewport (1365×900); `--mobile` uses 390×844.

## Scope and limitations

The first adapter implements evidence collection for the Responsive and UI/UX specialists only. It does not click through forms, authenticate to protected sites, inspect every possible viewport, or infer design intent. A detected large gap is a heuristic requiring human review; whitespace can be intentional.

Only audit websites you own or are authorized to test. Avoid passing credentials in command-line arguments. The adapter currently audits publicly reachable HTTP(S) pages and local development URLs.
