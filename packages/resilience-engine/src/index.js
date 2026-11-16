import { evaluateRecoveryEligibility, validateResiliencePolicy } from "./policy.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createResilienceEngine({ policy, adapter, approvalVerifier = null, clock = Date.now } = {}) {
  const validatedPolicy = validateResiliencePolicy(policy);
  if (!isRecord(adapter) || typeof adapter.restartService !== "function" ||
      !["linux-systemd", "windows-scm"].includes(adapter.platform)) {
    throw new TypeError("a supported Linux or Windows service adapter is required");
  }
  if (approvalVerifier !== null && typeof approvalVerifier !== "function") {
    throw new TypeError("approvalVerifier must be a function");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const issuedProposals = new WeakSet();

  function evaluateRecovery(state) {
    const now = clock();
    const eligibility = evaluateRecoveryEligibility(validatedPolicy, { ...state, now });
    if (!eligibility.eligible) return eligibility;
    const proposal = Object.freeze({
      schema: "jb.resilience.recovery-proposal/v1",
      action: eligibility.action, serviceId: eligibility.serviceId,
      approvalRequired: eligibility.approvalRequired, reason: eligibility.reason,
      issuedAt: now, expiresAt: now + 60_000
    });
    issuedProposals.add(proposal);
    return Object.freeze({ eligible: true, proposal });
  }

  async function executeRecovery({ proposal, approval = null } = {}) {
    if (!proposal || typeof proposal !== "object" || !issuedProposals.has(proposal)) {
      return Object.freeze({ executed: false, reason: "untrusted-or-unknown-proposal" });
    }
    if (clock() > proposal.expiresAt) {
      return Object.freeze({ executed: false, reason: "proposal-expired" });
    }
    if (proposal.approvalRequired &&
        (!approvalVerifier || !approval ||
         await approvalVerifier({ proposal, approval }) !== true)) {
      return Object.freeze({ executed: false, reason: "human-approval-required-or-invalid" });
    }
    try {
      const result = await adapter.restartService(proposal.serviceId);
      return Object.freeze({
        executed: true, action: proposal.action, serviceId: proposal.serviceId,
        platform: adapter.platform, result
      });
    } catch {
      return Object.freeze({
        executed: false, reason: "recovery-adapter-failed", serviceId: proposal.serviceId
      });
    }
  }

  return Object.freeze({
    engine: "JB Resilience Engine", version: "0.1.0",
    platform: adapter.platform, mode: validatedPolicy.mode,
    evaluateRecovery, executeRecovery
  });
}

export { validateResiliencePolicy, evaluateRecoveryEligibility } from "./policy.js";
