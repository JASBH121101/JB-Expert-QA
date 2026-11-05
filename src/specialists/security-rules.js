const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte",
  ".html", ".htm", ".php", ".py", ".rb", ".java", ".kt", ".go", ".rs",
  ".cs", ".json", ".yml", ".yaml"
]);

function isCodeFile(file) {
  return CODE_EXTENSIONS.has(file.extension) ||
    CODE_EXTENSIONS.has(file.path.match(/\.[^.]+$/)?.[0]?.toLowerCase());
}

function isCommentLine(line) {
  return /^\s*(?:\/\/|\/\*|\*|#|--)/.test(line);
}

function makeFinding(id, title, description, severity, file, line, recommendation, metadata = {}) {
  return {
    id,
    title,
    description,
    severity,
    location: line ? file.path + ":" + line : file.path,
    recommendation,
    evidence: { path: file.path, line: line || null },
    metadata: { detector: id, requiresManualReview: true, ...metadata }
  };
}

function sourceLines(file) {
  return file.content.split(/\r\n|\n|\r/);
}

function sourceWithoutCommentLines(file) {
  return sourceLines(file).filter((line) => !isCommentLine(line)).join("\n");
}

function slug(value) {
  return String(value).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

export const securityDefenseRules = Object.freeze([
  {
    id: "security.plain-http-endpoints",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      for (const file of context.projectFiles ?? []) {
        if (!isCodeFile(file)) continue;
        const lines = sourceLines(file);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (isCommentLine(line)) continue;
          const matches = [...line.matchAll(/\bhttp:\/\/([a-z0-9.-]+)(?::\d+)?/gi)];
          for (const match of matches) {
            const host = match[1].toLowerCase();
            if (
              host === "localhost" || host === "127.0.0.1" ||
              host === "0.0.0.0" || host.endsWith(".localhost") ||
              host.endsWith(".local") || host.endsWith(".test") ||
              host.endsWith(".invalid") || host.endsWith(".example")
            ) continue;
            findings.push(makeFinding(
              "SEC-HTTP-" + slug(file.path) + "-" + (index + 1),
              "Plain HTTP endpoint in application code",
              "An absolute HTTP endpoint appears in executable source or configuration. Traffic to this endpoint is not protected by TLS.",
              "high", file, index + 1,
              "Use HTTPS for external services and verify that redirects cannot downgrade the connection.",
              { hostname: host, transport: "http" }
            ));
            break;
          }
        }
      }
      return findings;
    }
  },
  {
    id: "security.cors-wildcard-credentials",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      const wildcardOrigin = /(?:access-control-allow-origin[\s\S]{0,180}["']\*["']|origin\s*:\s*["']\*["'])/i;
      const credentials = /(?:access-control-allow-credentials[\s\S]{0,180}true|credentials\s*:\s*true)/i;
      for (const file of context.projectFiles ?? []) {
        if (!isCodeFile(file)) continue;
        const source = sourceWithoutCommentLines(file);
        if (!wildcardOrigin.test(source) || !credentials.test(source)) continue;
        findings.push(makeFinding(
          "SEC-CORS-" + slug(file.path),
          "Wildcard CORS origin combined with credentials",
          "The same file appears to allow every origin while also enabling credentialed requests. This combination is unsafe and should be reviewed at the actual response boundary.",
          "high", file, null,
          "Use an explicit origin allowlist, validate the Origin header server-side, and enable credentials only for trusted origins.",
          { origin: "wildcard", credentials: true }
        ));
      }
      return findings;
    }
  },
  {
    id: "security.authentication-cookie-attributes",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      const cookieWrite = /(?:set-cookie\s*[:=]|setHeader\s*\(\s*["']set-cookie["']|document\.cookie\s*=|(?:res|response|reply)\.cookie\s*\(\s*["'](?:session|auth|refresh|access|jwt|token)|cookies?\.set\s*\(\s*["'](?:session|auth|refresh|access|jwt|token))/i;
      const authCookie = /\b(?:session|auth|refresh|access|jwt|token)\b/i;
      for (const file of context.projectFiles ?? []) {
        if (!isCodeFile(file)) continue;
        const lines = sourceLines(file);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (isCommentLine(line) || !cookieWrite.test(line) || !authCookie.test(line)) continue;
          const missing = [];
          if (!/\bhttponly\b/i.test(line)) missing.push("HttpOnly");
          if (!/\bsecure\b/i.test(line)) missing.push("Secure");
          if (!/\bsamesite\s*=/i.test(line) && !/\bsamesite\s*:/i.test(line)) missing.push("SameSite");
          if (!missing.length) continue;
          const severe = missing.includes("HttpOnly") || missing.includes("Secure");
          findings.push(makeFinding(
            "SEC-COOKIE-" + slug(file.path) + "-" + (index + 1),
            "Authentication cookie missing security attributes",
            "An authentication-related cookie write does not visibly set all recommended protections. The analyzer checks the same source line and cannot resolve multi-line option objects.",
            severe ? "high" : "medium", file, index + 1,
            "Set HttpOnly and Secure on server-issued session cookies, choose an explicit SameSite policy, and review the complete cookie options.",
            { missingAttributes: missing }
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "security.weak-password-hashing",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      const weakHash = /(?:createHash|createHmac)\s*\(\s*["'](?:md5|sha1)["']\s*\)|\b(?:md5|sha1)\s*\(/i;
      for (const file of context.projectFiles ?? []) {
        if (!isCodeFile(file) || !/\b(?:password|passwd|passphrase|credential)\b/i.test(file.content)) continue;
        const lines = sourceLines(file);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (isCommentLine(line) || !weakHash.test(line)) continue;
          findings.push(makeFinding(
            "SEC-PASSWORD-HASH-" + slug(file.path) + "-" + (index + 1),
            "Weak hash used in a password-related file",
            "MD5 or SHA-1 appears in a file containing password or credential handling. These general-purpose hashes are unsuitable for password storage.",
            "high", file, index + 1,
            "Use a password-specific hash such as Argon2id, scrypt, or bcrypt with an appropriate work factor; never store plaintext passwords.",
            { algorithm: /md5/i.test(line) ? "MD5" : "SHA-1" }
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "security.cryptographic-randomness",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      const sensitivePurpose = /\b(?:token|secret|session|csrf|reset|otp|nonce|api.?key|password.?reset)\b/i;
      for (const file of context.projectFiles ?? []) {
        if (!isCodeFile(file)) continue;
        const lines = sourceLines(file);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (isCommentLine(line) || !/Math\s*\.\s*random\s*\(/i.test(line)) continue;
          const nearby = lines.slice(index, Math.min(lines.length, index + 3)).join(" ");
          if (!sensitivePurpose.test(nearby)) continue;
          findings.push(makeFinding(
            "SEC-RANDOM-" + slug(file.path) + "-" + (index + 1),
            "Non-cryptographic randomness used for a security value",
            "Math.random() appears near a token, secret, nonce, session, or similar security-sensitive value.",
            "high", file, index + 1,
            "Use a cryptographically secure generator such as crypto.randomBytes() or crypto.getRandomValues().",
            { generator: "Math.random" }
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "security.unverified-jwt-claims",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      const decodeCall = /\b(?:jwt|jsonwebtoken)\s*\.\s*decode\s*\(|\bdecodeJwt\s*\(/i;
      const authorizationUse = /\b(?:authorize|authorization|isAdmin|admin|role|permission|accessControl|hasAccess)\b/i;
      const verificationCall = /\b(?:jwt|jsonwebtoken)\s*\.\s*verify\s*\(|\bverifyJwt\s*\(|\bverifyToken\s*\(/i;
      for (const file of context.projectFiles ?? []) {
        if (!isCodeFile(file)) continue;
        const source = sourceWithoutCommentLines(file);
        if (!decodeCall.test(source) || !authorizationUse.test(source) || verificationCall.test(source)) continue;
        const index = source.search(decodeCall);
        const line = source.slice(0, index).split(/\r\n|\n|\r/).length;
        findings.push(makeFinding(
          "SEC-JWT-" + slug(file.path) + "-" + line,
          "JWT decoding appears near authorization logic without local verification",
          "The file decodes JWT claims and also contains authorization-related logic, but no recognized verification call was found in that file. Decoding alone does not validate a token signature or claims.",
          "high", file, line,
          "Verify signatures, issuer, audience, expiry, and an explicit algorithm allowlist before using claims for authorization. Confirm verification is not delegated to a trusted middleware in another module.",
          { detector: "jwt-decode-without-visible-verify" }
        ));
      }
      return findings;
    }
  },
  {
    id: "security.user-controlled-redirect",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      const redirectPattern = /\b(?:res|response|reply)\s*\.\s*(?:redirect|location)\s*\(\s*(?:req|request)\s*\.\s*(?:query|body|params)\b|\bredirect\s*\(\s*(?:req|request)\s*\.\s*(?:query|body|params)\b|\b(?:window\.)?location(?:\.href)?\s*=\s*(?:req|request)\s*\.\s*(?:query|body|params)\b/i;
      for (const file of context.projectFiles ?? []) {
        if (!isCodeFile(file)) continue;
        const lines = sourceLines(file);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (isCommentLine(line) || !redirectPattern.test(line)) continue;
          findings.push(makeFinding(
            "SEC-REDIRECT-" + slug(file.path) + "-" + (index + 1),
            "Redirect destination may be controlled by a request parameter",
            "A redirect operation appears to use request query, body, or route parameters directly, which can enable open redirects.",
            "medium", file, index + 1,
            "Resolve redirect targets against a strict allowlist of trusted relative paths or approved hostnames.",
            { detector: "request-controlled-redirect" }
          ));
        }
      }
      return findings;
    }
  },
  {
    id: "security.user-controlled-outbound-request",
    specialist: "security",
    evaluate(context) {
      const findings = [];
      const outboundRequest = /\b(?:fetch|got|request)\s*\(|\baxios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/i;
      const requestInput = /\b(?:req|request)\s*\.\s*(?:body|query|params)\b/i;
      for (const file of context.projectFiles ?? []) {
        if (!isCodeFile(file)) continue;
        const lines = sourceLines(file);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (isCommentLine(line) || !outboundRequest.test(line) || !requestInput.test(line)) continue;
          findings.push(makeFinding(
            "SEC-SSRF-" + slug(file.path) + "-" + (index + 1),
            "Outbound request may use an untrusted request parameter",
            "An outbound HTTP client call appears on the same line as request-controlled data. Review the destination to prevent server-side request forgery.",
            "high", file, index + 1,
            "Do not fetch arbitrary client-supplied URLs. Enforce destination allowlists, resolve and validate IP addresses, block private and link-local ranges, and revalidate redirects.",
            { detector: "request-input-to-outbound-client" }
          ));
        }
      }
      return findings;
    }
  }
]);
