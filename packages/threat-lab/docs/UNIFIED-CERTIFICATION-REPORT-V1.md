# JB Threat Lab — Unified Certification Report v1

**Schema:** jb.threat-lab.unified-certification-report/v1  
**Source schema:** jb.threat-lab.report/v2  
**Builder:** scripts/build-threat-lab-certification-report.mjs  
**Artifact:** jb-threat-lab-unified-certification-*  
**Retention:** 30 days

## Source reports

The Threat Lab integration suites remain independently executable and each produces its original v2 report. When CI sets JB_THREAT_LAB_REPORT_DIR, the integration tests persist these reports atomically:

- core-engines: Malware Engine, Security Guard and Expert QA;
- advisor-engine: Advisor Engine;
- nexora-configurable-catalog: NEXORA frontend/catalog prototype;
- nexora-site-engine: Laravel Site Engine;
- trojan-defense: Malware Engine static-triage/containment fixtures;
- trojan-pe-rat: synthetic PE/RAT/backdoor and credential-threat correlation fixtures;
- trojan-persistence: inert script-persistence correlation fixtures.

No report is synthesized from workflow status alone. The builder consumes the original per-scenario outcomes emitted by createThreatLab.

## Integrity checks

The builder rejects:
- missing/unsupported source report schema;
- duplicate report IDs;
- malformed target/scenario/result entries;
- duplicate target/scenario pairs across reports;
- conflicting kind/version metadata for the same target;
- missing required targets.

It preserves each original result and tags it with its source report. It does not convert a skip into a pass.

## Readiness semantics

The unified assessment uses the same six-tier weighting and readiness rules as Threat Lab v2:
- Basic, Intermediate, Advanced, Expert, Extreme and Superextreme are reported separately.
- A target with a missing tier is not ready.
- A failed scenario is not ready.
- An adapter/report-budget skip is not ready.
- A structural target-scope skip remains visible but is excluded from the target's applicable score.
- A required target absent from all source reports is listed as missing and blocks the unified ready state.

The required default targets in the monorepo report are the four JB engines:
jb-malware-engine, jb-security-guard, jb-expert-qa and jb-advisor-engine.

NEXORA Configurable Catalog and NEXORA Site Engine are separately scoped targets validated by the dedicated NEXORA Threat Lab product workflow. Their source repositories are not mounted in the monorepo certification runner, so their absence from this report is not interpreted as either a pass or a failure. If their product reports are explicitly added to a future combined product-level report, they remain separate target identities and readiness records.

## Artifact and interpretation

The Engine Certification workflow builds the unified report in each OS/Node matrix lane and uploads it alongside the original source reports. The output includes commit SHA, Node runtime, platform, architecture, source report summaries, aggregate counts, missing targets, target-level coverage and original scenario results.

The report certifies only the safe scenarios that actually executed in those local integration suites. It does not prove absence of malware, vulnerabilities or defects, does not sandbox untrusted adapter code, and is not production or third-party certification. NEXORA prototype and Laravel profiles remain separate targets; a pass in one does not certify the other.
