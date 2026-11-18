# JB Resilience — A1 Operational Lab Evidence v1

**Report schema:** jb.resilience.os-service-manager-lab-report/v1  
**Workflow job:** Real service manager lab  
**Target platforms:** Ubuntu 24.04 / systemd and Windows Server 2022 / Service Control Manager  
**Runtime:** Node.js 24  
**Artifact retention:** 30 days

## Purpose

The Engine Certification workflow exercises the existing typed Linux systemd and Windows SCM adapters against a disposable service created by the GitHub-hosted runner. It records structured evidence rather than leaving the outcome only in transient console text.

Each successful runner uploads a platform-specific JSON report. The report binds:
- the source commit SHA and workflow run ID;
- generation timestamp and Node/platform/architecture metadata;
- platform-specific service-manager identity and disposable service name;
- process ID before and after the restart;
- restart result and post-restart service state;
- explicit scope flags stating that no customer or production service was tested and that A2/A3 remain non-executable.

## What the lab proves

For the specific disposable CI service and runner:
1. the typed adapter invoked the platform service manager using its constrained command interface;
2. the service process was replaced (PID changed);
3. the service manager reported the expected active state after restart;
4. cleanup removed the disposable service and its temporary files.

## What it does not prove

- It does not certify an arbitrary customer's Linux or Windows host, service configuration, permissions, security baseline, storage, network, monitoring or operator procedure.
- It does not prove recovery of the customer's application or data; application health is a separate host integration.
- It does not certify A2 containment, A3 failover, external providers, quorum, fencing, rollback or production readiness.
- It does not authorize a service restart outside the disposable CI test.

A passing runner result is evidence for the named OS adapter's laboratory behavior on that hosted runner only. ARC must continue to expose the actual runtime as semi-autonomous and keep A2/A3 denied.

## Failure handling

A missing systemd/SCM facility, permission error, timeout, invalid service state or unchanged PID fails the job. An artifact is uploaded only after the service-manager exercise succeeds. The CI job has read-only repository permissions and uses a uniquely named disposable service, fixed command arguments and shell execution disabled.
