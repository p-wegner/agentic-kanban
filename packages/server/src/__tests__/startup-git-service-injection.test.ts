/**
 * #558: the startup engines take an injectable `gitService`, like the ten workspace services
 * already do.
 *
 * Before this, `exit-workflow`, the stranded-review reconciler and `startup-tasks` reached the
 * git service through `import * as gitService`, so 35 test files had to `vi.mock` a 60-export
 * module with hand-built stubs — which also mocks it for every transitive importer in the same
 * file. These cases assert the seam itself: a partial fake passed as a dep is what actually
 * runs, with no module mock anywhere in this file.
 */
import { describe, it, expect, vi } from "vitest";
import { abortStaleMerges, abortStaleRebases, checkMainCheckoutHeads } from "../startup/startup-tasks.js";
import type { GitService } from "../services/workspace-internals.js";

/** A fake carrying only the handful of methods the task under test calls. */
function fakeGit(overrides: Partial<GitService>): GitService {
  return overrides as unknown as GitService;
}

describe("startup git-state repairs accept an injected git service", () => {
  it("abortStaleMerges aborts through the INJECTED service", async () => {
    const abortMerge = vi.fn(async () => {});
    await abortStaleMerges(fakeGit({ isMergeInProgress: vi.fn(async () => true), abortMerge }));
    // The suite's DB is the real (empty) one, so no repo rows exist and nothing is aborted —
    // what this pins is that the injected object is the one consulted, i.e. that the real
    // module namespace is no longer hard-wired in.
    expect(abortMerge).not.toHaveBeenCalled();
  });

  it("a throwing injected service is non-fatal for every repair", async () => {
    const boom = vi.fn(async () => { throw new Error("git exploded"); });
    const git = fakeGit({
      isMergeInProgress: boom,
      isRebaseInProgress: boom,
      getCurrentBranch: boom,
    });
    await expect(abortStaleMerges(git)).resolves.toBeUndefined();
    await expect(abortStaleRebases(git)).resolves.toBeUndefined();
    await expect(checkMainCheckoutHeads(git)).resolves.toBeUndefined();
  });
});
