# JB Security Guard — ERP integration playbook

## Scope

This is the future integration order for the ERP host application. It is a reference only: Guard has not been mounted into the ERP, no production credentials have been configured, and no ERP, database, edge, or storage resource is changed by this document.

## Required middleware order

1. Construct the Node.js HTTP/HTTPS server and set the parser-level max header size.
2. Apply Node server timeouts and connection limits before listen().
3. Mount response security headers.
4. Mount Guard request inspection and declared-body checks before parsers.
5. Mount bounded JSON and URL-encoded parsers.
6. Mount the host application's trusted session middleware.
7. Mount origin validation and session-bound CSRF protection on browser routes that use cookies.
8. Mount route-specific authentication throttles and application authorization.
9. Mount account-recovery endpoints with verified contacts, real delivery adapters, a stable secret, and a shared atomic store if the application is multi-instance.
10. Add upload endpoints only after the quarantine and malware-scanning pipeline is live.

## Reference Express/Node setup

~~~js
import { createServer } from "node:http";
import express from "express";
import {
  configureNodeHttpServer,
  createSecurityGuard
} from "@jb/security-guard";

const app = express();
const oneMiB = 1024 * 1024;

const guard = createSecurityGuard({
  // Start in monitor mode in staging; enable blocking after reviewing actual traffic.
  mode: process.env.JB_GUARD_MODE ?? "monitor",
  maxBodyBytes: oneMiB,
  rateLimit: {
    enabled: true,
    max: 120,
    windowMs: 60_000,
    maxKeys: 5_000
  },
  securityHeaders: {
    // Add an enforced CSP only after inventorying required ERP origins and scripts.
    // contentSecurityPolicy: "default-src 'self'; object-src 'none'; base-uri 'self'"
  }
});

const server = createServer({ maxHeaderSize: 16 * 1024 }, app);
configureNodeHttpServer(server, { maxBodyBytes: oneMiB });

app.use(guard.securityHeaders);
app.use(guard.middleware);

// Actual parser limits must match or be lower than Guard's declared-body limit.
app.use(express.json({ limit: "1mb", strict: true, inflate: false }));
app.use(express.urlencoded({
  extended: false,
  limit: "64kb",
  parameterLimit: 100
}));

// Mount the ERP's vetted session middleware here.
// It must use secure cookies, session rotation, and a production-grade session store.

// Example browser-route protections after session middleware:
const originProtection = guard.createOriginProtection({
  allowedOrigins: [process.env.PUBLIC_APP_ORIGIN]
});
const csrfProtection = guard.createCsrfProtection({
  secret: process.env.JB_CSRF_SECRET,
  sessionKeyGenerator: (req) => req.sessionID
});
app.use("/app", originProtection.middleware);
app.use("/app", csrfProtection.middleware);

// Define route handlers and authorization only after the controls above.
server.listen(process.env.PORT ?? 3000);
~~~

This is not a complete ERP server. The session middleware, route authorization, database transactions, error handling, delivery adapters, and secrets must be supplied by the host application. Do not put placeholder values or real credentials in source control.

## Authentication and authorization

- Mount the authentication throttle after the parser only when its identity resolver needs the parsed login identifier.
- Call recordFailure only after a real credential-verification failure; call recordSuccess only after successful authentication.
- Keep login responses generic and do not reveal account existence.
- Require MFA or step-up authentication for sensitive administrative actions.
- Enforce role and permission checks on every protected server route. Hiding a tab in the UI is not authorization.
- Rotate sessions after login, password changes, privilege changes, and recovery. Revoke existing sessions after a successful password reset.
- Use a shared, atomic store for global throttles if more than one application instance is deployed. The current in-memory auth and request limiters are process-local.

## Browser CSRF controls

- Use exact, HTTPS-only trusted origins for production browser routes.
- Keep origin validation separate from CORS. CORS must have its own explicit allowlist; never combine wildcard origins with credentialed requests.
- Provide the synchronizer token only through an authenticated same-origin response with Cache-Control: no-store.
- The browser sends the token in the configured request header on every unsafe method.
- Keep GET/HEAD/OPTIONS handlers free of state changes.
- Do not enable allowMissingOrigin on cookie-authenticated routes unless an alternative CSRF control is independently enforced.
- Do not use the browser CSRF middleware for native apps, server-to-server webhooks, or bearer-token APIs. Give those clients separate routes and authentication policies.

## Files and malware

Do not enable customer or supplier file uploads until the host application has private quarantine storage, strict parser limits, and a real malware-scanning service. Pending, unsupported, or scanner-unavailable files remain quarantined and cannot be served. Follow docs/FILE-UPLOAD-SECURITY.md.

## Infrastructure that remains external

Guard does not replace:
- An edge WAF, bot controls, DDoS protection, TLS configuration, and network egress restrictions.
- A shared atomic rate-limit/session store for clustered deployments.
- A secret manager, key rotation, MFA provider, secure email/SMS delivery, and monitored audit storage.
- Database least-privilege roles, tenant isolation, encrypted backups, restore drills, and incident response.
- An endpoint antivirus/EDR product on developer workstations and production hosts.

## Release gate before ERP integration

Do not integrate Guard until all of these are checked:
- The ERP framework, HTTP server, reverse-proxy trust boundary, and session implementation are identified.
- Limits are tuned with representative staging traffic to avoid false blocks.
- Session-bound CSRF and origin protections are exercised on every browser mutation route.
- All roles and tenant boundaries have negative authorization tests.
- Upload quarantine and a real scanner are connected before upload endpoints are enabled.
- A shared atomic backend exists before multiple instances are deployed.
- High-severity dependency audit, static QA, functional regression, and restore/incident exercises pass.
- The final review explicitly records remaining risks and infrastructure responsibilities.
