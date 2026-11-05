# JB Expert QA — Security QA

## Purpose

Security QA is a dedicated, reusable static-security profile inside JB Expert QA. It runs the existing project security rules together with additional defensive checks, using the same scanner, rule registry, scoring engine, and JSON/Markdown/HTML reporters as the general project auditor.

It is intended for repositories the operator owns or is authorized to assess.

## Run locally

~~~bash
npm run audit:security -- .
~~~

Choose a report format or output path:

~~~bash
npm run audit:security -- . --format=markdown --output=reports/security-report.md
npm run audit:security -- . --format=json --output=reports/security-report.json
~~~

Use a custom profile:

~~~bash
npm run audit:security -- . --config=config/security-audit.config.json
~~~

The default security profile has a 90/100 minimum score. Critical findings block approval, and incomplete scans cannot pass. High-severity findings reduce the score and may block approval depending on the configured threshold.

## Checks included

The existing security specialist continues to check for credential-like literals (without reporting the value), dynamic code execution, unsafe TLS configuration, risky dynamic HTML sinks, and local environment or credential files without opening their contents.

The dedicated rules add checks for:

- External endpoints configured with plain HTTP.
- Wildcard CORS origins combined with credentialed requests.
- Authentication cookies missing visible HttpOnly, Secure, or SameSite attributes.
- MD5 or SHA-1 usage in password-related source files.
- Math.random() used near security-sensitive values.
- JWT decoding near authorization logic without a visible verification call in the same file.
- Redirects that appear to use request-controlled destinations.
- Outbound HTTP requests that appear to use request-controlled input.

Every heuristic finding includes a file/line location, severity, detector identifier, and remediation guidance. The analyzer does not copy source lines or detected secret values into findings.

## Execution and data boundaries

This profile is local and static:

- It does not execute the target application's code.
- It does not send attack payloads or issue HTTP requests.
- It does not connect to a live database, Cloudflare account, storage bucket, or production service.
- It does not install target-project dependencies.
- It does not open environment or credential files; it records their paths only.
- It makes no network requests. The default profile disables online dependency advisory lookup.

## Important limitations

Static analysis is not a penetration test. Pattern matching cannot fully trace tainted values, framework middleware, multi-line cookie options, authentication context, network boundaries, or controls implemented in an external dashboard. A finding requires human review, and no findings do not prove that an application is secure.

For a full security review, combine this profile with dependency advisory checks, runtime security-header validation, authenticated role/access tests in a disposable staging environment, backup/restore exercises, and a controlled penetration test. Never run destructive or exploit-style tests against production data.

## CI

The Security QA GitHub Actions workflow runs deterministic security-profile tests for changes to JB Expert QA. The regular Core validation workflow remains enabled as the broader regression suite. Security QA results are designed to be consumed by other repositories through a pinned JB Expert QA release or commit; consuming repositories should not need a new personal token for each engine update when access is configured with a stable, least-privilege GitHub App or read-only package/repository credential.
