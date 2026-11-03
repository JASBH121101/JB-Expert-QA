# JB Expert QA — supervised autonomy

JB Expert QA has three separate levels. None is enabled implicitly.

## 1. Deterministic project audit

~~~bash
npm install
npm run audit:project -- .
~~~

The local scanner is read-only. It does not execute application code, install dependencies, query vulnerability services or connect to a database. It skips environment and credential files and reports whether the scan was complete.

## 2. AI remediation planning

Configure a Gemini API key as a local environment variable. The default text model is configurable with GEMINI_TEXT_MODEL.

~~~bash
GEMINI_API_KEY=your_key npm run autopilot -- .
~~~

This first runs the deterministic project audit and sends the normalized findings and limited project metadata to Gemini. It does not upload source files, write patches or change the repository. The result is an ordered plan; every task remains approval-gated.

## 3. Explicit low-risk repair attempt

Only use this on a repository you trust and after reviewing the plan:

~~~bash
GEMINI_API_KEY=your_key npm run autopilot -- . --apply-low-risk --allow-source-upload --run-tests
~~~

All three flags are mandatory for repair:

- **--apply-low-risk** requests a patch attempt.
- **--allow-source-upload** explicitly permits selected, redacted source snippets to be sent to Gemini.
- **--run-tests** explicitly permits running the project's test suite.

The runner also requires a clean Git working tree. It creates a new local branch and Git worktree, asks for one low-risk task, permits only existing source files below src/, validates the unified diff against the allowlist, applies the patch in the worktree, runs Node syntax checks for changed JavaScript files and runs node --test. It performs a second static audit and rejects a newly introduced critical finding. It allows at most two patch/validation attempts.

Protected areas include credentials, environment files, Git metadata, CI/deployment files, package manifests and lockfiles, configuration, authentication/authorization, sessions, payments, billing, databases, SQL, migrations, infrastructure and Supabase. It does not create, delete, rename or modify binary files. Medium- and high-risk tasks are not auto-applied.

A successful result is left in the local worktree for manual inspection. JB Expert QA does not commit, push, open a pull request, merge or deploy. A failed attempt removes the temporary worktree and local repair branch.

## Important execution boundary

A Git worktree is change isolation, not an operating-system security sandbox. Running node --test executes the target project's test code on the local machine. Tests may have side effects, access files or use the network. Use auto-repair only for a trusted repository in an environment where running its tests is acceptable. JB Expert QA does not install packages or alter test scripts to make them pass.

The agent is supervised, not fully autonomous: model suggestions may be inaccurate, all repairs require explicit flags, and a human must review the resulting diff and report. It never has production database credentials and cannot run production migrations.

## Provider and privacy

The Gemini API is called directly over HTTPS. The key is read from GEMINI_API_KEY and is never stored in the repository or browser. GEMINI_TEXT_MODEL and GEMINI_VISION_MODEL select models for planning and screenshot review. There is no Supabase client, database, storage bucket or Supabase function in this AI layer.

The planning request contains findings and bounded metadata, not project source. Screenshot critique sends only the selected PNG captures and bounded browser findings. Auto-repair is a separate, more sensitive action and uploads only allowlisted source files after explicit consent, with simple credential-pattern redaction before transmission. Redaction is defense in depth, not a guarantee that all private data can be detected. Do not send customer data, private administrator screens, secrets or other sensitive code to an external model.

Model quotas, pricing, data handling and model availability are controlled by the provider and can change. Configure the provider according to the terms of the selected account. If the model is unavailable or the quota is exhausted, the deterministic scanners and pixel comparison remain available without AI.
