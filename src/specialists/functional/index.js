import { getElements } from "../shared/context.js";

export const functionalRules = [
  {
    id: "functional.javascript-error",
    specialist: "functional",
    evaluate(context) {
      return getElements(context, "pageErrors").map((issue, index) => ({
        id: "FUNC-001-" + (index + 1),
        title: "Uncaught JavaScript error",
        description: String(issue.message ?? "A page-level JavaScript error occurred."),
        severity: "high",
        location: issue.url ?? null,
        evidence: issue,
        recommendation: "Inspect the browser error and fix the uncaught exception."
      }));
    }
  },
  {
    id: "functional.failed-request",
    specialist: "functional",
    evaluate(context) {
      return getElements(context, "failedRequests")
        .filter((issue) => !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/i.test(String(issue.failureText ?? "")))
        .slice(0, 30)
        .map((issue, index) => ({
          id: "FUNC-002-" + (index + 1),
          title: "Network request failed",
          description: String(issue.failureText ?? "A network request did not complete."),
          severity: "medium",
          location: issue.url ?? null,
          evidence: issue,
          recommendation: "Check the request URL, server availability, CORS policy, and network dependencies."
        }));
    }
  },
  {
    id: "functional.http-error",
    specialist: "functional",
    evaluate(context) {
      return getElements(context, "httpErrors")
        .filter((issue) => Number(issue.status) >= 400)
        .slice(0, 30)
        .map((issue, index) => ({
          id: "FUNC-003-" + (index + 1),
          title: "HTTP resource returned an error",
          description: "A resource returned HTTP " + Number(issue.status) + ".",
          severity: Number(issue.status) >= 500 ? "high" : "medium",
          location: issue.url ?? null,
          evidence: { status: Number(issue.status), resourceType: issue.resourceType },
          recommendation: "Verify the endpoint, resource path, server response, and deployment configuration."
        }));
    }
  }
];
