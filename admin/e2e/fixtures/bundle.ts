import path from "node:path";
import { rolldown } from "rolldown";

// Bundles a real component (with a fake stand-in for its server actions) into one script for the offline browser tests.
// "@/..." resolves to the repository root; `aliases` swaps a specific import for a fixture file. Nothing here is part of the app.

const root = process.cwd();

export async function bundleFixture(entry: string, aliases: Record<string, string>): Promise<string> {
  const build = await rolldown({
    input: path.join(root, entry),
    platform: "browser",
    onLog: (level, log, defaultHandler) => {
      if (log.code !== "MODULE_LEVEL_DIRECTIVE") defaultHandler(level, log); // "use client" has no meaning in this bundle
    },
    transform: { define: { "process.env.NODE_ENV": '"production"' } },
    plugins: [
      {
        name: "fixture-aliases",
        async resolveId(source, importer) {
          const swapped = aliases[source];
          if (swapped) return path.join(root, swapped);
          if (source.startsWith("@/")) return (await this.resolve(path.join(root, source.slice(2)), importer))?.id ?? null;
          return null;
        },
      },
    ],
  });
  return (await build.generate({ format: "iife" })).output[0].code;
}
