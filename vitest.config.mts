import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": import.meta.dirname } },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "scripts/**/*.test.ts", "supabase/tests/**/*.test.ts", "proxy.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
