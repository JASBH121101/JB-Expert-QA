# Security policy

## Reporting a vulnerability

Please do not publish exploit details, credentials, customer data, or an unpatched vulnerability in a public issue.

Use GitHub's private vulnerability reporting or Security Advisories for this repository when enabled. Otherwise, contact the repository owner privately through GitHub and provide a concise report.

A useful report includes:

- Affected engine, version, commit, and environment.
- Preconditions and a minimal reproducible test case.
- Security impact and realistic attack prerequisites.
- Logs or evidence with secrets and personal data removed.
- A suggested mitigation, where known.

Do not include live credentials, access tokens, private keys, customer records, or executable malware samples in a report.

## Secure development expectations

- Keep credentials in a secret manager or local environment, never in source control.
- Rotate any credential that may have been exposed, even if it is later removed from the visible file.
- Keep untrusted uploads quarantined until a real scanner returns an explicit clean verdict.
- Treat `unknown`, partial parser results, timeouts, and unavailable scanners as incomplete, not clean.
- Run parser fuzz tests against synthetic or legally distributable fixtures. Do not execute suspicious samples on development machines.
- Review changes to URL fetching, process execution, filesystem access, archive extraction, and signature trust roots carefully.
- Do not claim production readiness based solely on unit tests or synthetic benchmarks.
