import { createServer, request as httpRequest } from "node:http";
import { createSecurityGuard } from "../packages/security-guard/src/index.js";

const events = [];
const guard = createSecurityGuard({
  mode: "balanced",
  rateLimit: { enabled: false },
  onEvent(event) { events.push(event); }
});

const server = createServer((request, response) => {
  guard.middleware(request, response, () => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ ok: true }));
  });
});

function send(path) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port: server.address().port, path, method: "GET" }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

const cases = [
  { name: "ordinary product search", path: "/search?q=floral+perfume", expected: 200 },
  { name: "XSS signature", path: "/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E", expected: 403, rule: "JBG-XSS-001" },
  { name: "SQL injection signature", path: "/search?q=%27%20OR%201%3D1", expected: 403, rule: "JBG-SQLI-001" },
  { name: "encoded path traversal", path: "/files/%2e%2e/private.txt", expected: 403, rule: "JBG-PATH-001" },
  { name: "Unicode compatibility traversal", path: "/files/%EF%BC%8E%EF%BC%8E%EF%BC%8Fprivate.txt", expected: 403, rule: "JBG-PATH-001" }
];

let failures = 0;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  console.log("JB Security Guard isolated localhost demonstration");
  console.log("Listener: 127.0.0.1 (ephemeral port; no public exposure)");
  for (const item of cases) {
    const eventStart = events.length;
    const status = await send(item.path);
    const ruleIds = events.slice(eventStart).flatMap((event) => event.ruleIds ?? []);
    const passed = status === item.expected && (!item.rule || ruleIds.includes(item.rule));
    if (!passed) failures += 1;
    console.log((passed ? "PASS" : "FAIL") + " | " + item.name + " | expected=" + item.expected + " actual=" + status + " | rules=" + (ruleIds.join(",") || "none"));
  }
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
console.log("Result: " + (cases.length - failures) + "/" + cases.length + " cases passed");
if (failures > 0) process.exitCode = 1;
