import type { WorkspaceResponse } from "@agentic-kanban/shared";

// Pure launch-eligibility logic for WorkspacePanel (the worst-risk client file):
// quick-launch provider detection and resume/restart eligibility. Side-effect-free
// so the edge cases (status gates, in-flight session, provider-session presence)
// are unit-testable; the panel keeps only its stateful orchestration.
//
// Sessions are typed structurally (not the component's SessionInfo) so this stays a
// leaf with no up-import into components/.

/** The session fields relaunch eligibility reads. */
export interface RelaunchSession {
  id: string;
  providerSessionId?: string | null;
}

/** Which provider a quick-launch will use, from the selected profile token or the global default. */
export function detectQuickLaunchProvider(
  selectedProfile: string,
  providerPref: string | undefined,
): { isClaude: boolean; isCodex: boolean } {
  if (selectedProfile === "") {
    return {
      isClaude: providerPref !== "codex" && providerPref !== "copilot",
      isCodex: providerPref === "codex",
    };
  }
  return {
    isClaude: selectedProfile.startsWith("claude:"),
    isCodex: selectedProfile.startsWith("codex:"),
  };
}

export interface RelaunchContext {
  /** A session is actively streaming in the panel. */
  isRunning: boolean;
  /** There is an active (selected) session. */
  hasActiveSession: boolean;
  /** The last session id recorded for this workspace, if any. */
  lastSessionId: string | undefined;
}

function canRelaunch(
  ws: Pick<WorkspaceResponse, "status">,
  sessions: RelaunchSession[],
  ctx: RelaunchContext,
  wantProviderSession: boolean,
): boolean {
  if (ws.status !== "active" && ws.status !== "idle") return false;
  if (ctx.isRunning || ctx.hasActiveSession || !ctx.lastSessionId) return false;
  return sessions.some((s) =>
    s.id === ctx.lastSessionId && (wantProviderSession ? !!s.providerSessionId : !s.providerSessionId),
  );
}

/** Resume = relaunch the recorded session with its provider session id (continue the conversation). */
export function canResumeWorkspace(ws: Pick<WorkspaceResponse, "status">, sessions: RelaunchSession[], ctx: RelaunchContext): boolean {
  return canRelaunch(ws, sessions, ctx, true);
}

/** Restart = relaunch when the last session has no provider session id to resume from. */
export function canRestartWorkspace(ws: Pick<WorkspaceResponse, "status">, sessions: RelaunchSession[], ctx: RelaunchContext): boolean {
  return canRelaunch(ws, sessions, ctx, false);
}
