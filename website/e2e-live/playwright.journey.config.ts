import { loadEnvConfig } from "@next/env";
import { defineConfig } from "@playwright/test";
import { assertJourneyTarget } from "../scripts/live-journey";

// Approval-gated LIVE journey test (dev Supabase project and dev R2 bucket only). Kept apart from every other suite on purpose: run it
// only with `npm run test:e2e:live:journey`, after a separate approval, with ALL THREE confirmations typed for that one command:
//   RIO_LIVE_CONFIRM=<dev ref> RIO_LIVE_JOURNEY_CONFIRM=<dev ref> RIO_LIVE_R2_CONFIRM=<dev bucket>
loadEnvConfig(process.cwd());
loadEnvConfig(process.cwd(), false); // .env.local for the app; .env.live is loaded by the npm script

// Refuse before anything is built or started: wrong project, wrong or production-looking bucket, a missing confirmation,
// a feature switch already on in this process, or a push confirmation lying around.
assertJourneyTarget(process.env);

const PORT = 3100; // the bucket's CORS rule names http://localhost:3100, so the page must be served from exactly that origin

const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));

export default defineConfig({
  testDir: ".",
  testMatch: "*.livejourney.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0, // never an automatic retry: a second run would write again
  timeout: 900_000,
  reporter: "line",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    // nothing that could capture a signed link, an e-mail address or a code is recorded
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    // A separate build directory, because the Content-Security-Policy (which names the bucket host only when uploads or playback are
    // on) is fixed at build time. The normal .next build and its policy are left alone.
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false, // never talk to a server somebody else started
    timeout: 600_000,
    // The ONLY place the three switches are turned on: this server process. The test process and .env.local stay off.
    env: { ...env, RIO_UPLOADS_ENABLED: "yes", RIO_FINALIZE_ENABLED: "yes", RIO_PLAYBACK_ENABLED: "yes", RIO_DIST_DIR: ".next-journey-test" },
  },
});
