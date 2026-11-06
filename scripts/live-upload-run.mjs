// Runs the approval-gated live upload test and then puts the project back exactly as it was.
//
// Why: the test starts its own build in a separate directory (.next-upload-test) so the normal build and its security policy stay
// untouched. `next build` rewrites tsconfig.json (adds that directory to "include") and next-env.d.ts (points them at it) as a side
// effect. This wrapper saves both files first, runs Playwright with the same environment, and in a `finally` block restores both
// files and deletes the extra build directory, even when the run fails or is interrupted. It prints nothing but the child's output.
//
//   RIO_LIVE_CONFIRM=<dev ref> RIO_LIVE_R2_CONFIRM=<dev bucket> npm run test:e2e:live:upload

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const FILES = ["tsconfig.json", "next-env.d.ts"];
const saved = new Map(FILES.map((f) => [f, existsSync(join(root, f)) ? readFileSync(join(root, f)) : null]));

function restore() {
  for (const [f, content] of saved) {
    if (content === null) rmSync(join(root, f), { force: true });
    else writeFileSync(join(root, f), content);
  }
  rmSync(join(root, ".next-upload-test"), { recursive: true, force: true });
}

const cli = join(root, "node_modules", "@playwright", "test", "cli.js");
const child = spawn(process.execPath, [cli, "test", "--config", "e2e-live/playwright.upload.config.ts", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });

const stop = (signal) => child.kill(signal);
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

child.on("exit", (code, signal) => {
  restore();
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", () => {
  restore();
  process.exit(1);
});
