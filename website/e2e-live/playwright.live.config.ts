import { loadEnvConfig } from "@next/env";
import { defineConfig } from "@playwright/test";

// Approval-gated live sign-in test. Kept apart from `npm run test:e2e` on purpose.
loadEnvConfig(process.cwd());
loadEnvConfig(process.cwd(), false); // .env.local for the Next.js server; .env.live is loaded by the npm script

const PORT = 3100;

export default defineConfig({
  testDir: ".",
  testMatch: "*.live.spec.ts",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, channel: "chrome" },
  webServer: {
    command: `npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
