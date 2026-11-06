// Runs the unit and database test suites on Postgres 17 (the version pinned in supabase/config.toml).
import { spawnSync } from "node:child_process";

const res = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run"], {
  stdio: "inherit",
  env: { ...process.env, RIO_PG_ENGINE: "17" },
});
process.exit(res.status ?? 1);
