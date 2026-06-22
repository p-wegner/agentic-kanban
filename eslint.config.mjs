// Flat ESLint config for the agentic-kanban monorepo (ESLint 9 + typescript-eslint 8).
//
// TYPE-AWARE: typescript-eslint runs with full type information (projectService),
// enabling the high-value bug rules — no-floating-promises, no-misused-promises,
// await-thenable, no-unnecessary-condition, ... — as hard errors.
//
// Calibration philosophy for a large, long-unlinted codebase (~1400 TS files,
// ~785 pre-existing `any`s):
//   - ERROR  = real-bug rules + rules the codebase is already clean against.
//             `pnpm lint` must exit 0 on errors so it gates like lint:arch.
//   - WARN   = the ratchet backlog (any, unused, the any-driven no-unsafe-* family,
//             exhaustive-deps...). Visible, non-blocking. `pnpm lint:strict`
//             (--max-warnings 0) enforces zero once drained.
//   - OFF    = rules that fight this codebase's deliberate style (console is the
//             server/CLI's logging mechanism).
//
// The no-unsafe-* family is kept at WARN, not error: with 785 `any`s every member
// access / call on an `any` trips them, so they're noise until the `any` backlog is
// drained — at which point they ratchet up to error for free.

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
      ".opencode/**", // agent hook plugins — not in any tsconfig
      ".pi/**",
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

  // Base recommended + type-checked recommended (needs projectService, below).
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // Type-aware parser wiring for all TS sources.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      "no-undef": "off", // handled by the TS compiler; on TS it only false-positives
    },
  },

  // ── Global calibration ─────────────────────────────────────────────────────
  {
    rules: {
      // `console` IS the logging mechanism for this server/CLI app — not a smell.
      "no-console": "off",

      // The ratchet backlog: real signals, but too many pre-existing hits to gate
      // on today. Kept as warnings so they're visible and trend down over time.
      // no-explicit-any is DRAINED to 0 — promoted to error so it gates `pnpm lint`
      // and no new explicit `any` can be reintroduced into type-checked source.
      "@typescript-eslint/no-explicit-any": "error",
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

      // ── Type-aware backlog (any-driven; warn until the `any` count drops) ─────
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/unbound-method": "warn",
      // Autofix mis-narrows `X | {}` unions (settings store, parseOptionalJsonBody)
      // — the empty-object `{}` top-type confuses it. Keep visible, don't gate/fix.
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      // async fn with no await: often intentional (interface conformance) and
      // removing `async` changes the return type — backlog, not a gate.
      "@typescript-eslint/require-await": "warn",

      // no-misused-promises: keep the real-bug parts (a promise used in a condition,
      // an async fn passed where a sync void is required AT RUNTIME), but allow async
      // JSX event handlers (onClick={async …}) — idiomatic and safe in React.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],

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

  // ── Tests + config files: NON type-aware ───────────────────────────────────
  // These are deliberately excluded from the build tsconfigs (see client/CLAUDE.md),
  // so projectService can't resolve them — type-aware rules would parse-error. Lint
  // them with the non-type-checked ruleset (still catches unused vars, etc.) and
  // relax test-only strictness.
  {
    files: [
      "**/*.test.{ts,tsx}",
      "**/__tests__/**/*.{ts,tsx}",
      "packages/e2e/**/*.ts",
      "**/*.config.{ts,mts,cts}",
      "**/vitest.setup.{ts,tsx}",
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ── Plain JS tooling (scripts, configs, mock agents): NOT in a TS project. ──
  // Must come LAST so it overrides the global calibration above — otherwise the
  // type-checked rules get re-enabled on .js/.mjs/.cjs files that have no type
  // information and ESLint errors "rule requires type information".
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ...(tseslint.configs.disableTypeChecked.languageOptions ?? {}),
      globals: { ...globals.node },
    },
  },
);
