# JB Expert QA benchmark

Run locally from the repository root:

```sh
BENCH_ITERATIONS=12 BENCH_OUTPUT_DIR=benchmark-results node bench/run.js
```

The benchmark exercises the real `ExpertQAEngine`, `RuleRegistry`, diagnostic creation, and scoring pipeline using deterministic synthetic rules and in-memory text fixtures. It records mean, median, p95, p99, throughput, CPU time, and sampled peak RSS.

The workflow runs automatically when Expert QA source or benchmark files change on `feature/jb-security-qa`. It can also be started manually from GitHub Actions. Each run publishes JSON and Markdown reports as an artifact for 30 days and adds the Markdown report to the workflow summary.

No network calls, paid APIs, browser launches, external databases, or third-party benchmark packages are used. Metrics are informational; compare runs only when the runner image, Node version, architecture, and workload match.
