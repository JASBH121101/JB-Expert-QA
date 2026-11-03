# JB Expert QA — supervised autonomy and AI budget policy

JB Expert QA separates deterministic QA from optional AI assistance. The local engine remains the default and continues to work when every AI provider is disabled or out of quota.

## 1. Deterministic project audit (default)

~~~bash
npm install
npm run audit:project -- .
~~~

The local scanner is read-only. It does not execute application code, install dependencies, query vulnerability services or connect to a database. It skips environment and credential files and reports whether the scan was complete.

Running the autopilot without an AI opt-in also performs only the local audit:

~~~bash
npm run autopilot -- .
~~~

The result is labelled `ai-not-requested`. No Gemini or Cloudflare request is made.

## 2. AI only for projects worth the quota

AI is off by default. To request deep analysis, use the explicit flag:

~~~bash
npm run autopilot -- . --ai-deep-analysis
~~~

The default eligibility gate requires **both** at least 100 scanned source/configuration/documentation files and at least 1 MiB of scanned text. The scan must also be complete. If either size threshold is not met, or the scan is incomplete, JB Expert QA returns the local report and does not call an AI provider.

The thresholds can be raised or deliberately adjusted for a particular repository:

~~~bash
npm run autopilot -- . --ai-deep-analysis --min-ai-files=150 --min-ai-bytes=2097152
~~~

Use lower thresholds only for a deliberate, high-value audit. Generated folders, dependencies, build outputs, binary files, and ignored directories do not count as scanned source.

## 3. Provider order and quota stop

When deep analysis is explicitly enabled, the provider router uses this order:

1. **Google Gemini** — primary provider.
2. **Cloudflare Workers AI** — fallback after Gemini quota exhaustion or a transient Gemini availability/network failure.
3. **Local deterministic engine** — final fallback; no further AI requests.

The router remembers provider failure for the current process. Once Gemini is rate-limited/quota-exhausted, it does not call Gemini again during that run. When Cloudflare reports its **daily** free allocation is exhausted, JB Expert QA writes a small quota marker (no keys or prompts) to `~/.jb-expert-qa/provider-quota.json`. On the same machine, Cloudflare is not called again until the UTC day changes (00:00 UTC); Gemini may still be used if it remains available. If Cloudflare reaches only the local per-run request cap, all AI is disabled for the remainder of that run. The website GitHub Actions workflow also restores/saves the daily marker in the Actions cache using the UTC date, so separate workflow runs that day do not keep probing an exhausted Cloudflare free allowance. GitHub-hosted runners otherwise have ephemeral local disks. It does not rotate back to an exhausted provider, retry in a loop, or silently switch to paid models. Set `JBQA_AI_QUOTA_STATE_PATH` to choose another marker-file path.

Cloudflare is limited to these model IDs in this release:

- Text: `@cf/meta/llama-3.1-8b-instruct`
- Visual: `@cf/meta/llama-3.2-11b-vision-instruct`

Other model IDs, including models documented as requiring a paid billing method, are rejected by the provider allowlist. The Cloudflare provider defaults to at most four requests per run (maximum configurable value: ten). Provider status in reports also exposes the local per-run request count, maximum, and remaining requests when the Cloudflare provider is available; it does not claim to know account-wide Neuron consumption.

### Credentials and free-tier guard

Gemini:

- `GEMINI_API_KEY`
- Optional: `GEMINI_TEXT_MODEL`, `GEMINI_VISION_MODEL`

Cloudflare fallback:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` created from Cloudflare's Workers AI API token flow, with **Workers AI - Read and Workers AI - Edit** permissions (the current REST API setup guide requests both).
- `CLOUDFLARE_FREE_TIER_CONFIRMED=true`
- Optional: `CLOUDFLARE_MAX_REQUESTS_PER_RUN=4`

**Important billing boundary:** Cloudflare documents a shared allowance of 10,000 Neurons per day, resetting at 00:00 UTC. On Workers Free, inference beyond that allocation fails. On Workers Paid, usage above the free allocation is billable at the published rate. The environment flag `CLOUDFLARE_FREE_TIER_CONFIRMED=true` is an explicit operator confirmation; the API does not let this library independently verify the account's billing plan. The GitHub Actions workflow caches only the quota-exhausted marker (never credentials or prompts), keyed by the Cloudflare UTC reset date. Set it only after confirming the account is on Workers Free and no Workers Paid billing has been enabled. Usage by other Workers AI workloads in the same account can consume the shared daily allowance. If zero overage risk is required, do not enable the Cloudflare fallback on an account with paid Workers billing.

Monitor consumption in the Cloudflare Workers AI dashboard. Quota data and billing tier are controlled by Cloudflare, not JB Expert QA. GitHub-hosted runners are ephemeral, but the website-audit workflow restores and saves the quota marker through the Actions cache, keyed by the UTC reset date. Other workflows or local machines do not share that cache unless they implement the same marker handoff; Cloudflare's own Free-plan rejection remains the final protection when the account-wide allowance is exhausted.

For the first visual call, Cloudflare's Llama 3.2 Vision model requires the Meta licence and acceptable-use terms to be accepted once. Do this deliberately from Cloudflare's documented model instructions before enabling visual fallback. JB Expert QA does not silently accept third-party model terms on the user's behalf.

## 4. Optional visual critique

A website visual critique is never automatic. It requires screenshot capture, the viewport matrix, and the explicit `--ai-visual-review` flag:

~~~bash
npm run audit -- https://example.com --matrix --screenshots=reports/screenshots --ai-visual-review --format=html --output=reports/audit.html
~~~

Use it for a deliberate, high-value review. It sends the selected screenshots and bounded browser findings to the configured AI provider. The screenshot-review path uses the same Gemini → Cloudflare → local-offline policy; pixel-level visual regression remains local and does not need AI.

## 5. Supervised low-risk repair

Only use this on a repository you trust and after reviewing the plan:

~~~bash
npm run autopilot -- . --ai-deep-analysis --apply-low-risk --allow-source-upload --run-tests
~~~

All four flags are mandatory for repair:

- **--ai-deep-analysis** explicitly enables the provider router.
- **--apply-low-risk** requests a patch attempt.
- **--allow-source-upload** explicitly permits selected, redacted source snippets to be sent to the configured AI provider.
- **--run-tests** explicitly permits running the project's test suite.

The runner also requires a clean Git working tree. It creates a new local branch and Git worktree, asks for one low-risk task, permits only existing source files below `src/`, validates the unified diff against the allowlist, applies the patch in the worktree, runs Node syntax checks for changed JavaScript files and runs `node --test`. It performs a second static audit and rejects a newly introduced critical finding. It allows at most two patch/validation attempts.

Protected areas include credentials, environment files, Git metadata, CI/deployment files, package manifests and lockfiles, configuration, authentication/authorization, sessions, payments, billing, databases, SQL, migrations, infrastructure and Supabase. It does not create, delete, rename or modify binary files. Medium- and high-risk tasks are not auto-applied.

A successful result is left in the local worktree for manual inspection. JB Expert QA does not commit, push, open a pull request, merge or deploy. A failed attempt removes the temporary worktree and local repair branch.

## Important execution and privacy boundaries

A Git worktree is change isolation, not an operating-system security sandbox. Running `node --test` executes the target project's test code on the local machine. Tests may have side effects, access files or use the network. Use auto-repair only for a trusted repository in an environment where running its tests is acceptable. JB Expert QA does not install packages or alter test scripts to make them pass.

The Gemini API is called directly over HTTPS. Cloudflare Workers AI uses its account REST endpoint. Keys are read from environment variables and are never stored in the repository or browser. The planning request contains findings and bounded metadata, not project source. Screenshot critique sends only the selected PNG captures and bounded browser findings. Auto-repair is a separate, more sensitive action and uploads only allowlisted source files after explicit consent, with simple credential-pattern redaction before transmission. Redaction is defense in depth, not a guarantee that all private data can be detected. Do not send customer data, private administrator screens, secrets or other sensitive code to an external model.

There is no Supabase client, database, storage bucket or Supabase function in this AI layer. AI quota limits, billing, data handling, model availability and provider terms are controlled by Google and Cloudflare and can change. If no provider is configured or the quotas are exhausted, local deterministic checks and pixel comparison remain available without AI.
