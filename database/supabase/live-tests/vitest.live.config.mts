import { defineConfig } from "vitest/config";

// Live tests talk to a real Supabase stack. Kept apart from `npm test` on purpose.
export default defineConfig({
  test: {
    environment: "node",
    include: ["supabase/live-tests/**/*.live.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
