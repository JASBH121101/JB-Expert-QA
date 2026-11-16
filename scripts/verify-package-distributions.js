  run(node, [
    "--input-type=module", "-e",
    'import { createCloudflareWorkerRateLimit } from "@jb/security-guard/cloudflare-worker-rate-limit"; if (typeof createCloudflareWorkerRateLimit !== "function") process.exit(1); const limiter = createCloudflareWorkerRateLimit({ binding: { async limit() { return { success: true }; } } }); const decision = await limiter.check({ identity: "package-smoke-test", scope: "distribution" }); if (!decision.allowed || decision.unavailable) process.exit(1);'
  ], { cwd: guardInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { createCloudflarePagesRateLimit } from "@jb/security-guard/cloudflare-pages-rate-limit"; if (typeof createCloudflarePagesRateLimit !== "function") process.exit(1); const pages = createCloudflarePagesRateLimit({ serviceBinding: { async fetch() { return new Response(JSON.stringify({ allowed: true, exceeded: false, enforced: false, unavailable: false, policy: null, scope: "distribution", status: null, retryAfterSeconds: null }), { status: 200 }); } } }); const decision = await pages.check({ identity: "package-smoke-test", scope: "distribution" }); if (!decision.allowed || decision.unavailable) process.exit(1);'
  ], { cwd: guardInstall });