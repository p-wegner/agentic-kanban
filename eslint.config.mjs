// Flat ESLint config for the agentic-kanban monorepo (ESLint 9 + typescript-eslint 8).
//
// Philosophy: this is the FIRST lint pass over a large, long-unlinted codebase
// (~1400 TS files, ~785 pre-existing `any`s, ~1200 console calls). A maximalist
// config would emit thousands of errors and never be run. So:
//   - ERROR  = real-bug rules + rules the codebase is already clean against.
//             `pnpm lint` must exit 0 on errors so it can gate like lint:arch.
//   - WARN   = the ratchet backlog (any, unused, exhaustive-deps...). Visible,
//             non-blocking. `pnpm lint:strict` (--max-warnings 0) enforces zero.
//   - OFF    = rules that fight this codebase's deliberate style (console is the
//             server/CLI's logging mechanism; non-null assertions are pervasive).
//
// Type-aware linting (typescript-eslint's recommendedTypeChecked: no-floating-promises,
// no-misused-promises, ...) is intentionally NOT enabled yet — it needs projectService
// wiring, is much slower, and would surface a large second backlog. It's the natural
// next step once the warn backlog is drained. The existing `// eslint-disable` comments
// (react-hooks/exhaustive-deps, no-control-regex) are now meaningful again.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.worktrees/**",
      "packages/.worktrees/**", // 25 full package-tree copies
      "**/worktrees/**", // .claude/worktrees full source-tree copies
      ".claude/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/.vite/**",
      "**/drizzle/**",
      "packages/desktop/**", // Tauri / Rust — not JS/TS
      "packages/client/dist/**",
      "**/*.min.js",
    ],
  },

  // Base recommended sets (non-type-checked: fast, no projectService needed).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Global calibration (applies to all linted files) ───────────────────────
  {
    rules: {
      // `console` IS the logging mechanism for this server/CLI app — not a smell.
      "no-console": "off",

      // The ratchet backlog: real signals, but too many pre-existing hits to gate
      // on today. Kept as warnings so they're visible and trend down over time.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "prefer-const": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",

      // Domain-intentional: this app parses terminal/speech/agent text, so control
      // chars + emoji-spanning char classes in regexes are deliberate, not bugs.
      "no-control-regex": "warn", // existing per-site disables still suppress
      "no-misleading-character-class": "warn",

      // Real-bug rules — kept as errors (codebase is clean here after this pass).
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipTemplates: true, skipComments: true, skipRegExps: true },
      ],
    },
  },

  // ── Client: React (browser) ────────────────────────────────────────────────
  {
    files: ["packages/client/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error", // genuine bugs
      "react-hooks/exhaustive-deps": "warn", // intentional omissions carry a disable
    },
  },

  // ── TypeScript everywhere: TS already proves binding existence ──────────────
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-undef": "off", // handled by the TS compiler; on TS it only false-positives
    },
  },

  // ── Plain JS tooling (scripts, configs, mock agents) run on Node ───────────
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ── Tests: relax type-strictness; test plumbing leans on any/casts ──────────
  {
    files: [
      "**/*.test.{ts,tsx}",
      "**/__tests__/**/*.{ts,tsx}",
      "packages/e2e/**/*.ts",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
