

/** Parse the `guidance` string out of a node's JSON config, if present. */
export function getNodeGuidance(config: string | null): string | null {
  if (!config) return null;
  try {
    const parsed = JSON.parse(config) as { guidance?: string };
    return parsed.guidance ?? null;
  } catch {
    return null;
  }
}

export function isSpecPlanningStageName(name: string | null | undefined): boolean {
  const normalized = name?.trim().toLowerCase();
  return normalized === "specify" || normalized === "design" || normalized === "tasks";
}

/**
 * How a parallel-join node consolidates its fork children:
 *  - "artifacts" (default): collect each child branch's diff into an artifacts
 *    file and let the join agent merge them by hand.
 *  - "merge": the server auto-merges every child branch back into the parent
 *    branch at the join (ideal for additive, non-conflicting work like each
 *    child writing a different research doc).
 */
export type JoinStrategy = "artifacts" | "merge";

/** Parse the `joinStrategy` out of a (join) node's JSON config. Defaults to "artifacts". */
export function getJoinStrategy(config: string | null): JoinStrategy {
  if (!config) return "artifacts";
  try {
    const parsed = JSON.parse(config) as { joinStrategy?: string };
    return parsed.joinStrategy === "merge" ? "merge" : "artifacts";
  } catch {
    return "artifacts";
  }
}

/**
 * How a parallel-fork node runs its children:
 *  - "worktree" (default): each child gets its own git worktree + branch (forked
 *    from the parent branch HEAD) and they run concurrently; the join consolidates.
 *  - "shared": children run SEQUENTIALLY in the parent's worktree on the parent's
 *    branch — each commits its contribution before the next starts. Suits additive
 *    work (e.g. each stage appends a different research doc) with no merge step.
 *    (Sequential, not parallel: independent agent processes can't share one git
 *    index safely — concurrent commits would collide on .git/index.lock.)
 */
export type ForkMode = "worktree" | "shared";

/** Parse the `forkMode` out of a (fork) node's JSON config. Defaults to "worktree". */
export function getForkMode(config: string | null): ForkMode {
  if (!config) return "worktree";
  try {
    const parsed = JSON.parse(config) as { forkMode?: string };
    return parsed.forkMode === "shared" ? "shared" : "worktree";
  } catch {
    return "worktree";
  }
}

/**
 * Derive the default board status name from a workflow node's structural type.
 * Nodes with an explicit `statusName` always take precedence over this default;
 * this function is the fallback when statusName is null/undefined.
 *
 * - start  → "Backlog"  (issue not yet picked up)
 * - end    → "Done"     (workflow complete)
 * - normal / parallel-fork / parallel-join → "In Progress" (work in flight)
 */
export function deriveStatusName(nodeType: string): string {
  switch (nodeType) {
    case "start":
      return "Backlog";
    case "end":
      return "Done";
    default:
      return "In Progress";
  }
}

/**
 * Returns true when the node type indicates a terminal (done/closed) state.
 * Accepts null/undefined for convenience (non-workflow issues → false).
 */
export function isTerminalNodeType(nodeType: string | null | undefined): boolean {
  return nodeType === "end";
}
