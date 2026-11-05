function finding(id, title, description, severity, recommendation, metadata = {}) {
  return {
    id,
    title,
    description,
    severity,
    location: metadata.location ?? "HTTP response",
    recommendation,
    evidence: metadata.evidence ?? null,
    metadata: { detector: id, requiresManualReview: true, ...metadata }
  };
}

function header(context, name) {
  const values = context.securityHttpResponse?.headers?.[name.toLowerCase()];
  return Array.isArray(values) ? values.join(", ") : typeof values === "string" ? values : "";
}

function isHttps(context) {
  return context.securityHttpResponse?.finalUrl?.startsWith("https://") === true;
}

function cookieName(cookie) {
  return String(cookie?.name ?? "").toLowerCase();
}

const AUTH_COOKIE = /(?:session|auth|token|access|refresh|jwt|sid|identity)/i;

export const securityRuntimeRules = Object.freeze([
  {
    id: "security-runtime.transport",
    specialist: "security-runtime",
    evaluate(context) {
      const initialUrl = context.securityHttpResponse?.initialUrl;
      if (!isHttps(context)) {
        return [finding(
          "SEC-RUNTIME-HTTPS-001",
          "Final page response is not protected by HTTPS",
          "The inspected page finished loading over plain HTTP. Network traffic can be read or modified in transit.",
          "critical",
          "Serve the site over HTTPS with a valid certificate and redirect HTTP requests to the HTTPS canonical URL.",
          { initialUrl: initialUrl ?? null, finalUrl: context.securityHttpResponse?.finalUrl ?? null }
        )];
      }
      if (initialUrl && !initialUrl.startsWith("https://")) {
        return [finding(
          "SEC-RUNTIME-HTTPS-002",
          "Initial navigation began over HTTP before reaching HTTPS",
          "The browser had to make the initial navigation over an unencrypted connection before arriving at the HTTPS page. That first redirect can be intercepted on an untrusted network.",
          "high",
          "Publish HTTPS links as the canonical entry point and enable HSTS after confirming HTTPS support across the host.",
          { initialUrl, finalUrl: context.securityHttpResponse?.finalUrl ?? null }
        )];
      }
      return [];
    }
  },
  {
    id: "security-runtime.hsts",
    specialist: "security-runtime",
    evaluate(context) {
      if (!isHttps(context)) return [];
      const value = header(context, "strict-transport-security");
      if (!value) return [finding(
        "SEC-RUNTIME-HSTS-001",
        "Strict-Transport-Security header is missing",
        "The HTTPS response does not advertise an HSTS policy, so browsers are not instructed to require HTTPS for future visits.",
        "medium",
        "Add Strict-Transport-Security with a deliberate max-age. Include subdomains only after confirming every subdomain supports HTTPS."
      )];
      const match = value.match(/(?:^|;)\s*max-age\s*=\s*(\d+)/i);
      if (!match || Number(match[1]) < 31536000) return [finding(
        "SEC-RUNTIME-HSTS-002",
        "HSTS max-age is missing or shorter than one year",
        "The HSTS response header is present, but its max-age is absent or below the one-year baseline used by this profile.",
        "low",
        "Review the HSTS max-age and increase it deliberately after validating HTTPS coverage across the domain.",
        { observedMaxAgeSeconds: match ? Number(match[1]) : null }
      )];
      return [];
    }
  },
  {
    id: "security-runtime.csp",
    specialist: "security-runtime",
    evaluate(context) {
      const value = header(context, "content-security-policy");
      if (!value) return [finding(
        "SEC-RUNTIME-CSP-001",
        "Enforced Content-Security-Policy header is missing",
        "The document response does not include an enforced Content-Security-Policy header. A report-only policy does not enforce browser restrictions.",
        "high",
        "Deploy a restrictive Content-Security-Policy using the site's required origins and nonces or hashes. Start with report-only while testing if the current application has not yet been inventoried."
      )];
      const findings = [];
      const directives = value.split(";").map((item) => item.trim()).filter(Boolean);
      const scriptDirective = directives.find((item) => /^script-src\s+/i.test(item)) ??
        directives.find((item) => /^default-src\s+/i.test(item));
      if (!scriptDirective) {
        findings.push(finding(
          "SEC-RUNTIME-CSP-006",
          "Content-Security-Policy does not restrict script sources",
          "The enforced policy contains no script-src or default-src directive, so this policy does not establish a source allowlist for scripts.",
          "high",
          "Define a restrictive script-src or default-src directive and use nonces or hashes for required inline scripts."
        ));
      } else if (scriptDirective.split(/\s+/).slice(1).includes("*")) {
        findings.push(finding(
          "SEC-RUNTIME-CSP-007",
          "Content-Security-Policy permits scripts from any origin",
          "The effective script source directive includes the wildcard source, allowing scripts from arbitrary origins.",
          "high",
          "Replace the wildcard with a strict allowlist of required script origins, and prefer nonces or hashes for inline scripts."
        ));
      }
      if (/(?:^|;)\s*script-src(?:\s+[^;]*)?\s+[^;]*'unsafe-eval'/i.test(value) ||
          /(?:^|;)\s*default-src(?:\s+[^;]*)?\s+[^;]*'unsafe-eval'/i.test(value)) {
        findings.push(finding(
          "SEC-RUNTIME-CSP-002",
          "Content-Security-Policy permits unsafe-eval",
          "The enforced policy appears to allow eval-like script execution, which weakens protection against script injection.",
          "high",
          "Remove 'unsafe-eval' where possible and replace dynamic evaluation with explicit, trusted code paths."
        ));
      }
      if (/(?:^|;)\s*(?:script-src|default-src)(?:\s+[^;]*)?\s+[^;]*'unsafe-inline'/i.test(value)) {
        findings.push(finding(
          "SEC-RUNTIME-CSP-003",
          "Content-Security-Policy permits unsafe-inline scripts",
          "The script policy appears to allow inline scripts without a nonce or hash requirement.",
          "medium",
          "Prefer per-response nonces or stable script hashes; avoid broad unsafe-inline allowances."
        ));
      }
      if (!/(?:^|;)\s*object-src\s+/i.test(value)) {
        findings.push(finding(
          "SEC-RUNTIME-CSP-004",
          "Content-Security-Policy does not define object-src",
          "The enforced policy does not explicitly restrict plugin content such as object and embed elements.",
          "low",
          "Add object-src 'none' unless the site has a documented requirement for embedded plugin content."
        ));
      }
      if (!/(?:^|;)\s*base-uri\s+/i.test(value)) {
        findings.push(finding(
          "SEC-RUNTIME-CSP-005",
          "Content-Security-Policy does not define base-uri",
          "The policy does not explicitly constrain document base URL changes.",
          "low",
          "Add base-uri 'self' or base-uri 'none' according to the application's routing requirements."
        ));
      }
      return findings;
    }
  },
  {
    id: "security-runtime.content-type",
    specialist: "security-runtime",
    evaluate(context) {
      const value = header(context, "x-content-type-options");
      if (value.trim().toLowerCase() === "nosniff") return [];
      return [finding(
        "SEC-RUNTIME-XCTO-001",
        "X-Content-Type-Options nosniff is missing",
        "The response does not explicitly prevent browsers from MIME-sniffing content types.",
        "medium",
        "Set X-Content-Type-Options: nosniff on application responses."
      )];
    }
  },
  {
    id: "security-runtime.framing",
    specialist: "security-runtime",
    evaluate(context) {
      const csp = header(context, "content-security-policy");
      const frameOptions = header(context, "x-frame-options");
      if (/(?:^|;)\s*frame-ancestors\s+/i.test(csp) ||
          /^(?:deny|sameorigin)$/i.test(frameOptions.trim())) return [];
      return [finding(
        "SEC-RUNTIME-FRAME-001",
        "No effective anti-framing policy was observed",
        "Neither a Content-Security-Policy frame-ancestors directive nor a recognized X-Frame-Options value was found.",
        "medium",
        "Set a restrictive frame-ancestors directive in the enforced CSP. Use X-Frame-Options as a compatibility fallback where appropriate."
      )];
    }
  },
  {
    id: "security-runtime.referrer-policy",
    specialist: "security-runtime",
    evaluate(context) {
      const value = header(context, "referrer-policy").trim().toLowerCase();
      if (value) return [];
      return [finding(
        "SEC-RUNTIME-REFERRER-001",
        "Referrer-Policy header is missing",
        "The response does not declare how much referrer information browsers may send to other sites.",
        "low",
        "Set a deliberate policy such as strict-origin-when-cross-origin or no-referrer according to product requirements."
      )];
    }
  },
  {
    id: "security-runtime.permissions-policy",
    specialist: "security-runtime",
    evaluate(context) {
      if (header(context, "permissions-policy").trim()) return [];
      return [finding(
        "SEC-RUNTIME-PERMISSIONS-001",
        "Permissions-Policy header is missing",
        "The response does not declare restrictions for browser capabilities such as camera, microphone, or geolocation.",
        "low",
        "Set a Permissions-Policy that disables unused browser capabilities and allows required features only for trusted origins."
      )];
    }
  },
  {
    id: "security-runtime.cors",
    specialist: "security-runtime",
    evaluate(context) {
      const origin = header(context, "access-control-allow-origin").trim();
      const credentials = header(context, "access-control-allow-credentials").trim().toLowerCase();
      if (origin !== "*" || credentials !== "true") return [];
      return [finding(
        "SEC-RUNTIME-CORS-001",
        "Wildcard CORS origin is combined with credential support",
        "The inspected response advertises Access-Control-Allow-Origin: * and Access-Control-Allow-Credentials: true. Browsers reject this combination for credentialed CORS, but it signals an unsafe or inconsistent policy.",
        "medium",
        "Return an explicit, validated origin allowlist and set credential support only for origins that require it.",
        { observedOrigin: origin, credentialSupport: true }
      )];
    }
  },
  {
    id: "security-runtime.cookies",
    specialist: "security-runtime",
    evaluate(context) {
      if (!isHttps(context)) return [];
      const findings = [];
      for (const cookie of context.securityHttpResponse?.cookies ?? []) {
        if (!AUTH_COOKIE.test(cookieName(cookie))) continue;
        const missing = [];
        if (cookie.secure !== true) missing.push("Secure");
        if (cookie.httpOnly !== true) missing.push("HttpOnly");
        if (!cookie.sameSite) missing.push("SameSite");
        if (!missing.length) continue;
        findings.push(finding(
          "SEC-RUNTIME-COOKIE-" + String(cookie.name).replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
          "Authentication-related cookie is missing security attributes",
          "A response cookie whose name suggests session or authentication state is missing one or more protective attributes. Cookie values are never included in the report.",
          missing.includes("Secure") || missing.includes("HttpOnly") ? "high" : "medium",
          "For authentication cookies, set Secure, HttpOnly, and an explicit SameSite policy appropriate to the sign-in flow.",
          { cookieName: cookie.name, missingAttributes: missing, cookieValueReported: false }
        ));
      }
      return findings;
    }
  },
  {
    id: "security-runtime.mixed-content",
    specialist: "security-runtime",
    evaluate(context) {
      const resources = context.securityHttpResponse?.mixedContent ?? [];
      return [...new Map(resources.map((item) => [item.url, item])).values()].slice(0, 10).map((item, index) =>
        finding(
          "SEC-RUNTIME-MIXED-" + (index + 1),
          "HTTPS page requested an insecure HTTP resource",
          "The HTTPS document attempted to load a resource over plain HTTP. This mixed content can undermine page integrity or expose data.",
          "high",
          "Serve the resource over HTTPS or remove the insecure dependency.",
          { resourceUrl: item.url, resourceType: item.resourceType }
        ));
    }
  }
]);
