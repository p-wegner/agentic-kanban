// @gate:always-run when:packages/server/src/services/**,packages/server/src/startup/** — scans the services and startup trees for hand-spelled base fallbacks; imports nothing it checks (#1239).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkPackageSources, packagesRootFrom, compareRatchet } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * #1239 — a workspace's base is resolved in ONE place, `services/workspace-base.ts`
 * (`resolveWorkspaceBase` / `resolveWorkspaceBaseOrNull`), and the merge, review, rebase,
 * diff, conflict-resolution, already-merged and containment paths read it there.
 *
 * The rest still spell the fallback by hand — `x.baseBranch || defaultBranch` — which is
 * CORRECT (it honours the workspace row's base, so a heal workspace based on an rc is handled)
 * but invisible: nothing distinguishes "honours the workspace base" from "assumes the project
 * default" without opening the file. This is the disclosure channel for that remainder, in
 * the shape CLAUDE.md asks of a partial refactor: a grandfathered set that may only SHRINK.
 * Converting one is a one-line edit plus lowering its count here; a NEW hand-spelled fallback
 * fails, and so does a stale entry (`compareRatchet` reports both directions).
 *
 * A substring scan, not an AST pass: the spelling is two identifiers and an operator, and the
 * only false negative — a renamed `defaultBranch` local — is not a shape anyone writes.
 */
const HAND_SPELLED = /\bbaseBranch \|\| (?:project\.)?defaultBranch\b/g;

const GRANDFATHERED: Readonly<Record<string, number>> = {
  "services/board-status-enrichment.ts": 1,
  "services/file-contention.service.ts": 1,
  "services/issue-merged-commits.service.ts": 1,
  "services/merge-queue.service.ts": 1,
  "services/project-worktrees.service.ts": 1,
  "services/session-manager/session-lifecycle.ts": 2,
  "services/worker-fleet.service.ts": 1,
  "services/workspace-all-repos.ts": 3,
  "services/workspace-commits.ts": 2,
  "services/workspace-crud.service.ts": 2,
  "services/workspace-launch-failures.service.ts": 1,
  "services/workspace-launch-preview.service.ts": 1,
  "services/workspace-repo-status-batch.service.ts": 1,
  "services/workspace-scorecard.service.ts": 1,
  "services/workspace-session.service.ts": 2,
  "services/workspace-summary-projection.service.ts": 1,
  "services/workspace-summary.service.ts": 2,
  "services/workspace-unmerged-classification.service.ts": 1,
  "startup/exit-workflow.ts": 1,
  "startup/exit/fix-and-merge-exit.ts": 1,
  "startup/exit/review-launch.ts": 2,
  "startup/hand-merged-branch-reconciler.ts": 1,
  "startup/merge-workflow.ts": 1,
};

/** The resolver itself spells the fallback once, by definition. */
const RESOLVER = "services/workspace-base.ts";

const serverSrc = `${packagesRootFrom(import.meta.dirname!, 3)}/server/src`;

function countHandSpelled(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const dir of ["services", "startup"]) {
    for (const file of walkPackageSources(`${serverSrc}/${dir}`)) {
      const rel = relative(serverSrc, file).replace(/\\/g, "/");
      if (rel === RESOLVER) continue;
      const n = (readFileSync(file, "utf8").match(HAND_SPELLED) ?? []).length;
      if (n > 0) counts[rel] = n;
    }
  }
  return counts;
}

describe("workspace base is resolved through services/workspace-base.ts (#1239)", () => {
  it("the hand-spelled `baseBranch || defaultBranch` fallback only shrinks — and the baseline is not stale", () => {
    const verdict = compareRatchet(GRANDFATHERED, countHandSpelled());
    expect(verdict.over, "route the read through resolveWorkspaceBase / resolveWorkspaceBaseOrNull instead of spelling the fallback by hand").toEqual([]);
    expect(verdict.stale, "a site was converted — lower its count here so the baseline cannot become a budget").toEqual([]);
  });

  it("the converted paths import the resolver", () => {
    for (const file of [
      "services/workspace-merge.service.ts",
      "services/review.service.ts",
      "services/workspace-rebase.service.ts",
      "services/workspace-diff.service.ts",
      "services/workspace-resolve-conflicts.service.ts",
      "services/workspace-already-merged.service.ts",
      "services/branch-containment.service.ts",
    ]) {
      expect(readFileSync(`${serverSrc}/${file}`, "utf8"), file).toMatch(/from "\.\/workspace-base\.js"/);
    }
  });
});
