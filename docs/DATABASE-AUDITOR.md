# JB Expert QA — Database Auditor

## Purpose

A focused database specialist within JB Expert QA, not a separate engine. It complements the existing project audit with a dedicated command and structured database-only report.

## Run

Monorepo:

    npm run audit:database -- ./path/to/project --format=json

Standalone package:

    npx jb-qa-db ./ --format=html

JavaScript:

    import { auditDatabaseProject } from "@jb/expert-qa";
    const report = await auditDatabaseProject("./");

## Scope

Reuses the existing destructive SQL, Prisma raw-query, PostgreSQL SECURITY DEFINER, broad PUBLIC grant, privileged role, Prisma relation-index, SQL foreign-key index and concurrent-index transaction rules. Adds checks for ORM schema synchronization, disabled database TLS verification, dynamic raw-query construction, selected SQL performance hints and missing visible migration rollback methods.

## Safety

Static and local-only. It does not connect to a live database, read rows, execute SQL, inspect live schema, run EXPLAIN, modify data or schema, install dependencies, or send network requests. Existing scanner exclusions for environment and credential files remain in force.

## Limitations

All findings are heuristics. Query plans and performance depend on real schema, data distribution, indexes, server configuration, database version and workload. A migration without a visible rollback may be intentional. A pass is not a security certification or proof of runtime performance.
