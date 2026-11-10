import path from "node:path";
import { defineConfig } from "vitest/config";

// Database tests run the real migrations in an in-process Postgres. The end-to-end journey test also loads code from both apps, so "@/..." is
// resolved against the app that the importing file belongs to.
const website = path.resolve(import.meta.dirname, "../website");
const admin = path.resolve(import.meta.dirname, "../admin");

export default defineConfig({
  plugins: [
    {
      name: "app-alias",
      async resolveId(source, importer) {
        if (!source.startsWith("@/") || !importer) return null;
        const own = path.resolve(importer).startsWith(admin) ? admin : website;
        return (await this.resolve(path.join(own, source.slice(2)), importer, { skipSelf: true }))?.id ?? null;
      },
    },
  ],
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts", "supabase/tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
