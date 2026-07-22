// Pure phase-derivation for the Workspace Lifecycle Timeline (#96).
//
// Turns the timestamps a workspace ALREADY carries (createdAt, latest setup run,
// session start/end + trigger types, mergedAt / closedAt) into an ordered list of
// contiguous lifecycle phases with elapsed durations — no schema change, no fetch.
// The active (still-running) phase is extended to `now`, which is injected so the
// derivation stays a pure function of its inputs and is trivially unit-testable.

/** A lifecycle phase with a measurable duration. `merged` is the terminal endpoint (see {@link WorkspaceLifecycle.terminal}), not a phase kind. */
export type LifecyclePhaseKind = "created" | "setup" | "building" | "review";

/** How the timeline ends: work landed, workspace abandoned/closed, or still in flight. */
export type LifecycleTerminal = "merged" | "closed" | "ongoing";

export interface LifecyclePhase {
  kind: LifecyclePhaseKind;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** True for the current, still-running phase (its end is `now`, terminal is "ongoing"). */
  ongoing: boolean;
}

/** One repo's landed/stranded state, overlaid as a marker on the merge endpoint (multi-repo). */
export interface RepoMergeMarker {
  /** Repo display name; "leading" for the leading repo. */
  name: string;
  merged: boolean;
  stranded: boolean;
}

export interface LifecycleSessionInput {
  startedAt: string;
  endedAt?: string | null;
  triggerType?: string | null;
}

export interface WorkspaceLifecycleInput {
  createdAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  /** Latest setup run (from WorkspaceResponse.latestSetup). */
  setup?: { startedAt?: string | null; endedAt?: string | null } | null;
  sessions?: LifecycleSessionInput[] | null;
  /** Per-repo merge markers for a multi-repo workspace (from repo-merge-status). */
  repoMarkers?: RepoMergeMarker[] | null;
}

export interface WorkspaceLifecycle {
  startMs: number;
  endMs: number;
  totalMs: number;
  phases: LifecyclePhase[];
  terminal: LifecycleTerminal;
  repoMarkers: RepoMergeMarker[];
}

const KIND_ORDER: Record<LifecyclePhaseKind, number> = {
  created: 0,
  setup: 1,
  building: 2,
  review: 3,
};

/** Parse an ISO string to epoch ms, or null when absent/unparseable. */
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Classify a session by its trigger into which lifecycle phase it opens. */
function classifySession(triggerType: string | null | undefined): "build" | "landing" {
  if (triggerType === "review") return "landing";
  if (triggerType === "merge" || triggerType === "fix-and-merge" || triggerType === "fix-conflicts") return "landing";
  return "build";
}

/**
 * Derive the ordered lifecycle phases for a workspace.
 *
 * Phases are contiguous segments covering [createdAt, endMs]; each phase runs until
 * the next phase's start boundary (or the terminal end). `endMs`/`terminal` come from
 * mergedAt (landed) → closedAt (abandoned) → `now` (still in flight), in that order.
 */
export function deriveWorkspaceLifecycle(
  input: WorkspaceLifecycleInput,
  now: number,
): WorkspaceLifecycle {
  const createdMs = ms(input.createdAt) ?? now;

  // Terminal endpoint: landed > abandoned > ongoing.
  const mergedMs = ms(input.mergedAt);
  const closedMs = ms(input.closedAt);
  let terminal: LifecycleTerminal;
  let endMs: number;
  if (mergedMs !== null) {
    terminal = "merged";
    endMs = mergedMs;
  } else if (closedMs !== null) {
    terminal = "closed";
    endMs = closedMs;
  } else {
    terminal = "ongoing";
    endMs = now;
  }
  // Guard against clock skew / out-of-order timestamps.
  endMs = Math.max(endMs, createdMs);

  // Collect phase-start boundaries from the timestamps the workspace already has.
  const boundaries: { kind: LifecyclePhaseKind; at: number }[] = [{ kind: "created", at: createdMs }];

  const setupStart = ms(input.setup?.startedAt);
  if (setupStart !== null) boundaries.push({ kind: "setup", at: setupStart });

  const sessions = input.sessions ?? [];
  let firstBuild: number | null = null;
  let firstLanding: number | null = null;
  for (const s of sessions) {
    const at = ms(s.startedAt);
    if (at === null) continue;
    if (classifySession(s.triggerType) === "landing") {
      if (firstLanding === null || at < firstLanding) firstLanding = at;
    } else {
      if (firstBuild === null || at < firstBuild) firstBuild = at;
    }
  }
  if (firstBuild !== null) boundaries.push({ kind: "building", at: firstBuild });
  if (firstLanding !== null) boundaries.push({ kind: "review", at: firstLanding });

  // Order by time, then by logical phase order for ties, and clamp monotonic into range.
  boundaries.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  let prev = createdMs;
  for (const b of boundaries) {
    b.at = Math.min(Math.max(b.at, prev), endMs);
    prev = b.at;
  }

  // Build contiguous segments: each boundary runs to the next boundary's start (or endMs).
  // Collapse duplicate kinds (keep earliest) and drop zero-width interior segments.
  const phases: LifecyclePhase[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].at;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].at : endMs;
    const durationMs = end - start;
    // Skip zero-width segments that are immediately superseded by the next phase,
    // but always keep the final segment so a just-created workspace still renders.
    if (durationMs <= 0 && i + 1 < boundaries.length) continue;
    if (phases.length > 0 && phases[phases.length - 1].kind === boundaries[i].kind) {
      // Extend the previous same-kind phase rather than emitting a duplicate.
      phases[phases.length - 1].endMs = end;
      phases[phases.length - 1].durationMs = end - phases[phases.length - 1].startMs;
      continue;
    }
    phases.push({ kind: boundaries[i].kind, startMs: start, endMs: end, durationMs, ongoing: false });
  }

  // Mark the last phase ongoing only when the workspace is still in flight.
  if (terminal === "ongoing" && phases.length > 0) {
    phases[phases.length - 1].ongoing = true;
  }

  return {
    startMs: createdMs,
    endMs,
    totalMs: Math.max(endMs - createdMs, 0),
    phases,
    terminal,
    repoMarkers: input.repoMarkers ?? [],
  };
}

/** Compact human duration for a phase segment ("12s", "3m 4s", "1h 20m"). */
export function formatPhaseDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const PHASE_LABELS: Record<LifecyclePhaseKind, string> = {
  created: "Created",
  setup: "Setup",
  building: "Building",
  review: "Review",
};
