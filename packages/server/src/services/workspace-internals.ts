import { workspaces } from "@agentic-kanban/shared/schema";
import type { WorkspaceSetupRun, WorkspaceSymlinkRun } from "@agentic-kanban/shared";
import type { ProviderName } from "./agent-provider.js";
import type { AgentSettings } from "./agent-settings.service.js";
import * as realGitService from "./git.service.js";

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function applyWorkspaceAgentSelection(
  settings: AgentSettings,
  workspace: typeof workspaces.$inferSelect,
): AgentSettings {
  const provider = workspace.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot") return settings;

  const profileName = workspace.claudeProfile || undefined;
  const agentArgs = provider === "claude"
    ? settings.agentArgs
    : settings.agentArgs
      ?.split(/\s+/)
      .filter((arg) => arg && arg !== "--dangerously-skip-permissions")
      .join(" ") || undefined;
  return {
    ...settings,
    agentArgs,
    provider,
    claudeProfile: provider === "claude" ? profileName : undefined,
    profile: profileName ? { provider: provider as ProviderName, name: profileName } : undefined,
  };
}

export function requireBaseBranch(baseBranch: string | null | undefined): string {
  if (!baseBranch) {
    throw new WorkspaceError(
      "No default branch configured for this project. Set a default branch in project settings or choose a base branch.",
      "BAD_REQUEST",
    );
  }
  return baseBranch;
}

export type TurnResult =
  | { type: "sent" }
  | { type: "resumed"; sessionId: string };

export interface CreateWorkspaceInput {
  issueId: string;
  branch?: string;
  isDirect?: boolean;
  baseBranch?: string;
  requiresReview?: boolean;
  thoroughReview?: boolean;
  planMode?: boolean;
  tddMode?: boolean;
  includeVisualProof?: boolean;
  skipSetup?: boolean;
  customPrompt?: string;
  /** Markdown block of answered preflight clarifications, prepended to the agent's
   *  initial context so it starts with the resolved Q&A. */
  clarifications?: string;
  skillId?: string;
  /** Name of a disk-only skill (no DB entry) — used when id starts with "disk:" */
  skillName?: string;
  profile?: { provider?: string; name?: string };
  claudeProfile?: string;
  /** Claude model tier (e.g. "opus"). Falls back to the default_model preference when omitted. */
  model?: string;
  /** Skip the context-packer for lightweight tickets that don't need auto-context. */
  skipContextPacker?: boolean;
}

export interface CreateWorkspaceResult {
  id: string;
  issueId: string;
  branch: string;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  includeVisualProof: boolean;
  status: string;
  provider: ProviderName;
  latestSetup?: WorkspaceSetupRun;
  latestSymlink?: WorkspaceSymlinkRun;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/** Subset of the git service that workspace services depend on. Injectable for tests. */
export type GitService = typeof realGitService;

export const MERGE_LOCK_STALE_MS = 15 * 60 * 1000;

export interface ActiveMergeLock {
  promise: Promise<unknown>;
  workspaceId: string;
  repoPath: string;
  startedAt: string;
  startedAtMs: number;
}

/** Merge serialization: one active merge per repo at a time. Shared across services. */
export const activeMerges = new Map<string, ActiveMergeLock>();

export function describeMergeLock(lock: ActiveMergeLock, nowMs = Date.now()) {
  const ageMs = Math.max(0, nowMs - lock.startedAtMs);
  return {
    repoPath: lock.repoPath,
    activeWorkspaceId: lock.workspaceId,
    startedAt: lock.startedAt,
    ageMs,
    staleAfterMs: MERGE_LOCK_STALE_MS,
    isStale: ageMs > MERGE_LOCK_STALE_MS,
  };
}
