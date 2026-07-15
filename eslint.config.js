// @ts-check
import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default defineConfig(
  {
    // verify-package-entry.mjs deliberately imports the package's own name
    // to prove the built output resolves; that self-reference only works
    // once `dist` exists, so the file is kept outside every tsconfig's
    // "include" (see its header comment) and, consequently, outside
    // type-aware linting too.
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/verify-package-entry.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // eslint-config-prettier ships no type declarations; its export is an untyped rule-disabling config object.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  eslintConfigPrettier,
);
