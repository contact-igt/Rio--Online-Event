import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// The database folder has no web app, so it uses the plain TypeScript rules (no Next.js rules).
export default defineConfig([...tseslint.configs.recommended, globalIgnores(["node_modules/**", "supabase/**/*.sql"])]);
