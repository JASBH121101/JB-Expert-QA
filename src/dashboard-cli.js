#!/usr/bin/env node
import { startDashboard, DEFAULT_DASHBOARD_PORT } from "./dashboard/server.js";

function parseArguments(args) {
  let port = DEFAULT_DASHBOARD_PORT;
  let help = false;
  for (const argument of args) {
    if (argument === "--help" || argument === "-h") {
      if (help) throw new TypeError("--help may only be supplied once");
      help = true;
    } else if (argument.startsWith("--port=")) {
      const value = argument.slice("--port=".length);
      if (!/^\d+$/.test(value)) throw new TypeError("--port must be an integer between 1 and 65535");
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError("--port must be an integer between 1 and 65535");
      }
    } else {
      throw new TypeError("Unknown option: " + argument);
    }
  }
  return { port, help };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        "JB Expert QA Control Center\n\n" +
        "Usage: jb-qa-dashboard [--port=4173]\n\n" +
        "The dashboard binds only to 127.0.0.1. Stop it with Ctrl+C.\n"
      );
      return;
    }
    const dashboard = await startDashboard({ port: options.port });
    process.stdout.write(
      "JB Expert QA Control Center is running at " + dashboard.url + "\n" +
      "Local-only server. Keep this terminal open; press Ctrl+C to stop it.\n" +
      "History is stored under .jb-expert-qa/dashboard/ in the current directory.\n"
    );
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try { await dashboard.close(); }
      catch { process.exitCode = 1; }
    };
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "Dashboard startup failed") + "\n");
    process.exitCode = 1;
  }
}
await main();
