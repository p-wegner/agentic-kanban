/**
 * Per-phase progress for a project registration in flight (#388).
 *
 * Registering a project shows a 30-40s spinner with nothing to read: the user cannot tell whether
 * it is cloning, detecting the stack, scaffolding hooks, seeding skills or hung. On this machine —
 * where a zero-work `git --version` has measured anywhere from 68ms to 51.8s (#368) — "is it
 * working or wedged?" is not an idle question, and the answer was simply unavailable.
 *
 * Registration already does several distinguishable, nameable steps. This records which one is
 * running so the client can render them.
 *
 * ── Why polling and not SSE ──
 *
 * The registration POST is what blocks, so the progress has to travel on a SECOND connection
 * whatever the transport. The client mints the id, sends it with the POST and polls a plain GET
 * while the POST is in flight — no streaming plumbing, no change to the endpoint's contract, and
 * a client that never polls costs nothing.
 *
 * ── Deliberately in-memory ──
 *
 * This is transient UI state about a request that is either finishing or already lost. Persisting
 * it would add a table, a migration and a cleanup story to something whose whole lifetime is one
 * request. Entries expire; a restart simply loses the progress of a registration that a restart
 * has already killed.
 *
 * NO TIMING TARGET is attached to any of this, per the reporting rule the ticket carries: timing
 * on that box is unusable and any before/after duration comparison would be noise (#368). The
 * point is that a slow phase is VISIBLY slow rather than indistinguishable from a hang.
 */

/** The nameable steps of a registration, in the order they run. */
export const REGISTRATION_PHASES = [
  "clone",
  "inspect-repo",
  "create-project",
  "scaffold",
  "stack-profile",
  "seed-skills",
  "finalize",
] as const;
export type RegistrationPhase = (typeof REGISTRATION_PHASES)[number];

/** Human labels — the server owns them so the client cannot drift from what actually runs. */
export const REGISTRATION_PHASE_LABELS: Record<RegistrationPhase, string> = {
  "clone": "Cloning the repository",
  "inspect-repo": "Inspecting the repository",
  "create-project": "Creating the project",
  "scaffold": "Scaffolding agent guards and config",
  "stack-profile": "Detecting the stack and setup command",
  "seed-skills": "Seeding agent skills",
  "finalize": "Finishing up",
};

export interface RegistrationPhaseState {
  phase: RegistrationPhase;
  label: string;
  status: "running" | "done" | "skipped" | "failed";
  startedAt: string;
  endedAt?: string;
  /** Why a phase was skipped or failed — the part a bare spinner could never show. */
  note?: string;
}

export interface RegistrationProgress {
  id: string;
  startedAt: string;
  phases: RegistrationPhaseState[];
  done: boolean;
  error?: string;
}

/** How long a finished entry is kept so a slightly-late poll still sees the final state. */
const RETENTION_MS = 60_000;
/** Hard ceiling for an entry whose registration never reported completion (crash, restart). */
const MAX_AGE_MS = 15 * 60_000;

const entries = new Map<string, RegistrationProgress & { finishedAt?: number }>();

function sweep(nowMs: number): void {
  for (const [id, entry] of entries) {
    const age = nowMs - Date.parse(entry.startedAt);
    if (entry.finishedAt && nowMs - entry.finishedAt > RETENTION_MS) entries.delete(id);
    else if (Number.isFinite(age) && age > MAX_AGE_MS) entries.delete(id);
  }
}

export function startRegistrationProgress(id: string | undefined, now = new Date()): string | null {
  if (!id) return null;
  sweep(now.getTime());
  entries.set(id, { id, startedAt: now.toISOString(), phases: [], done: false });
  return id;
}

/** Mark a phase running; the previous running phase is closed as done. */
export function beginRegistrationPhase(id: string | null | undefined, phase: RegistrationPhase, now = new Date()): void {
  if (!id) return;
  const entry = entries.get(id);
  if (!entry) return;
  for (const state of entry.phases) {
    if (state.status === "running") {
      state.status = "done";
      state.endedAt = now.toISOString();
    }
  }
  entry.phases.push({
    phase,
    label: REGISTRATION_PHASE_LABELS[phase],
    status: "running",
    startedAt: now.toISOString(),
  });
}

/** Close the current phase with an explicit outcome (e.g. "skipped — no clone needed"). */
export function endRegistrationPhase(
  id: string | null | undefined,
  status: "done" | "skipped" | "failed",
  note?: string,
  now = new Date(),
): void {
  if (!id) return;
  const entry = entries.get(id);
  const current = entry?.phases.filter((p) => p.status === "running").pop();
  if (!current) return;
  current.status = status;
  current.endedAt = now.toISOString();
  if (note) current.note = note;
}

export function finishRegistrationProgress(id: string | null | undefined, error?: string, now = new Date()): void {
  if (!id) return;
  const entry = entries.get(id);
  if (!entry) return;
  for (const state of entry.phases) {
    if (state.status === "running") {
      // A registration that failed mid-phase must not leave that phase reading "running"
      // forever — that is the hang the ticket is about, one level down.
      state.status = error ? "failed" : "done";
      state.endedAt = now.toISOString();
    }
  }
  entry.done = true;
  entry.error = error;
  entry.finishedAt = now.getTime();
}

export function getRegistrationProgress(id: string): RegistrationProgress | null {
  const entry = entries.get(id);
  if (!entry) return null;
  const { finishedAt: _finishedAt, ...rest } = entry;
  return rest;
}

/** Test seam — the module-level map is process-wide by design. */
export function clearRegistrationProgress(): void {
  entries.clear();
}
