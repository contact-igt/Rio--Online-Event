import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../config.ts";
import { assertEngineMatches, migrationFolder } from "./engine.ts";
import { DatabaseError } from "./errors.ts";
import { GuardError, requireDatabase } from "./guards.ts";
import { loadMigrations } from "./migrate.ts";
import { openDatabase } from "./open.ts";
import { checkReadiness } from "./readiness.ts";
import { applySeed, planSeed, SeedConflict } from "./seed-events.ts";

// npm run db:seed:events [-- --dry-run]
// Local development only: refuses NODE_ENV=production (production competitions are entered by an administrator). It first proves which database
// it is talking to and that every migration is applied, shows what it would do, and only then writes. Output is fixed sentences, competition
// slugs and counts; no connection setting is ever printed.

const ROOT = fileURLToPath(new URL("../../migrations", import.meta.url));
const out = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } }, strict: true });
  const config = loadConfig(process.env);
  if (config.env === "production") throw new GuardError("Seeding is for local development. Production competitions are entered by an administrator.");
  const database = requireDatabase(config);
  const db = openDatabase(database);
  try {
    await assertEngineMatches(db, database);
    if (database.dialect === "mysql") {
      const identity = (await db.query<{ d: string; v: string }>("SELECT DATABASE() AS d, VERSION() AS v")).rows[0]!;
      out(`database: ${identity.d} on ${identity.v}`);
      if (identity.d !== database.database) throw new GuardError("The connected database is not the one named in DATABASE_URL.");
    } else {
      out("database: local SQLite file");
    }
    const ready = await checkReadiness(db, await loadMigrations(`${ROOT}/${migrationFolder(database)}`));
    if (!ready.ready) {
      out(`not ready: ${ready.reason}. Run npm run db:migrate first. Nothing was written.`);
      return 1;
    }
    out("migrations: every migration is applied");

    const plan = await planSeed(db);
    out(`competitions already correct: ${plan.unchanged.length} | to create: ${plan.toCreate.length} | conflicting: ${plan.conflicts.length} | added by an organizer (left alone): ${plan.others.length}`);
    for (const c of plan.toCreate) out(`  create ${c.slug} (ages ${c.minAge}-${c.maxAge})`);
    for (const c of plan.conflicts) out(`  CONFLICT ${c.slug}: ${c.fields.join(", ")} differ`);
    if (plan.conflicts.length > 0) {
      out("Stopped: nothing was written. Resolve the differences by hand first.");
      return 1;
    }
    if (values["dry-run"]) {
      out("dry run: nothing was written.");
      return 0;
    }
    const result = await applySeed(db, new Date());
    out(result.created.length === 0 ? "Nothing to do: all six competitions are already present." : `Created ${result.created.length} competition(s).`);
    return 0;
  } finally {
    await db.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const safe = error instanceof ConfigError || error instanceof GuardError || error instanceof SeedConflict || error instanceof DatabaseError;
  process.stderr.write(`${safe ? error.message : "The command failed."}\n`);
  process.exitCode = 1;
}
