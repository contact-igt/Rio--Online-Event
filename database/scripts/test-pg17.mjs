// Runs the unit and database test suites on Postgres 17 (the version pinned in supabase/config.toml).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const res = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("vitest/vitest.mjs"), "run"], {
  stdio: "inherit",
  env: { ...process.env, RIO_PG_ENGINE: "17" },
});
process.exit(res.status ?? 1);
