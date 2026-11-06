# JB Security Guard benchmark

Run locally from the repository root:

```sh
BENCH_ITERATIONS=10 BENCH_OUTPUT_DIR=benchmark-results node bench/security-guard.js
```

The benchmark uses the real `createUploadInspector` pipeline with deterministic in-memory storage and scanner adapters. It records sequential upload performance at three sizes and a six-upload concurrency scenario. Metrics include mean, median, p95, p99, upload throughput, CPU time, and sampled peak RSS.

Fixtures contain a PNG signature followed by inert bytes. They are synthetic pipeline fixtures, not valid image files and not malware samples. The adapters are test doubles, so the benchmark isolates Security Guard overhead rather than remote scanner or storage latency. The live Expert QA Security Bridge is not included in this initial benchmark.

The workflow runs automatically when `packages/security-guard/**` or benchmark files change on `feature/jb-security-guard`. It can also be started manually from GitHub Actions. JSON and Markdown reports are uploaded for 30 days and the Markdown report is added to the workflow summary.

No paid services, external network calls, cloud storage, or third-party benchmark packages are used. Results are informational and must be compared on equivalent runners and Node versions.

## Execution and quota policy

To avoid consuming Actions minutes on every small feature-branch commit, automatic runs are limited to pushes on `main` and pull requests targeting `main`. Each workflow also supports manual dispatch. Feature branches can be validated by opening a pull request or dispatching a workflow when a runner is available.

The permanent history writer appends records only from a valid run on `main` (push or manual dispatch on `main`). Pull-request and feature-branch runs produce temporary reports but do not commit history. This prevents benchmark runs from creating more pushes and triggering themselves.
