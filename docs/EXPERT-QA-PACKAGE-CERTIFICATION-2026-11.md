# JB Expert QA — Package QA certification

## Exact source snapshot
- Repository: `JASBH121101/JB-Expert-QA`
- Source commit: `1feb1be76949e0cbd736b919e540fcf59b1fae97`
- Source ref: `certify/currency-qa-engine-v1`
- NPM package distribution workflow: https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44410659430
- Node.js 22 job: https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44410659430/job/135177627561 — success.
- Node.js 24 job: https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44410659430/job/135177628029 — success.

## Assessed components
- **Clean consumer installation:** seven JB engine package tarballs are created with npm pack and installed into separate temporary directories outside the monorepo. Install scripts are disabled during consumer install.
- **Public exports and entrypoints:** smoke tests import package roots and documented subpaths, inspect required API functions and exercise CLI/browser entrypoints.
- **Dependency and package boundaries:** the installed tarballs execute their designated smoke tests without relying on monorepo workspace resolution. This proves only the tested package boundary and declared dependencies.

## SCCM hierarchy
The existing Package QA module PASS assessment is preserved on its original source snapshot. New PASS assessments were appended for the branch, distribution subbranch and three components. The overall Expert QA engine remains PENDING because its other critical branches are not yet all certified.

## Limitations
The matrix does not prove compatibility with every downstream host application, deployment target or package manager version. Consumers must still validate their own lockfiles, runtime, browser installation and optional peer integrations. No paid services or additional dependencies are introduced by this certification.
