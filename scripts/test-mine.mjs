#!/usr/bin/env node
// test:mine — the fast, opinionated unit-test loop for day-to-day iteration.
//
// Runs ONLY the suites that are reliably green in this environment (main checkout
// AND inside a git worktree). The known-flaky / pre-existing-broken suites listed
// in CLAUDE.md's "Known Flaky Test Suites" table are skipped so agents and humans
// stop chasing false failures. The full `pnpm test` stays for CI / pre-release.
//
// Why a wrapper instead of a single vitest invocation: the flaky suites live in
// two different packages (server + mcp-server), each with its own vitest config.
// This runs vitest once per package with the right `--exclude` globs and
// aggregates the exit codes.
//
// Why we invoke vitest's own entry directly (node <pkg>/node_modules/vitest/vitest.mjs)
// with cwd set to the package, instead of `pnpm --filter <pkg> test -- <args>`:
// forwarding flags through `pnpm run test -- ...` is unreliable on Windows. The
// nested `pnpm.cmd` shell shim mangles the `--` forward-separator, so the
// `--exclude` globs never reach vitest and the flaky suites run anyway. Calling
// vitest directly from the package dir lets its own `vitest.config.ts` resolve
// and the flags arrive verbatim. (Verified: this excludes the suites; the pnpm
// path did not.)
//
// Excluded suites (keep in sync with CLAUDE.md "Known Flaky Test Suites" and the
// "Use pnpm test:mine to skip these" note):
//   server:
//     - cli.test.ts        spawn-based CLI integration; stale migration list / worktree DB resolution
//     - cli-butler.test.ts spawn-based CLI integration; same root causes
//     - git.service.test.ts real git on temp dirs; Windows file-locking / timing
//   mcp-server:
//     - mcp-tools.test.ts  spawn-based MCP integration; stale migration list / worktree DB resolution
//
// Pass-through: any extra args are forwarded to vitest run in BOTH packages, so you can
// still narrow the run by test file path, e.g.:
//   pnpm test:mine -- src/__tests__/tags.test.ts
//
// NOTE: `vitest related <source-file>` (coverage-aware, finds tests that import a source
// file) is a SEPARATE subcommand — not a `--related` flag. Run it directly:
//   cd packages/server && node node_modules/vitest/vitest.mjs related src/services/foo.service.ts

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** @type {{ dir: string, label: string, exclude: string[] }[]} */
const PACKAGES = [
  {
    dir: "packages/server",
    label: "server",
    exclude: ["**/cli.test.ts", "**/cli-butler.test.ts", "**/git.service.test.ts"],
  },
  {
    dir: "packages/mcp-server",
    label: "mcp-server",
    exclude: ["**/mcp-tools.test.ts"],
  },
];

// Extra args after `--` (pnpm strips the first `--`; node leaves the rest in argv).
const passthrough = process.argv.slice(2);

/**
 * Resolve vitest's runnable entry for a package. pnpm hoists most deps to the
 * workspace root, but each package may also have a local copy. Prefer the local
 * one, fall back to the root.
 */
function resolveVitestEntry(pkgDir) {
  const candidates = [
    resolve(pkgDir, "node_modules/vitest/vitest.mjs"),
    resolve(ROOT, "node_modules/vitest/vitest.mjs"),
  ];
  return candidates.find((p) => existsSync(p));
}

function runPackage({ dir, label, exclude }) {
  return new Promise((resolvePromise) => {
    const pkgDir = resolve(ROOT, dir);
    const vitestEntry = resolveVitestEntry(pkgDir);
    if (!vitestEntry) {
      console.error(
        `[test:mine] ${label}: could not find vitest. Run \`pnpm install\` first.`
      );
      resolvePromise(1);
      return;
    }
    const excludeArgs = exclude.flatMap((glob) => ["--exclude", glob]);
    const args = [vitestEntry, "run", ...excludeArgs, ...passthrough];
    console.log(
      `\n[test:mine] ${label}: node vitest run ${[...excludeArgs, ...passthrough].join(" ")}`
    );
    // No shell — pass argv as an array so globs reach vitest verbatim (vitest does
    // its own glob matching; the OS shell must NOT expand them). cwd = package dir
    // so vitest picks up that package's vitest.config.ts.
    const child = spawn(process.execPath, args, {
      cwd: pkgDir,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("exit", (code) => resolvePromise(code ?? 1));
    child.on("error", (err) => {
      console.error(`[test:mine] ${label} failed to start:`, err);
      resolvePromise(1);
    });
  });
}

let failed = false;
for (const pkg of PACKAGES) {
  const code = await runPackage(pkg);
  if (code !== 0) failed = true;
}

if (failed) {
  console.error("\n[test:mine] One or more packages had failing tests.");
  process.exit(1);
}
console.log("\n[test:mine] All reliable suites passed.");
