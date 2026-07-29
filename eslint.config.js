// @ts-check
import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import nextPlugin from "@next/eslint-plugin-next";

export default defineConfig(
  {
    // verify-package-entry.mjs deliberately imports the package's own name
    // to prove the built output resolves; that self-reference only works
    // once `dist` exists, so the file is kept outside every tsconfig's
    // "include" (see its header comment) and, consequently, outside
    // type-aware linting too.
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/verify-package-entry.mjs",
      "**/.next/**",
      "**/.next-durable-restart-e2e/**",
      "**/next-env.d.ts",
    ],
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
  {
    // Scoped to apps/web only: React/JSX/Next rules have no business
    // applying to the Node-only library/service packages elsewhere in this
    // workspace. Deliberately does not import `eslint-config-next`'s own
    // flat config array wholesale — it ships its own `languageOptions.parser`
    // assignment, which would fight the `projectService`-based type-aware
    // parserOptions every other package in this repo already relies on.
    // Pulling each plugin's `rules` in directly keeps this block's
    // `languageOptions` under this repo's own control.
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
      // eslint-plugin-jsx-a11y ships incomplete/erroring type declarations.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      "jsx-a11y": jsxA11y,
      "@next/next": nextPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "19" },
      next: { rootDir: "apps/web" },
    },
    // Several of these plugins' `configs.*.rules` resolve to `any`/broken
    // types (eslint-plugin-jsx-a11y in particular has no usable types at
    // all) — spreading each plugin's own recommended rules is still the
    // correct, standard way to compose flat config, so this is disabled
    // rather than worked around with a wrapper that adds no real safety.
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      // React 19 / the automatic JSX runtime make both of these obsolete.
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
    },
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
  },
  // eslint-config-prettier ships no type declarations; its export is an untyped rule-disabling config object.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  eslintConfigPrettier,
);
