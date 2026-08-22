/**
 * The provider usage-limit exit path (#700 extraction).
 *
 * ONE responsibility: an agent session ended because the account it was running on hit its
 * provider quota. That is not an ordinary exit and shares nothing with the review/builder/
 * fix-and-merge handlers — it never touches merge policy, review sessions, project statuses or
 * the workflow graph. What it does own, end to end, is:
 *
 *   read the quota hint off the session stats  →  rotate the provider's profile ring (cooling the
 *   exhausted profile)  →  decide relaunch-vs-block  →  relaunch the worktree on the fresh account
 *   with a continuation prompt, or leave it blocked with a reason  →  reconcile a fork child that
 *   may have joined during the race.
 *
 * That whole chain, plus the per-provider table it is parameterized by, is this module. The
 * Codex (license) and Claude (subscription) branches used to be ~45 lines of near-identical logic
 * that could drift apart (the #696–699 / #779 rotation-outage class); `UsageLimitProviderConfig`
 * plus one implementation is what collapses them, and keeping the table beside the only code that
 * reads it is the point of the boundary.
 *
 * No `db` singleton and no raw drizzle: the connection is injected, and the two reads go through
 * `getWorkspaceById` / `getIssueDescription`.
 */
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { readUsageLimitStats, type UsageLimitKind } from "@agentic-kanban/shared/lib/session-stats-blob";
import { getAllPreferencesCached } from "../../repositories/preferences.repository.js";
import { getIssueDescription } from "../../repositories/issue.repository.js";
import { getWorkspaceById } from "../../repositories/workspace-reads.repository.js";
import { setWorkspaceStatus } from "../../repositories/workspace-status.repository.js";
import { rotateCodexLicense } from "../../services/codex-license-ring.js";
import { rotateClaudeSubscription } from "../../services/claude-subscription-ring.js";
import { emitButlerSystemEvent } from "../../services/butler-event-feed.js";
import { decideRateLimitExit, formatRateLimitBlockedReason } from "../rate-limit-exit-decision.js";
import type { RateLimitProvider } from "../rate-limit-exit-decision.js";
import type { SessionRoleFlags } from "../session-exit-classification.js";
import type { ProviderId, ProviderName } from "../../services/agent-provider.js";
import type { Database } from "../../db/index.js";
import type { createBoardEvents } from "../../services/board-events.js";
import type { createSessionManager } from "../../services/session.manager.js";

/** Structural view of a profile-ring rotation result (shared by the Codex/Claude rings). */
export type RingRotationResult = { rotated: boolean; fromProfile: string; toProfile?: string; reason: string };

/**
 * Per-provider knobs for the session-exit usage-limit path. The Codex (license) and Claude
 * (subscription) branches were ~45 lines of near-identical logic — rotate the profile ring,
 * decide relaunch-vs-block, then relaunch the worktree or leave it blocked — that could drift
 * apart (the #696–699 / #779 rotation-outage class). This config + the shared
 * `handleUsageLimitExit` collapse them into one implementation parameterized only by what
 * actually differs between providers.
 */
export interface UsageLimitProviderConfig {
  /** Human-facing provider label used in logs and butler events. */
  label: RateLimitProvider;
  /** Settings pref key holding this provider's active profile. */
  profilePrefKey: string;
  /** Executor provider passed to `startSession` on relaunch. */
  executorProvider: ProviderId;
  /** `profile.provider` passed to `startSession` on relaunch. */
  profileSelectionProvider: ProviderName;
  /** The provider discriminant on a usage-limit stats blob (#542). */
  kind: UsageLimitKind;
  /** Rotate the provider's profile ring, cooling the exhausted profile. */
  rotate: (
    database: Database,
    prefMap: Map<string, string>,
    currentProfile: string,
    resetsAt: string | null,
    now: Date,
  ) => Promise<RingRotationResult>;
}

const USAGE_LIMIT_PROVIDERS: UsageLimitProviderConfig[] = [
  {
    label: "Codex",
    profilePrefKey: "codex_profile",
    executorProvider: "codex",
    profileSelectionProvider: "codex",
    kind: "codex",
    rotate: rotateCodexLicense,
  },
  {
    label: "Claude",
    profilePrefKey: "claude_profile",
    executorProvider: "claude-code",
    profileSelectionProvider: "claude",
    kind: "claude",
    rotate: rotateClaudeSubscription,
  },
];

/**
 * Which provider (if any) this session's stats blob says hit its usage limit. ONE read of the
 * discriminant picks the config (#542), instead of asking each provider's predicate whether the
 * blob is its own. `undefined` = not a usage-limit exit at all, i.e. the dispatcher carries on.
 */
export function findUsageLimitProvider(statsJson: string | null | undefined): UsageLimitProviderConfig | undefined {
  const usageLimit = readUsageLimitStats(statsJson);
  return usageLimit ? USAGE_LIMIT_PROVIDERS.find((cfg) => cfg.kind === usageLimit.kind) : undefined;
}

/** Extract the "try again / resets at X" hint persisted on the rate-limited session's stats. */
function parseRateLimitRetryAfter(statsJson: string | null | undefined): string | null {
  return readUsageLimitStats(statsJson)?.retryAfter ?? null;
}

/** Build a continuation prompt so the rotated-to account picks the ticket back up in the same worktree. */
async function buildRotationContinuationPrompt(database: Database, issueId: string, providerLabel: string): Promise<string> {
  const issue = await getIssueDescription(issueId, database);
  const heading = issue ? `ticket #${issue.issueNumber}: ${issue.title}` : "your current ticket";
  return [
    `You are resuming work on ${heading}.`,
    `A previous ${providerLabel} session was interrupted by an account usage limit and has now resumed on a different ${providerLabel} account.`,
    "Your partial work is already in THIS worktree. First run `git status` and `git diff` to see what exists, then continue implementing the ticket to completion and COMMIT when done.",
    "",
    "Ticket description:",
    issue?.description || "(no description)",
  ].join("\n");
}

export interface UsageLimitExitDeps {
  database: Database;
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  /** #1000: reconcile a fork child whose join raced this exit. Optional, best-effort. */
  reconcileForkChildOnExit?: (workspaceId: string) => Promise<void>;
}

/** What the dispatcher needs to know about the exiting session to route a usage-limit exit. */
export interface UsageLimitExitInput {
  cfg: UsageLimitProviderConfig;
  workspaceId: string;
  sessionId: string;
  issueId: string;
  projectId: string;
  now: string;
  statsJson: string | null | undefined;
  roleFlags: SessionRoleFlags;
}

/**
 * Shared session-exit handler for a provider usage-limit (Codex license / Claude subscription).
 * Rotates the profile ring; for a builder session on a freshly rotated profile it relaunches the
 * worktree to continue the ticket, otherwise it leaves the workspace blocked with a clear reason.
 */
export function createUsageLimitExitHandler({ database: db, sessionManager, boardEvents, reconcileForkChildOnExit }: UsageLimitExitDeps) {
  return async function handleUsageLimitExit(input: UsageLimitExitInput): Promise<void> {
    const { cfg, workspaceId, sessionId, issueId, projectId, now, statsJson, roleFlags } = input;
    const resetsAt = parseRateLimitRetryAfter(statsJson);
    const rotationPrefMap = toPrefMap(await getAllPreferencesCached(db));
    const currentProfile = rotationPrefMap.get(cfg.profilePrefKey) || "default";
    const rotation = await cfg.rotate(db, rotationPrefMap, currentProfile, resetsAt, new Date(now));
    // Builder = none of the special roles. Resolved from the in-memory sets AND the
    // persisted triggerType so a reattached (post-restart) review/fix/learning session
    // is never relaunched as if it were a builder (#950).
    const builder = !roleFlags.isReview && !roleFlags.isFixAndMerge && !roleFlags.isLearning;

    // #1000: a fork child can independently finish and close itself (joined) via
    // handleChildJoined WHILE this usage-limit exit is being processed for the
    // same workspace (the classic race the ticket describes). Re-read fresh
    // immediately before writing so that race's winner is respected instead of
    // unconditionally overwriting a workspace another exit path already closed.
    const fresh = await getWorkspaceById(workspaceId, db);
    if (fresh?.status === "closed") {
      console.log(`[workflow] ${cfg.label}-rate-limited session ${sessionId} exited but workspace ${workspaceId} is already closed (forkStatus=${fresh.forkStatus ?? "n/a"}) — skipping blocked/relaunch write`);
      return;
    }

    if (decideRateLimitExit(rotation, builder).action === "relaunch") {
      try {
        const continuation = await buildRotationContinuationPrompt(db, issueId, cfg.label);
        await setWorkspaceStatus(db, workspaceId, "active", { now });
        const relaunchSessionId = await sessionManager.startSession({
          workspaceId,
          prompt: continuation,
          agentCommand: rotationPrefMap.get("agent_command") || undefined,
          agentArgs: rotationPrefMap.get("agent_args") || undefined,
          provider: cfg.executorProvider,
          triggerType: "agent",
          profile: { provider: cfg.profileSelectionProvider, name: rotation.toProfile ?? "" },
        });
        boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
        boardEvents.broadcast(projectId, "issue_updated");
        emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `${cfg.label} usage limit on '${rotation.fromProfile}' — rotated to '${rotation.toProfile}' and relaunched workspace ${workspaceId}.` });
        console.log(`[workflow] ${cfg.label} profile rotated ${rotation.fromProfile} -> ${rotation.toProfile}; relaunched workspace ${workspaceId} session ${relaunchSessionId}`);
        return;
      } catch (err) {
        console.error(`[workflow] ${cfg.label} profile rotation relaunch failed:`, err);
        // fall through to blocked
      }
    }

    await setWorkspaceStatus(db, workspaceId, "blocked", { now });
    boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
    boardEvents.broadcast(projectId, "session_completed");
    boardEvents.broadcast(projectId, "workflow_error");
    const blockedReason = formatRateLimitBlockedReason(cfg.label, workspaceId, rotation);
    emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: blockedReason });
    console.warn(`[workflow] ${cfg.label}-rate-limited workspace ${workspaceId} from session ${sessionId} left blocked (${rotation.reason})`);
    // #1000: a rate-limit exit can race a fork child's own propose_transition onto
    // its join node — the child successfully finished and moved itself, but this
    // blocked-write and the cross-process join notify are unordered. Reconcile
    // now so a child that is actually done doesn't sit blocked until the 30-min
    // overdue timeout wrongly cancels it.
    if (reconcileForkChildOnExit) {
      await reconcileForkChildOnExit(workspaceId).catch((err) =>
        console.warn(`[workflow] fork-child join reconcile failed (non-fatal) for workspace ${workspaceId}:`, err instanceof Error ? err.message : String(err)),
      );
    }
  };
}
