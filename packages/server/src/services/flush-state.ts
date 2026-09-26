/**
 * The queue flush's append-only record (#1246, decision 020 part 2), read from the server.
 *
 * Chosen shape: a JSON row under `<stable checkout>/.kanban/flush-state.json`, beside
 * `rc-state.json` — NOT a `merge_flushes` DB table. Reasons: a flush is observability for
 * exactly the two-board setup decision 019 already put beside `rc-state.json` (same stable
 * checkout, same "server only ever READS, `pnpm promote`/a CLI writer owns the file" split
 * `rc-state.ts`'s header documents); a project with no stable checkout simply has no flush
 * file, matching how it already has no rc state; and it avoids a migration for a feature whose
 * write path (#1247/#1248, not this ticket) is not yet built — a DB table would need its
 * write-time invariants decided before those tickets land, whereas a JSON file's writer can be
 * added incrementally exactly like `scripts/rc-state.mjs` was.
 *
 * Same split as `rc-state.ts`: this module is the pure parse/read half; a future writer
 * (#1247/#1248) mirrors it in a `scripts/*.mjs` the same way `pnpm promote` mirrors rc-state,
 * since a published `packages/server` cannot import a repo-root script.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlushRecord, FlushState } from "@agentic-kanban/shared/types";

export type { FlushRecord, FlushState };

export const FLUSH_STATE_RELPATH = join(".kanban", "flush-state.json");

export const FLUSH_STATES: readonly FlushState[] = ["flushed", "sweeping", "red", "healing", "healed", "merged-back", "abandoned"];

export const TERMINAL_FLUSH_STATES: readonly FlushState[] = ["merged-back", "abandoned"];

export interface FlushStateFile {
  version: 1;
  flushes: FlushRecord[];
}

export function isTerminalFlushState(state: string | null | undefined): boolean {
  return (TERMINAL_FLUSH_STATES as readonly string[]).includes(String(state));
}

export function emptyFlushState(): FlushStateFile {
  return { version: 1, flushes: [] };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

export function parseFlushState(text: string | null | undefined): FlushStateFile {
  if (!text || !String(text).trim()) return emptyFlushState();
  try {
    const parsed = JSON.parse(String(text)) as { flushes?: unknown };
    const rows = Array.isArray(parsed?.flushes) ? (parsed.flushes as Record<string, unknown>[]) : [];
    return {
      version: 1,
      flushes: rows
        .filter((r) => r && typeof r.id === "string" && typeof r.at === "string")
        .map((r) => ({
          id: r.id as string,
          at: r.at as string,
          triggeredBy: r.triggeredBy === "manual" || r.triggeredBy === "cli" ? r.triggeredBy : "auto",
          memberIssueNumbers: asNumberArray(r.memberIssueNumbers),
          memberBranches: asStringArray(r.memberBranches),
          landingSha: typeof r.landingSha === "string" ? r.landingSha : null,
          tag: typeof r.tag === "string" ? r.tag : "",
          sweepTarget: typeof r.sweepTarget === "string" ? r.sweepTarget : "master",
          state: (FLUSH_STATES as readonly string[]).includes(String(r.state)) ? (r.state as FlushState) : "flushed",
          openHealTickets: asNumberArray(r.openHealTickets),
          updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : (r.at as string),
        })),
    };
  } catch {
    return emptyFlushState();
  }
}

/** Read the lifecycle file under a stable checkout; absent or unreadable reads as empty. Never throws. */
export function readFlushState(stableCheckout: string): FlushStateFile {
  const path = join(stableCheckout, FLUSH_STATE_RELPATH);
  if (!existsSync(path)) return emptyFlushState();
  try {
    return parseFlushState(readFileSync(path, "utf8"));
  } catch {
    return emptyFlushState();
  }
}

/** Newest-first, by `at`. */
export function sortFlushes(flushes: readonly FlushRecord[]): FlushRecord[] {
  return [...flushes].sort((a, b) => b.at.localeCompare(a.at));
}

export function latestFlush(state: FlushStateFile): FlushRecord | null {
  return sortFlushes(state.flushes)[0] ?? null;
}

/**
 * Legal transitions of the heal state machine (decision 020 part 4):
 * `flushed -> sweeping -> {red, healed}`, `red -> healing -> healed`, `healed -> merged-back`,
 * and any non-terminal state may go `abandoned`. `merged-back` is the terminal "back on
 * master" state; when the heal target IS master, `healed -> merged-back` is a no-op
 * transition taken immediately (decision 020 part 4's "collapse into one transition" rule) —
 * modelled here as a transition that is always legal, never skipped, so the record still
 * shows the step even though nothing else changes.
 */
const LEGAL_TRANSITIONS: Record<FlushState, readonly FlushState[]> = {
  flushed: ["sweeping", "abandoned"],
  sweeping: ["red", "healed", "abandoned"],
  red: ["healing", "abandoned"],
  healing: ["healed", "abandoned"],
  healed: ["merged-back"],
  "merged-back": [],
  abandoned: [],
};

export interface FlushTransitionResult {
  ok: boolean;
  /** Reason the transition was refused; absent when `ok` is true. */
  reason?: string;
}

/** Pure: is `from -> to` a legal step of the heal state machine? */
export function canTransitionFlushState(from: FlushState, to: FlushState): FlushTransitionResult {
  if (from === to) return { ok: false, reason: `already ${from}` };
  const allowed = LEGAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `${from} -> ${to} is not a legal transition (from ${from}: ${allowed.join(", ") || "none — terminal"})` };
  }
  return { ok: true };
}

/**
 * Pure: apply a legal transition to a flush record, stamping `updatedAt`. Refuses (returns the
 * unchanged record) on an illegal transition — the caller decides whether that is worth
 * surfacing; this function never throws.
 *
 * The master-target no-op (decision 020 part 4): when `sweepTarget` is `"master"`, a
 * `healed` record transitions straight to `merged-back` in the SAME call as the `healed`
 * transition — there is no separate merge-back step to wait for, since the healed state is
 * already on the heal target and the heal target IS master.
 */
export function applyFlushTransition(
  record: FlushRecord,
  to: FlushState,
  opts: { now?: string } = {},
): { record: FlushRecord; result: FlushTransitionResult } {
  const result = canTransitionFlushState(record.state, to);
  if (!result.ok) return { record, result };
  const now = opts.now ?? new Date().toISOString();
  let next: FlushRecord = { ...record, state: to, updatedAt: now };
  if (to === "healed" && next.sweepTarget === "master") {
    next = { ...next, state: "merged-back", updatedAt: now };
  }
  return { record: next, result: { ok: true } };
}
