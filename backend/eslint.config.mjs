import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([...tseslint.configs.recommended, globalIgnores(["node_modules/**", "dist/**"])]);
