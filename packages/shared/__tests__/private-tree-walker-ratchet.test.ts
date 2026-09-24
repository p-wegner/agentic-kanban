// @gate:always-run always — walks the tree to find walkers: every scripts/*.mjs and every package's test tree; imports nothing it checks (#1241).
import { describe, expect, it } from "vitest";
import path from "node:path";
import { readGuardSource } from "./helpers/guard-scan.js";
import { walkRepoTree } from "../../../scripts/lib/repo-tree.mjs";

/**
 * #1241 — private tree walkers, shrink-only.
 *
 * The repo had 80 files under `scripts/` and the package test trees with their own directory
 * listing (a `readdirSync` / `readdir` call), each with a hand-kept skip set and none aware of
 * nested linked worktrees: with five `.claude/worktrees/*` checkouts in place every one of them
 * walked six source trees, and `legacy-temp-prefixes.test.ts` timed out at its 300 s budget.
 * `scripts/lib/repo-tree.mjs` is the one walker that knows the rules (canonical skip set, a
 * `.git` FILE marks a worktree, junctions are never followed); this ratchet pins every file
 * that still lists directories on its own, so the set can only shrink.
 *
 * Same shape as `wire-dto-single-declaration.test.ts`: a grandfathered set that may only
 * shrink, plus a stale-entry check so a migrated file is de-listed rather than left as slack.
 *
 * Not every entry is a REPO-tree walker — the session analyzers list `~/.claude/projects`, the
 * sweeps list `%TEMP%`, `test-mine.mjs` takes an injected lister for its tests. They are listed
 * because the ratchet counts the IDIOM, which is the thing a reviewer can check without opening
 * the file; an entry that lists a foreign tree is a candidate to leave, not a defect. What must
 * not happen is a NEW private walker over the repo tree, and that is what the first test fails.
 *
 * To migrate an entry: replace the listing with `walkRepoTree` / `listRepoSubdirs` and delete
 * the line here. To add one: do not — use the shared walker.
 */

const REPO_ROOT = path.resolve(import.meta.dirname!, "..", "..", "..");

/** The one sanctioned directory lister. */
const SANCTIONED = new Set(["scripts/lib/repo-tree.mjs"]);

/** A call to Node's directory listing, sync or callback/promise form. */
const LISTS_A_DIRECTORY = /\b(?:readdirSync|readdir)\s*\(/;

const SOURCE_EXT = [".ts", ".tsx", ".mjs", ".cjs", ".js"];

/** Where a private walker could live: repo scripts, and every package's test tree (helpers included). */
function scanRoots(): string[] {
  const roots = [path.join(REPO_ROOT, "scripts")];
  for (const pkg of ["shared", "server", "client", "mcp-server"]) {
    const testsDir = pkg === "shared" ? path.join("packages", pkg, "__tests__") : path.join("packages", pkg, "src", "__tests__");
    roots.push(path.join(REPO_ROOT, testsDir));
  }
  return roots;
}

const GRANDFATHERED = new Set<string>([
  // ---- scripts/ (20)
  "scripts/analyze-claude-session.mjs",
  "scripts/analyze-codex-session.mjs",
  "scripts/analyze-copilot-session.mjs",
  "scripts/analyze-failure-recovery.mjs",
  "scripts/drizzle-preflight.mjs",
  "scripts/ensure-shared-fresh.mjs",
  "scripts/guard-inventory.mjs",
  "scripts/output-style.mjs",
  "scripts/pack-worker.mjs",
  "scripts/pnpm-store-health.mjs",
  "scripts/prune-worktree-husks.mjs",
  "scripts/safe-rmdir.mjs",
  "scripts/session-rank.mjs",
  "scripts/shared-preflight.mjs",
  "scripts/sweep-loose-test-db-files.mjs",
  "scripts/sweep-temp-dirs.mjs",
  "scripts/test-mine.mjs",
  "scripts/token-sinks.mjs",
  "scripts/tool-failures.mjs",
  "scripts/user-prompts.mjs",
  // ---- packages/client (5)
  "packages/client/src/__tests__/client-module-placement.test.ts",
  "packages/client/src/__tests__/client-upward-type-edge-ratchet.test.ts",
  "packages/client/src/__tests__/fetch-in-effect-ratchet.test.ts",
  "packages/client/src/__tests__/icon-primitive-ratchet.test.ts",
  "packages/client/src/__tests__/issue-form-duplication-ratchet.test.ts",
  // ---- packages/mcp-server (2)
  "packages/mcp-server/src/__tests__/mcp-error-spelling.test.ts",
  "packages/mcp-server/src/__tests__/tool-board-reach.test.ts",
  // ---- packages/server (30)
  "packages/server/src/__tests__/always-run-marker-ratchet.test.ts",
  "packages/server/src/__tests__/backup.test.ts",
  "packages/server/src/__tests__/claude-md-git-invariants.test.ts",
  "packages/server/src/__tests__/cli-path-resolution-guard.test.ts",
  "packages/server/src/__tests__/command-safety-backup-prune.test.ts",
  "packages/server/src/__tests__/command-safety-guard.test.ts",
  "packages/server/src/__tests__/container-profile.test.ts",
  "packages/server/src/__tests__/container-reap-terminal-paths.test.ts",
  "packages/server/src/__tests__/executor-id-mapping-guard.test.ts",
  "packages/server/src/__tests__/file-db-close-before-unlink.test.ts",
  "packages/server/src/__tests__/fk-violations.test.ts",
  "packages/server/src/__tests__/git.service.test.ts",
  "packages/server/src/__tests__/helpers/cli-harness.ts",
  "packages/server/src/__tests__/helpers/reap-fixture-child-servers.ts",
  "packages/server/src/__tests__/helpers/rm-or-report-holder.ts",
  "packages/server/src/__tests__/issue-comments-single-write-path.test.ts",
  "packages/server/src/__tests__/migration-schema-drift.test.ts",
  "packages/server/src/__tests__/no-self-http-in-services.test.ts",
  "packages/server/src/__tests__/repo-path-literal-ratchet.test.ts",
  "packages/server/src/__tests__/repository-projections-ratchet.test.ts",
  "packages/server/src/__tests__/repository-table-ownership.test.ts",
  "packages/server/src/__tests__/result-spelling-ratchet.test.ts",
  "packages/server/src/__tests__/stack-marker-ladder-ratchet.test.ts",
  "packages/server/src/__tests__/stack-profile-read-is-pure.test.ts",
  "packages/server/src/__tests__/start-policy-single-source.test.ts",
  "packages/server/src/__tests__/sweep-timer-mechanism.test.ts",
  "packages/server/src/__tests__/test-mine-exclusions-ratchet.test.ts",
  "packages/server/src/__tests__/typecheck-package-coverage.test.ts",
  "packages/server/src/__tests__/utf8-repair.test.ts",
  "packages/server/src/__tests__/vital-file-guard-backup.test.ts",
  // ---- packages/shared (6)
  "packages/shared/__tests__/drizzle-snapshot-baseline.test.ts",
  "packages/shared/__tests__/exec-adapter-shape.test.ts",
  "packages/shared/__tests__/hook-teardown-await.test.ts",
  "packages/shared/__tests__/issue-number-single-source.test.ts",
  "packages/shared/__tests__/module-path-derivation.test.ts",
  "packages/shared/__tests__/shared-lib-single-consumer-ratchet.test.ts",
]);

const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join("/");

let walkersCache: string[] | null = null;

/** Walked once per worker, INSIDE the first test so the walk is priced by `durations.json`, not hidden in collection. */
function privateWalkers(): string[] {
  if (walkersCache) return walkersCache;
  const found: string[] = [];
  for (const root of scanRoots()) {
    for (const abs of walkRepoTree(root, { extensions: SOURCE_EXT })) {
      const key = rel(abs);
      if (SANCTIONED.has(key)) continue;
      if (LISTS_A_DIRECTORY.test(readGuardSource(abs))) found.push(key);
    }
  }
  walkersCache = found.sort();
  return walkersCache;
}

describe("private tree-walker ratchet (#1241)", () => {
  it("the scan is not vacuous — it reaches the scripts and every package's test tree", () => {
    const found = privateWalkers();
    expect(found.length, "scan found no directory listing at all — the ratchet is disarmed").toBeGreaterThan(10);
    expect(found.some((f) => f.startsWith("scripts/"))).toBe(true);
    for (const pkg of ["shared", "server", "client", "mcp-server"]) {
      expect(found.some((f) => f.startsWith(`packages/${pkg}/`)), `no listing found under packages/${pkg}`).toBe(true);
    }
  });

  it("no file outside the grandfathered set lists a directory on its own — use walkRepoTree / listRepoSubdirs", () => {
    const found = privateWalkers();
    const offenders = found.filter((f) => !GRANDFATHERED.has(f));
    expect(
      offenders,
      `These files call readdirSync / readdir themselves. A private walker does not know the ` +
        `linked-worktree and junction rules and walks N trees under \`.claude/worktrees/*\`. Use ` +
        `\`walkRepoTree\` / \`listRepoSubdirs\` from scripts/lib/repo-tree.mjs instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the grandfathered set is not stale — a migrated or deleted file must be de-listed", () => {
    const current = new Set(privateWalkers());
    const stale = [...GRANDFATHERED].filter((f) => !current.has(f));
    expect(
      stale,
      `These grandfathered entries no longer list a directory (migrated, or the file is gone). ` +
        `Delete them from GRANDFATHERED so the set keeps shrinking:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the grandfathered count is the committed number and only ever shrinks", () => {
    // 80 at the start of #1241; 17 migrated in that ticket (3 scripts, 14 suites).
    expect(GRANDFATHERED.size).toBe(63);
  });
});
