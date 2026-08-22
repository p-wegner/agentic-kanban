// @gate:always-run — scans every package's src tree for unguarded worktree deletions; imports nothing it checks (#713).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  walkPackageSources,
  packagesRootFrom,
  compareRatchet,
  parseGuardSource,
  calleeName,
  lineOf,
} from "./helpers/guard-scan.js";

/**
 * Shrink-only ratchet on DESTRUCTIVE worktree operations that do not go through the one
 * guarded removal (#713).
 *
 * Three fixes in the 2026-08-20/21 wave each landed the same check at ONE call site of N,
 * and each commit disclosed a smaller remainder than existed: #699's `isPathClaimed` (1 of
 * 8), #673's co-residency sharer check (1 of 5), `a2efe48691`'s closed-sharer correction (1
 * of 2). The consolidation is `shared/lib/worktree-claim.ts`; this gate is what stops the
 * N-1 shape from growing back, in the same style as `git-exec-single-spawn.test.ts` does for
 * raw git spawns.
 *
 * WHAT COUNTS as an offender: a call to a worktree-destroying operation (see
 * `DESTRUCTIVE_CALLS`, plus a recursive `rm`/`rmSync`) that is NOT lexically inside a
 * `removeWorktreeUnlessShared({...})` argument. Lexical containment is the whole test —
 * routing a removal through the guard means writing it as that call's `removeWorktree`
 * callback, so "inside the guard" is a syntactic fact rather than an inferred one.
 *
 * WHY A RATCHET AND NOT A BAN: several of the baselined sites destroy a directory the SAME
 * function just created (the merge-train gate worktree, `createWorkspace`'s rollback) or a
 * sibling-repo worktree keyed off a `repos` row rather than a workspace `workingDir`. Those
 * are not the co-residency bug and a ban would force a meaningless wrapper around them. The
 * ones that ARE the bug — the workspace `workingDir` deletes — are converted; the rest are
 * frozen here so a NEW one cannot appear unnoticed, and each baselined file carries a note
 * saying which it is.
 *
 * The baseline is per FILE, and `compareRatchet` reports both directions: a count above the
 * baseline fails as a regression, a count below it fails as staleness, so converting a site
 * forces the number down instead of leaving slack the next regression can hide in.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = packagesRootFrom(TEST_DIR, 2);
const REPO_ROOT = join(PACKAGES_ROOT, "..");

/** The guard every workspace-`workingDir` deletion must be lexically inside. */
const GUARD_CALL = "removeWorktreeUnlessShared";

/**
 * Operations that destroy a worktree directory. `removeWorktree` is git's own
 * `worktree remove --force` (which deletes the directory); the other two are the
 * fs-level fallbacks inside the shared worktree module.
 */
const DESTRUCTIVE_CALLS = new Set([
  "removeWorktree",
  "removeDirWithRetry",
  "removeLeftoverWorktreeDirectory",
]);

/** `rm`/`rmSync` count only with `recursive: true` — a single-file unlink is not this bug. */
const RECURSIVE_RM = new Set(["rm", "rmSync"]);

/**
 * ...and only when the path being deleted is a WORKTREE path.
 *
 * A bare "recursive rm" scan is not this gate's subject: the tree legitimately recursive-rms
 * temp dirs, clone targets, a base-health probe root and a gradle env sandbox, and folding
 * those in would make the baseline a list of unrelated numbers nobody maintains. Matching on
 * the deleted expression's own text keeps the gate pointed at worktree directories. It is a
 * heuristic — a worktree path held in a variable called `dest` is invisible to it — and that
 * is accepted: the named `DESTRUCTIVE_CALLS` above carry the load, and this only widens the
 * net to the obvious spellings rather than claiming completeness.
 */
const WORKTREE_PATH_EXPR = /work(ing)?[_]?dir|worktree/i;

/**
 * Frozen counts of unguarded destructive calls, per file relative to the repo root.
 *
 * Every entry states which kind it is, because "why is this one allowed" is the question a
 * ratchet has to answer or it decays into a budget:
 *  - OWN RESOURCE — the call destroys a directory this same function created moments ago, so
 *    no other workspace can have claimed it.
 *  - SIBLING REPO — keyed off a `repos` row's `worktreePath`, not a workspace `workingDir`;
 *    co-residency is a property of the latter.
 *  - INSIDE THE GUARDED HELPER — the fs-level fallbacks that a guarded caller reaches
 *    THROUGH `removeWorktreeAndBranch`; guarding them again would double-query.
 *  - TO CONVERT — a genuine workspace-`workingDir` delete that still needs routing. These
 *    are the remainder #713 deliberately discloses rather than leaving implied.
 */
const BASELINE: Readonly<Record<string, number>> = {
  // THE GUARD ITSELF — `await args.removeWorktree()` is the guarded invocation, reached only
  // after the sharer check passed. Guarding it would be circular.
  [rel("packages/shared/src/lib/worktree-claim.ts")]: 1,
  // The adapter itself: `removeWorktree` IS this operation, and `createWorktree`'s
  // leftover-cleanup is guarded by the `isPathClaimed` port instead (part 1 of #713).
  [rel("packages/shared/src/lib/git-service/worktree.ts")]: 4,
  // INSIDE THE GUARDED HELPER — `removeWorktreeAndBranch`'s git call + its retrying
  // directory-removal fallback. Its callers pass through `removeWorktreeUnlessShared`.
  [rel("packages/server/src/services/workspace-cleanup.service.ts")]: 2,
  // OWN RESOURCE — the merge-train gate worktree, created and destroyed in one try/finally.
  [rel("packages/server/src/services/merge-queue.service.ts")]: 1,
  // OWN RESOURCE — rollback of the worktree `createWorkspace` just cut.
  [rel("packages/server/src/services/workspace-create.service.ts")]: 1,
  // SIBLING REPO — `repos.worktreePath`, provisioning rollback + `cleanupSiblingWorktrees`.
  [rel("packages/server/src/services/workspace-repos.service.ts")]: 2,
  // OWN RESOURCE — a fork child's sub-worktree, torn down by the fork that created it.
  [rel("packages/server/src/services/workflow-fork.service.ts")]: 1,
  // TO CONVERT — the orphaned-worktree reconciler. It has its own "nothing claims this"
  // analysis, which is why it is not simply wrong today; it should still route through
  // the one guard so both answers come from the same place.
  [rel("packages/server/src/startup/orphaned-worktree-reconciler.ts")]: 1,
  // TO CONVERT — startup sweep over workspaces whose worktree outlived them.
  [rel("packages/server/src/startup/startup-tasks.ts")]: 1,
};

function rel(posixPath: string): string {
  return posixPath.split("/").join(sep);
}

interface Offender {
  file: string;
  line: number;
  snippet: string;
}

/** Does this call carry `{ recursive: true }` in any argument? */
function hasRecursiveOption(call: ts.CallExpression): boolean {
  return call.arguments.some(
    (arg) =>
      ts.isObjectLiteralExpression(arg)
      && arg.properties.some(
        (p) =>
          ts.isPropertyAssignment(p)
          && ts.isIdentifier(p.name)
          && p.name.text === "recursive"
          && p.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ),
  );
}

/** Does this call destroy a worktree directory? */
function isDestructive(name: string, call: ts.CallExpression, sf: ts.SourceFile): boolean {
  if (DESTRUCTIVE_CALLS.has(name)) return true;
  if (!RECURSIVE_RM.has(name) || !hasRecursiveOption(call)) return false;
  const target = call.arguments[0];
  return target !== undefined && WORKTREE_PATH_EXPR.test(target.getText(sf));
}

/**
 * Every destructive worktree call in the file that is NOT lexically inside a
 * `removeWorktreeUnlessShared(...)` call.
 *
 * The traversal carries the "inside the guard" flag down itself rather than walking parent
 * pointers: `parseGuardSource` parses with `setParentNodes: false` (deliberately — the whole
 * tree is parsed for every guard suite), so `node.parent` is undefined here.
 */
function findUnguardedDeletes(absFile: string, text: string): Offender[] {
  const sf = parseGuardSource(absFile, text);
  const lines = text.split(/\r?\n/);
  const offenders: Offender[] = [];

  const walk = (node: ts.Node, inGuard: boolean): void => {
    let nowInGuard = inGuard;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === GUARD_CALL) {
        nowInGuard = true;
      } else if (name !== null && !inGuard && isDestructive(name, node, sf)) {
        const line = lineOf(sf, node);
        offenders.push({ file: absFile, line, snippet: (lines[line - 1] ?? "").trim() });
      }
    }
    node.forEachChild((child) => walk(child, nowInGuard));
  };

  walk(sf, false);
  return offenders;
}

function scan(): Map<string, Offender[]> {
  const byFile = new Map<string, Offender[]>();
  const packages = ["shared", "server", "mcp-server", "client", "cli"];
  for (const pkg of packages) {
    for (const abs of walkPackageSources(join(PACKAGES_ROOT, pkg, "src"))) {
      const text = readFileSync(abs, "utf8");
      const found = findUnguardedDeletes(abs, text);
      if (found.length > 0) byFile.set(relative(REPO_ROOT, abs), found);
    }
  }
  return byFile;
}

describe("unguarded worktree-delete ratchet (#713)", () => {
  it("flags a raw removal and clears one routed through the guard", () => {
    const source = [
      `await gitService.removeWorktree(repoPath, workspace.workingDir);`,
      `await removeWorktreeUnlessShared({`,
      `  database, workingDir, workspaceId, label: "x",`,
      `  removeWorktree: () => gitService.removeWorktree(repoPath, workingDir),`,
      `});`,
      `await rm(worktreePath, { recursive: true, force: true });`,
      `await rm(oneFile);`,
    ].join("\n");

    expect(findUnguardedDeletes("sample.ts", source).map((o) => o.line)).toEqual([1, 6]);
  });

  it("the scan is not vacuous — it reaches the real package trees", () => {
    // Every assertion below compares counts, and a scan that reaches ZERO files would
    // satisfy them all while proving nothing (the #58 failure mode). Pin the floor.
    const files = walkPackageSources(join(PACKAGES_ROOT, "server", "src"));
    expect(files.length, "scan reached no server sources — the gate is disarmed").toBeGreaterThan(100);
    expect(
      walkPackageSources(join(PACKAGES_ROOT, "shared", "src")).some((f) =>
        f.endsWith(join("git-service", "worktree.ts")),
      ),
      "scan did not reach the worktree module — the gate is disarmed",
    ).toBe(true);
  });

  it("no NEW file deletes a worktree outside the guarded removal, and the baseline only shrinks", () => {
    const byFile = scan();
    const current: Record<string, number> = {};
    for (const [file, offenders] of byFile) current[file] = offenders.length;

    const { over, stale } = compareRatchet(BASELINE, current);

    const detail = (keys: string[]): string =>
      keys
        .map((k) => {
          const file = k.split(":")[0];
          const sites = (byFile.get(file) ?? []).map((o) => `    ${file}:${o.line}  ${o.snippet}`);
          return [`  ${k}`, ...sites].join("\n");
        })
        .join("\n");

    expect(
      over,
      "These files delete a worktree directory without routing through "
        + `${GUARD_CALL} (@agentic-kanban/shared/lib/worktree-claim). Co-residency (#394) is a `
        + "SUPPORTED state, so an unguarded delete can destroy a live agent's checkout — route "
        + "the removal through the guard, or (if it destroys a directory this same function just "
        + `created) add a justified BASELINE entry:\n${detail(over)}`,
    ).toEqual([]);

    expect(
      stale,
      "The baseline is now too high — a site was converted or removed. LOWER the entry (or "
        + `drop it) so the ceiling never becomes a budget:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});
