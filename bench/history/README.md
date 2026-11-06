# Permanent engine benchmark history

`history.jsonl` stores compact benchmark records committed to the active feature branch by the GitHub Actions workflow. Each line is one run and contains the three engines' scenario metrics, environment metadata, validation signals, and deltas against the latest compatible run.

## What is measured

- **JB Expert QA:** static-analysis duration, files/second, memory, finding counts, assessment completeness, and detection of a seeded request-to-fetch data-flow fixture.
- **Security Guard:** upload-inspection latency, throughput, and memory under sequential and concurrent synthetic uploads.
- **Malware Engine:** scan throughput, memory, 5,000 synthetic signatures, benign fixtures, and the harmless EICAR antivirus test marker.

## Comparison rules

Only runs with matching Node version, OS platform, architecture, and runner image are compared. CPU model is recorded as additional context. Median latency, p95 latency, throughput, MiB/second, and peak RSS deltas are informational; they do not impose machine-dependent pass/fail thresholds.

## Data and safety boundaries

All benchmark fixtures are generated locally. The Expert QA fixture contains one deliberately unsafe request-to-fetch flow. Malware Engine uses only benign text and the harmless EICAR antivirus test marker; no live malware is downloaded or executed. Security Guard uses in-memory storage and a deterministic synthetic scanner. The benchmarks make no paid API calls and do not connect to customer systems.

The history is stored in Git, so it remains available independently of temporary GitHub Actions artifacts. The JSONL format keeps commits small and makes each run append-only.

## Execution and quota policy

To avoid consuming Actions minutes on every small feature-branch commit, automatic runs are limited to pushes on `main` and pull requests targeting `main`. Each workflow also supports manual dispatch. Feature branches can be validated by opening a pull request or dispatching a workflow when a runner is available.

The permanent history writer appends records only from a valid run on `main` (push or manual dispatch on `main`). Pull-request and feature-branch runs produce temporary reports but do not commit history. This prevents benchmark runs from creating more pushes and triggering themselves.
