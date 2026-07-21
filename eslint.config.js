import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import security from "eslint-plugin-security";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";

export default defineConfig(
  globalIgnores(["**/dist/**", "**/node_modules/**", "coverage/**"]),

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  prettierConfig,

  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  {
    plugins: { prettier: prettierPlugin },
    rules: {
      "prettier/prettier": "error",
      // Underscore prefix = deliberately unused (mock signatures, discarded
      // destructures) — the TS convention the default rule doesn't know.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  // Tests and the demo read their own fixtures/outputs by constructed
  // paths — the non-literal-fs rule exists for request-driven server code,
  // not a harness addressing its own files.
  {
    files: ["test/**", "demo/**"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
);
