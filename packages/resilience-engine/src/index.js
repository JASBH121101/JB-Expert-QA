import { randomUUID } from "node:crypto";
import { evaluateRecoveryEligibility, validateResiliencePolicy } from "./policy.js";
import { createMemoryRecoveryStore } from "./recovery-store.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRecoveryStoreContract(store) {
  return isRecord(store) &&
    typeof store.claimRecovery === "function" &&
    typeof store.completeRecovery === "function" &&
    typeof store.getServiceState === "function" &&
    typeof store.listRecoveryHistory === "function";
}

function isHealthyResult(value) {
  if (value === true) return true;
  return isRecord(value) && value.healthy === true;
}

async function invokeWithTimeout(callback, input, timeoutMs, label) {
  const controller = new AbortController();
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(label + " timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback({ ...input, signal: controller.signal })),
      timeout
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function createResilienceEngine({
  policy,
  adapter,
  approvalVerifier = null,
  recoveryStore = null,
  requireDurableStore = false,
  requireHealthVerification = false,
  healthCheck = null,
  approvalTimeoutMs = 10_000,
  healthCheckTimeoutMs = 5_000,
  clock = Date.now
} = {}) {
  const validatedPolicy = validateResiliencePolicy(policy);
  if (!isRecord(adapter) || typeof adapter.restartService !== "function" ||
      !["linux-systemd", "windows-scm"].includes(adapter.platform)) {
    throw new TypeError("a supported Linux or Windows service adapter is required");
  }
  if (approvalVerifier !== null && typeof approvalVerifier !== "function") {
    throw new TypeError("approvalVerifier must be a function");
  }
  if (typeof requireDurableStore !== "boolean" || typeof requireHealthVerification !== "boolean") {
    throw new TypeError("recovery safety requirements must be boolean");
  }
  if (!Number.isSafeInteger(approvalTimeoutMs) || approvalTimeoutMs < 100 || approvalTimeoutMs > 60_000 ||
      !Number.isSafeInteger(healthCheckTimeoutMs) || healthCheckTimeoutMs < 100 || healthCheckTimeoutMs > 60_000) {
    throw new TypeError("approval and health-check timeouts must be between 100 and 60000 milliseconds");
  }
  if (healthCheck !== null && typeof healthCheck !== "function") {
    throw new TypeError("healthCheck must be a function");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const store = recoveryStore ?? createMemoryRecoveryStore();
  if (!hasRecoveryStoreContract(store)) {
    throw new TypeError("recoveryStore does not implement the required atomic ledger contract");
  }
  if (requireDurableStore && store.durable !== true) {
    throw new TypeError("a durable recoveryStore is required by this engine configuration");
  }
  if (requireHealthVerification &&
      typeof adapter.verifyService !== "function" && healthCheck === null) {
    throw new TypeError("a service verifier or host healthCheck is required");
  }

  const issuedProposals = new WeakSet();
  const consumedProposals = new WeakSet();
  const inFlightProposals = new WeakSet();

  function evaluateRecovery(state) {
    if (!isRecord(state)) return Object.freeze({ eligible: false, reason: "invalid-recovery-state" });
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 60_000)) {
      return Object.freeze({ eligible: false, reason: "invalid-clock" });
    }
    const eligibility = evaluateRecoveryEligibility(validatedPolicy, { ...state, now });
    if (!eligibility.eligible) return eligibility;
    const proposal = Object.freeze({
      schema: "jb.resilience.recovery-proposal/v1",
      proposalId: randomUUID(),
      nonce: randomUUID(),
      action: eligibility.action,
      serviceId: eligibility.serviceId,
      approvalRequired: eligibility.approvalRequired,
      reason: eligibility.reason,
      issuedAt: now,
      expiresAt: now + 60_000
    });
    issuedProposals.add(proposal);
    return Object.freeze({ eligible: true, proposal });
  }

  async function finalizeClaim(proposal, outcome) {
    const now = clock();
    const completedAt = Number.isSafeInteger(now) && now >= 0 ? now : proposal.expiresAt;
    try {
      await store.completeRecovery({ proposal, completedAt, outcome });
      return true;
    } catch {
      return false;
    }
  }

  async function executeRecovery({ proposal, approval = null } = {}) {
    if (!proposal || typeof proposal !== "object" || !issuedProposals.has(proposal)) {
      return Object.freeze({ executed: false, reason: "untrusted-or-unknown-proposal" });
    }
    if (consumedProposals.has(proposal) || inFlightProposals.has(proposal)) {
      return Object.freeze({ executed: false, reason: "proposal-already-consumed" });
    }
    const initialNow = clock();
    if (!Number.isSafeInteger(initialNow) || initialNow < 0) {
      return Object.freeze({ executed: false, reason: "invalid-clock" });
    }
    if (initialNow >= proposal.expiresAt) {
      consumedProposals.add(proposal);
      return Object.freeze({ executed: false, reason: "proposal-expired" });
    }

    inFlightProposals.add(proposal);
    try {
      if (proposal.approvalRequired) {
        let approved = false;
        try {
          approved = approvalVerifier && approval &&
            await invokeWithTimeout(
              approvalVerifier, { proposal, approval }, approvalTimeoutMs, "approval verifier"
            ) === true;
        } catch {
          approved = false;
        }
        if (!approved) {
          return Object.freeze({ executed: false, reason: "human-approval-required-or-invalid" });
        }
      }

      // Recheck after asynchronous approval and before the atomic, durable claim.
      const beforeClaim = clock();
      if (!Number.isSafeInteger(beforeClaim) || beforeClaim < 0) {
        return Object.freeze({ executed: false, reason: "invalid-clock" });
      }
      if (beforeClaim >= proposal.expiresAt) {
        consumedProposals.add(proposal);
        return Object.freeze({ executed: false, reason: "proposal-expired" });
      }

      let claim;
      try {
        claim = await store.claimRecovery({
          proposal,
          claimedAt: beforeClaim,
          maxRestarts: validatedPolicy.maxRestarts
        });
      } catch {
        return Object.freeze({ executed: false, reason: "recovery-ledger-unavailable" });
      }
      if (!claim?.claimed) {
        consumedProposals.add(proposal);
        return Object.freeze({
          executed: false,
          reason: typeof claim?.reason === "string" ? claim.reason : "recovery-claim-rejected"
        });
      }

      // The claim is durable before any OS action. If expiry occurs here, the attempt stays consumed.
      const beforeAdapter = clock();
      if (!Number.isSafeInteger(beforeAdapter) || beforeAdapter < 0) {
        consumedProposals.add(proposal);
        const ledgerRecorded = await finalizeClaim(proposal, "failed");
        return Object.freeze({
          executed: false, reason: "invalid-clock", ledgerRecorded
        });
      }
      if (beforeAdapter >= proposal.expiresAt) {
        consumedProposals.add(proposal);
        const ledgerRecorded = await finalizeClaim(proposal, "failed");
        return Object.freeze({
          executed: false, reason: "proposal-expired", ledgerRecorded
        });
      }

      consumedProposals.add(proposal);
      let adapterResult;
      try {
        adapterResult = await adapter.restartService(proposal.serviceId);
      } catch {
        const ledgerRecorded = await finalizeClaim(proposal, "failed");
        return Object.freeze({
          executed: false,
          reason: "recovery-adapter-failed",
          serviceId: proposal.serviceId,
          ledgerRecorded
        });
      }

      const verificationResults = [];
      let verificationFailed = false;
      try {
        if (typeof adapter.verifyService === "function") {
          verificationResults.push(isHealthyResult(
            await adapter.verifyService(proposal.serviceId)
          ));
        }
        if (healthCheck !== null) {
          verificationResults.push(isHealthyResult(
            await invokeWithTimeout(
              healthCheck, { proposal, adapterResult }, healthCheckTimeoutMs, "health check"
            )
          ));
        }
      } catch {
        verificationFailed = true;
        verificationResults.push(false);
      }

      const verified = verificationResults.length > 0;
      const recovered = verified ? verificationResults.every(Boolean) : null;
      const outcome = verificationFailed
        ? "verification-failed"
        : recovered === true ? "succeeded"
        : recovered === false ? "verification-failed" : "unverified";
      const ledgerRecorded = await finalizeClaim(proposal, outcome);

      return Object.freeze({
        executed: true,
        recovered,
        verified,
        reason: ledgerRecorded
          ? recovered === false ? "post-recovery-health-check-failed" : null
          : "recovery-ledger-finalization-failed",
        ledgerRecorded,
        action: proposal.action,
        serviceId: proposal.serviceId,
        platform: adapter.platform,
        result: adapterResult
      });
    } finally {
      inFlightProposals.delete(proposal);
    }
  }

  return Object.freeze({
    engine: "JB Resilience Engine",
    version: "0.1.0",
    platform: adapter.platform,
    mode: validatedPolicy.mode,
    durableStore: store.durable === true,
    evaluateRecovery,
    executeRecovery,
    recoveryStore: store
  });
}

export { validateResiliencePolicy, evaluateRecoveryEligibility } from "./policy.js";
export { createHealthMonitor } from "./health-monitor.js";
export { createFileRecoveryStore, createMemoryRecoveryStore } from "./recovery-store.js";

export {
  computeAdvancedPolicyHash,
  validateAdvancedResiliencePolicy,
  createResiliencePolicyEngine,
  createMemoryPolicyRevisionStore,
  createMemoryCapabilityLedger
} from "./policy-engine.js";

export {
  createTrustedSignalGateway,
  createMemoryTrustedSignalStore,
  signTrustedSignalEnvelope,
  validateTrustedSignalEnvelope
} from "./trusted-signal-gateway.js";

export { createFileTrustedSignalStore } from "./trusted-signal-store.js";
export { createSecurityGuardSignalProducer } from "./producers/security-guard.js";
export { createMalwareEngineSignalProducer } from "./producers/malware-engine.js";
