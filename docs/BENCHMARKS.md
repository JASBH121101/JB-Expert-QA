# JB Security Guard benchmark

Run locally from the repository root:

```sh
BENCH_ITERATIONS=10 BENCH_OUTPUT_DIR=benchmark-results node bench/security-guard.js
```

The benchmark uses the real `createUploadInspector` pipeline with deterministic in-memory storage and scanner adapters. It records sequential upload performance at three sizes and a six-upload concurrency scenario. Metrics include mean, median, p95, p99, upload throughput, CPU time, and sampled peak RSS.

Fixtures contain a PNG signature followed by inert bytes. They are synthetic pipeline fixtures, not valid image files and not malware samples. The adapters are test doubles, so the benchmark isolates Security Guard overhead rather than remote scanner or storage latency. The live Expert QA Security Bridge is not included in this initial benchmark.

The workflow runs automatically when `packages/security-guard/**` or benchmark files change on `feature/jb-security-guard`. It can also be started manually from GitHub Actions. JSON and Markdown reports are uploaded for 30 days and the Markdown report is added to the workflow summary.

No paid services, external network calls, cloud storage, or third-party benchmark packages are used. Results are informational and must be compared on equivalent runners and Node versions.
