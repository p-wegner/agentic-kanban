/**
 * Put a READ-ONLY copy of the project's test-impact map into a worktree (#1018).
 *
 * ## Why this exists at all
 *
 * The map used to be committed, so a worktree got one for free: it branched from master, and
 * master carried the file. #1018 made the map an untracked, gitignored artifact of the MAIN
 * CHECKOUT — which removes the `chore: rebuild test-impact map` commits that were moving the base
 * under running gates, and takes the free ride with it. Without this step a builder's
 * `impact.mjs select` finds no inventory, exits 2, and both consumers degrade silently:
 * `scripts/test-mine.mjs` falls back to `vitest related`, and the merge gate's `impact` tier
 * reports `selection UNKNOWN`.
 *
 * ## Copy, not a link, and not "read the main checkout"
 *
 * Three options were on the table; the other two fail for reasons worth writing down.
 *
 *  - **Read it from the main checkout** (`KANBAN_MAIN_CHECKOUT`) — the skill resolves its root
 *    with `git rev-parse --show-toplevel` and reads `<root>/<CFG.inventory>`. There is no
 *    inventory-path override that survives that: `inventoryPath()` is `join(ROOT, CFG.inventory)`,
 *    so an absolute path in `.test-impact.json` does not resolve, and `TEST_IMPACT_REPO` moves the
 *    whole ROOT — which would make `select` compute the change set of the MAIN checkout instead of
 *    the branch. That is worse than no map: a confident selection for the wrong diff.
 *  - **A junction/symlink** — Windows junction creation is permission-dependent here (the reason
 *    Dependency Symlinks was turned off for this project), and it would make the worktree's map
 *    move under a running gate every time the main checkout rebuilt. A copy is a snapshot, which
 *    is exactly the semantics a gate wants.
 *  - **A copy** — 1.4 MB, taken at provisioning and re-taken on relaunch, so a resumed workspace
 *    picks up a fresher map. This is what we do.
 *
 * ## The copy is gitignored in the worktree too
 *
 * The same `.gitignore` line covers it, since the worktree is a checkout of the same tree. So the
 * copy never lands in the branch diff and never dirties the worktree — which matters because
 * `workspaceLaunchPreflight` refuses to relaunch a worktree with uncommitted changes.
 *
 * ## Absent is a supported state, not a failure
 *
 * Best-effort throughout: a project with no map (a fresh clone before the first sweep, a project
 * that never opted in) simply gets no copy, and the skill then widens to the package tier and says
 * so on its own `select` line. Failing provisioning over a test-selection optimisation would trade
 * a wider test run for no ticket at all.
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

import { IMPACT_MAP_PATH } from "../test-impact-map.service.js";

export type WorktreeMapOutcome = "copied" | "absent" | "failed";

export interface WorktreeMapResult {
  outcome: WorktreeMapOutcome;
  /** Bytes copied, when `outcome === "copied"` — the log line's only interesting number. */
  bytes?: number;
  detail?: string;
}

/**
 * Copy `<repoPath>/docs/tests/impact-map.json` to the same relative path in `worktreePath`.
 *
 * Never throws. A worktree that IS the main checkout (a direct workspace) is a no-op rather than a
 * self-copy — `copyFile` onto itself would truncate the source, which is the one way this helper
 * could destroy the artifact it exists to distribute.
 */
export async function materializeImpactMapIntoWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<WorktreeMapResult> {
  try {
    const source = join(repoPath, ...IMPACT_MAP_PATH.split("/"));
    const target = join(worktreePath, ...IMPACT_MAP_PATH.split("/"));
    if (source === target) return { outcome: "absent", detail: "worktree is the main checkout" };

    let bytes: number;
    try {
      bytes = (await stat(source)).size;
    } catch {
      // The main checkout has no map yet. Expected on a fresh clone and on every project that
      // does not use the skill — not worth a log line, and definitely not worth a failure.
      return { outcome: "absent" };
    }

    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    return { outcome: "copied", bytes };
  } catch (err) {
    return { outcome: "failed", detail: errorMessage(err) };
  }
}
