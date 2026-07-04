

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

/** Agent harnesses a workflow node may pin its launches to. */
export const NODE_AGENT_PROVIDERS = ["claude", "codex", "copilot", "pi"] as const;
export type NodeAgentProvider = (typeof NODE_AGENT_PROVIDERS)[number];

/**
 * Per-node agent override, stored under the `agent` key of a node's JSON config.
 * When the SERVER launches a session for this node (fork children, the join
 * consolidator, spec phase nodes), these values override the board's global
 * provider/profile/model selection — enabling e.g. a Claude reviewer and a
 * Codex reviewer to run in parallel off one fork, with a third harness at the
 * join. Absent/empty fields fall back to the global settings.
 */
export interface NodeAgentOverride {
  provider?: NodeAgentProvider;
  profile?: string;
  model?: string;
}

/** Parse the `agent` override out of a node's JSON config; null when absent/invalid. */
export function getNodeAgentOverride(config: string | null): NodeAgentOverride | null {
  if (!config) return null;
  try {
    const parsed = JSON.parse(config) as { agent?: Record<string, unknown> };
    const raw = parsed.agent;
    if (!raw || typeof raw !== "object") return null;
    const override: NodeAgentOverride = {};
    if (
      typeof raw.provider === "string" &&
      (NODE_AGENT_PROVIDERS as readonly string[]).includes(raw.provider)
    ) {
      override.provider = raw.provider as NodeAgentProvider;
    }
    if (typeof raw.profile === "string" && raw.profile.trim()) override.profile = raw.profile.trim();
    if (typeof raw.model === "string" && raw.model.trim()) override.model = raw.model.trim();
    return Object.keys(override).length > 0 ? override : null;
  } catch {
    return null;
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
