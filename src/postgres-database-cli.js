#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { auditPostgresDatabase } from "./adapters/database/postgres.js";

function parseArgs(args) {
  const options = new Map();
  let confirmed = false;
  for (const arg of args) {
    if (arg === "--confirm-read-only") {
      if (confirmed) throw new TypeError("--confirm-read-only may only be supplied once.");
      confirmed = true;
      continue;
    }
    const match = arg.match(/^--(env|output)=(.+)$/);
    if (!match || !match[2].trim()) throw new TypeError("Unsupported database audit option: " + arg);
    if (options.has(match[1])) throw new TypeError("--" + match[1] + " may only be supplied once.");
    options.set(match[1], match[2].trim());
  }
  if (!confirmed) throw new Error("Live database access requires the explicit --confirm-read-only flag.");
  const envName = options.get("env");
  if (!envName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error("Provide --env=ENVIRONMENT_VARIABLE_NAME; never pass a connection URL as a CLI argument.");
  }
  return { envName, output: options.get("output") ?? null };
}

try {
  const { envName, output } = parseArgs(process.argv.slice(2));
  const connectionString = process.env[envName];
  if (!connectionString) throw new Error("The environment variable " + envName + " is not set.");

  const report = await auditPostgresDatabase({ connectionString });
  const rendered = JSON.stringify(report, null, 2) + "\n";
  if (output) {
    const destination = resolve(output);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, rendered, { encoding: "utf8", mode: 0o600 });
    console.log("Database audit report saved to " + destination);
  } else {
    process.stdout.write(rendered);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted PostgreSQL connection string]"));
  process.exitCode = 1;
}
