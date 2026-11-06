import { loadEnvConfig } from "@next/env";
import { defineConfig } from "@playwright/test";

// Load .env.local the way Next does, so the tests can tell whether Supabase is configured.
loadEnvConfig(process.cwd());

const PORT = 3100;

// Uses the Chrome already installed on the machine/CI runner; no browser download.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: { baseURL: `http://localhost:${PORT}`, channel: "chrome" },
  webServer: {
    command: `npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
