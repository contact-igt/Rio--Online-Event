import { runStaffCli } from "./cli-core.ts";

// Entry point for `npm run staff:create-admin` and `npm run staff:reset-password`. The logic lives in cli-core.ts so it can be tested.
process.exitCode = await runStaffCli(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
