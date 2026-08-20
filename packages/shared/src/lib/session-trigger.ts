/**
 * The session trigger-type vocabulary (#495).
 *
 * `sessions.trigger_type` is a free `text` column, and "what kind of session is this"
 * used to be decided by eight-plus independent string checks: `classifyTrigger` existed
 * four times byte-identically (two server libs, two MCP tools), "is this a builder
 * session" existed four times WITH DRIFT, and the client carried its own label maps
 * including a `merge` trigger the server has not written in a long time.
 *
 * One table decides all of it. Adding a trigger type is a row here, not a sweep.
 *
 * The two builder flags are DELIBERATELY different, not an oversight that got frozen:
 * `builderLaunch` answers "does this session continue the worktree, i.e. should a
 * rate-limit rotation relaunch it on a fresh profile", which is true for `auto-start`
 * and every `skill:*` run; `builderCycle` answers "does the monitor cycle / stall
 * warning treat this as the ticket's implementer", which those two are NOT (the monitor
 * starts them itself and must not then count them as progress it is waiting on), while
 * an interactive `chat` IS. Collapsing them changes behaviour in both directions.
 */

/** Lifecycle role, as the review-effectiveness analyses bucket a session. */
export type SessionTriggerRole = "review" | "build" | "rework" | "noise" | "other";

/** Which lifecycle phase a session opens on a workspace timeline. */
export type SessionTriggerPhase = "build" | "landing";

export interface SessionTriggerTraits {
  role: SessionTriggerRole;
  /** Continues the worktree — relaunched on a fresh profile after a rate-limit rotation. */
  builderLaunch: boolean;
  /** Counts as the ticket's implementer for the monitor cycle and the stall warning. */
  builderCycle: boolean;
  phase: SessionTriggerPhase;
  /** Human label for a session badge. `null` = too routine to badge (see `triggerBadgeLabel`). */
  label: string | null;
}

export const SESSION_TRIGGER_TRAITS = {
  agent: { role: "build", builderLaunch: true, builderCycle: true, phase: "build", label: "Agent" },
  "auto-start": { role: "build", builderLaunch: true, builderCycle: false, phase: "build", label: "Auto-start" },
  chat: { role: "rework", builderLaunch: false, builderCycle: true, phase: "build", label: "Chat" },
  "plan-implement": { role: "build", builderLaunch: true, builderCycle: true, phase: "build", label: null },
  "plan-reject": { role: "rework", builderLaunch: false, builderCycle: false, phase: "build", label: null },
  review: { role: "review", builderLaunch: false, builderCycle: false, phase: "landing", label: "AI Review" },
  "fix-and-merge": { role: "rework", builderLaunch: false, builderCycle: false, phase: "landing", label: "Fix & Merge" },
  "fix-conflicts": { role: "rework", builderLaunch: false, builderCycle: false, phase: "landing", label: "Fix Conflicts" },
  /**
   * Legacy: no producer writes `merge` any more, but historic rows do, and both client
   * badge maps still render it. Kept as a row so those rows keep their label instead of
   * silently degrading to no badge.
   */
  merge: { role: "other", builderLaunch: false, builderCycle: false, phase: "landing", label: "AI Merge" },
  verify: { role: "other", builderLaunch: false, builderCycle: false, phase: "landing", label: null },
  learning: { role: "other", builderLaunch: false, builderCycle: false, phase: "build", label: "Learning" },
  bisect: { role: "other", builderLaunch: false, builderCycle: false, phase: "build", label: "Auto-bisect" },
  reconcile: { role: "other", builderLaunch: false, builderCycle: false, phase: "landing", label: null },
} as const satisfies Record<string, SessionTriggerTraits>;

/** The literal trigger types. A `skill:<name>` run is the open-ended other half. */
export type SessionTriggerLiteral = keyof typeof SESSION_TRIGGER_TRAITS;
export type SessionTriggerType = SessionTriggerLiteral | `skill:${string}`;

export const SESSION_TRIGGER_LITERALS = Object.keys(SESSION_TRIGGER_TRAITS) as SessionTriggerLiteral[];

function literalTraits(t: string): SessionTriggerTraits | null {
  return (SESSION_TRIGGER_TRAITS as Record<string, SessionTriggerTraits>)[t] ?? null;
}

/**
 * Traits for any persisted trigger value, including `skill:*` and unknown strings.
 *
 * A legacy initial session has a null triggerType and is a build run. `skill:*` sessions
 * inherit the skill's nature: the code-review skill is a review, board-monitor/navigator
 * runs are analysis noise that the effectiveness reports drop entirely, everything else
 * is a builder the board launched on the ticket's behalf.
 */
export function triggerTraits(t: string | null | undefined): SessionTriggerTraits {
  if (!t) return { role: "build", builderLaunch: true, builderCycle: true, phase: "build", label: null };
  const known = literalTraits(t);
  if (known) return known;
  if (t.startsWith("skill:")) {
    const skill = t.slice("skill:".length);
    const role: SessionTriggerRole = skill.startsWith("code-review")
      ? "review"
      : skill.startsWith("board-monitor") || skill.startsWith("board-navigator")
        ? "noise"
        : "build";
    return {
      role,
      builderLaunch: true,
      builderCycle: false,
      phase: role === "review" ? "landing" : "build",
      label: `✨ ${humanizeSkillName(skill)}`,
    };
  }
  // Unknown producer: treat as a build run, which is what every previous classifier did.
  return { role: "build", builderLaunch: true, builderCycle: false, phase: "build", label: null };
}

const SKILL_NAME_ACRONYMS = new Set(["ui", "ai", "api", "llm", "url", "http", "id"]);

/** `board-monitor` -> `Board Monitor`, `ai-review` -> `AI Review`. */
export function humanizeSkillName(name: string): string {
  return name.replace(/[-_]/g, " ").replace(/\w+/g, (w) =>
    SKILL_NAME_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
  );
}

export function triggerRole(t: string | null | undefined): SessionTriggerRole {
  return triggerTraits(t).role;
}

export function triggerPhase(t: string | null | undefined): SessionTriggerPhase {
  return triggerTraits(t).phase;
}

/** Continues the worktree — see `SessionTriggerTraits.builderLaunch`. */
export function isBuilderLaunchTrigger(t: string | null | undefined): boolean {
  return triggerTraits(t).builderLaunch;
}

/** The ticket's implementer, as the monitor cycle counts it — see `builderCycle`. */
export function isBuilderCycleTrigger(t: string | null | undefined): boolean {
  return triggerTraits(t).builderCycle;
}

/** Badge label, or null when this trigger is too routine to badge. */
export function triggerBadgeLabel(t: string | null | undefined): string | null {
  return triggerTraits(t).label;
}
