import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "../config.ts";
import { assertEngineMatches, migrationFolder } from "./engine.ts";
import { DatabaseError } from "./errors.ts";
import { assertMigrateAllowed, assertResetAllowed, GuardError, requireDatabase, testEnvironment } from "./guards.ts";
import { checkParity, getStatus, loadMigrations, migrate, MigrationError, problemsOf } from "./migrate.ts";
import { checkReadiness } from "./readiness.ts";
import { openDatabase } from "./open.ts";
import { dropAllTables } from "./reset.ts";

// npm run db:migrate | db:status | db:verify | db:reset:test
// Output is limited to migration names, states and fixed sentences. Nothing that came from the driver or the environment is printed.

// src/db and dist/db both sit two levels below backend/, so the same relative path finds backend/migrations in development and in production.
const ROOT = fileURLToPath(new URL("../../migrations", import.meta.url));
const out = (line: string) => process.stdout.write(`${line}\n`);

async function main(command: string | undefined): Promise<number> {
  if (command === "reset-test") {
    const config = loadConfig(testEnvironment(process.env));
    const db = openDatabase(assertResetAllowed(config));
    try {
      out(`Dropped ${await dropAllTables(db)} table(s) from the ${config.database?.dialect} test database.`);
    } finally {
      await db.close();
    }
    return 0;
  }
  if (command !== "migrate" && command !== "status" && command !== "verify" && command !== "ready") {
    out("Usage: db:migrate | db:status | db:verify | db:ready | db:reset:test");
    return 2;
  }

  const parity = await checkParity(ROOT);
  if (command === "verify" && parity.length > 0) {
    parity.forEach((p) => out(`PROBLEM ${p}`));
    return 1;
  }
  if (command === "verify") out(`Dialect folders match.`);

  const config = loadConfig(process.env);
  if (command === "verify" && !config.database) {
    out("No database configured: only the dialect folders were checked."); // CI and fresh checkouts
    return 0;
  }
  const database = requireDatabase(config);
  const migrations = await loadMigrations(`${ROOT}/${migrationFolder(database)}`);
  if (command === "migrate") assertMigrateAllowed(config, process.env);
  const db = openDatabase(database);
  try {
    await assertEngineMatches(db, database); // MySQL 8 and MariaDB have separate migration folders: never run one on the other
    if (command === "migrate") {
      const { applied } = await migrate(db, migrations);
      out(applied.length === 0 ? "Nothing to apply." : `Applied: ${applied.join(", ")}`);
      return 0;
    }
    if (command === "ready") {
      // A real round trip to the database plus a read-only look at the migration records. Writes nothing.
      const result = await checkReadiness(db, migrations);
      out(result.ready ? "ready: the database answered a query and every migration is applied" : `not ready: ${result.reason}`);
      return result.ready ? 0 : 1;
    }
    const statuses = await getStatus(db, migrations, undefined, { readOnly: true }); // status never writes, not even the tracking table
    statuses.forEach((s) => out(`${s.version}_${s.name}  ${s.state}`));
    if (statuses.length === 0) out("No migrations.");
    const problems = problemsOf(statuses);
    problems.forEach((p) => out(`PROBLEM ${p}`));
    return problems.length > 0 ? 1 : 0;
  } finally {
    await db.close();
  }
}

try {
  process.exitCode = await main(process.argv[2]);
} catch (error) {
  // Only types that carry fixed, value-free messages are printed.
  const safe = error instanceof ConfigError || error instanceof GuardError || error instanceof MigrationError || error instanceof DatabaseError;
  process.stderr.write(`${safe ? error.message : "The command failed."}\n`);
  process.exitCode = 1;
}
