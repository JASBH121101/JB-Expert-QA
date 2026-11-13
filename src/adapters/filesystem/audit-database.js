import { basename, resolve } from "node:path";
import { ExpertQAEngine } from "../../core/engine.js";
import { validateEngineConfig } from "../../core/config.js";
import { RuleRegistry } from "../../core/rule-registry.js";
import { ENGINE_VERSION } from "../../core/version.js";
import projectConfig from "../../../config/project-audit.config.json" with { type: "json" };
import { scanProject } from "./scan-project.js";
import { databaseSpecialistRules } from "../../specialists/database/index.js";

const DB_SIGNAL = /\b(?:DATABASE_URL|database|dataSource|prisma|sequelize|typeorm|knex|postgres(?:ql)?|mysql|mariadb|sqlite|pg\.Pool|queryRunner|sqlalchemy|PDO|mysqli|DB::)\b/i;
const DB_SCHEMA_EXTENSIONS = new Set([".sql", ".prisma"]);

function getDatabaseEvidence(files) {
  return files.filter((file) =>
    DB_SCHEMA_EXTENSIONS.has(file.extension) ||
    /(?:^|\/)(?:migrations?|database|db)(?:\/|$)/i.test(file.path) ||
    DB_SIGNAL.test(file.content)
  );
}

export async function auditDatabaseProject(rootPath, { config = projectConfig, scanOptions = {} } = {}) {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    throw new TypeError("A project directory path is required");
  }

  const root = resolve(rootPath);
  const validatedConfig = validateEngineConfig(config);
  const scan = await scanProject(root, { ...validatedConfig.scan, ...scanOptions });
  const evidenceFiles = getDatabaseEvidence(scan.files);
  const schemaFiles = scan.files.filter((file) => DB_SCHEMA_EXTENSIONS.has(file.extension));
  const incompleteReasons = [];

  if (scan.summary.truncated) incompleteReasons.push("file-count or directory-depth limit reached");
  if (scan.summary.oversizedFiles > 0) incompleteReasons.push(scan.summary.oversizedFiles + " oversized file(s) skipped");
  if (scan.summary.unreadableFiles > 0) incompleteReasons.push(scan.summary.unreadableFiles + " unreadable file(s) skipped");
  if (scan.summary.skippedSymlinks > 0) incompleteReasons.push(scan.summary.skippedSymlinks + " symbolic link(s) not followed");
  if (!evidenceFiles.length) incompleteReasons.push("no database schema, migration, ORM, or connection evidence detected");

  const registry = new RuleRegistry();
  for (const rule of databaseSpecialistRules) registry.register(rule);

  const report = await new ExpertQAEngine({ registry, config: validatedConfig }).audit({
    projectFiles: scan.files,
    packageManifests: scan.manifests,
    projectScan: scan,
    thresholds: validatedConfig.thresholds
  });

  const scanComplete = scan.summary.truncated === false &&
    scan.summary.oversizedFiles === 0 &&
    scan.summary.unreadableFiles === 0 &&
    scan.summary.skippedSymlinks === 0;
  const evidenceComplete = scanComplete && evidenceFiles.length > 0;
  const scoring = evidenceComplete ? report.scoring : Object.freeze({
    ...report.scoring,
    passed: false,
    blockedByCoverage: true
  });

  return Object.freeze({
    ...report,
    scoring,
    engine: "JB Expert QA — Database Auditor",
    version: ENGINE_VERSION,
    target: Object.freeze({ project: basename(root) }),
    databaseScope: Object.freeze({
      mode: "local-static",
      complete: evidenceComplete,
      assessmentStatus: evidenceFiles.length === 0 ? "insufficient-database-evidence" : scanComplete ? "scanned" : "partial",
      filesAnalyzed: scan.summary.filesRead,
      databaseEvidenceFiles: evidenceFiles.length,
      schemaFiles: schemaFiles.length,
      scannedDatabasePaths: Object.freeze(evidenceFiles.map((file) => file.path)),
      supportedSchemaExtensions: Object.freeze([".sql", ".prisma"]),
      supportedSourceExtensions: Object.freeze([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".php", ".py", ".rb", ".java", ".kt", ".go", ".rs", ".cs"]),
      incompleteReasons: Object.freeze(incompleteReasons),
      coverage: Object.freeze({
        truncated: scan.summary.truncated,
        oversizedFiles: scan.summary.oversizedFiles,
        unreadableFiles: scan.summary.unreadableFiles,
        skippedSymlinks: scan.summary.skippedSymlinks
      }),
      databaseConnections: 0,
      networkRequests: 0,
      databaseWrites: 0,
      limitations: Object.freeze([
        "This is a local static audit. It does not connect to a live database or read database rows.",
        "Query plans, table cardinality, actual indexes, locks, runtime latency and server settings cannot be verified without a separately authorized read-only connection.",
        "SQL, ORM and migration findings are heuristic and must be reviewed against the selected database engine and workload.",
        "No schema changes, data writes, dependency installs or network requests are performed.",
        ...incompleteReasons
      ])
    })
  });
}
