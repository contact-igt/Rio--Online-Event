import { loadEnvConfig } from "@next/env";
import { defineConfig } from "@playwright/test";
import { assertUploadTarget } from "../scripts/live-upload";

// Approval-gated LIVE video-upload test (dev Supabase project and dev R2 bucket only). Kept apart from `npm run test:e2e` and
// from the registration live suite on purpose: run it only with `npm run test:e2e:live:upload`, after a separate approval,
// with RIO_LIVE_CONFIRM=<dev project ref> and RIO_LIVE_R2_CONFIRM=<dev bucket name> set for that one command.
loadEnvConfig(process.cwd());
loadEnvConfig(process.cwd(), false); // .env.local for the app; .env.live is loaded by the npm script

// Refuse before anything is built or started: wrong bucket, production-looking name, uploads already on, missing settings.
assertUploadTarget(process.env);

const PORT = 3100; // the bucket's CORS rule names http://localhost:3100, so the page must be served from exactly that origin

const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));

export default defineConfig({
  testDir: ".",
  testMatch: "*.liveupload.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  reporter: "line",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    // nothing that could capture a signed URL, an email address or a code is recorded
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    // A separate build directory, because the Content-Security-Policy (which names the bucket host only when uploads are on)
    // is fixed at build time. The normal .next build and its policy are left alone.
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false, // never talk to a server somebody else started
    timeout: 600_000,
    // The ONLY place uploads are switched on: this server process. The test process and .env.local stay off.
    env: { ...env, RIO_UPLOADS_ENABLED: "yes", RIO_DIST_DIR: ".next-upload-test" },
  },
});
