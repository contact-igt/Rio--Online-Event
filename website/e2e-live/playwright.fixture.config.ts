import { defineConfig } from "@playwright/test";

// Offline fixture check (npm run test:fixture): the installed Chrome only. No web server, no Supabase, no R2, no environment files.
export default defineConfig({
  testDir: ".",
  testMatch: "*.livefixture.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  reporter: "line",
  use: { channel: "chrome", trace: "off", screenshot: "off", video: "off" },
});
