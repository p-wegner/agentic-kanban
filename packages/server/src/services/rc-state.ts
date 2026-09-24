/**
 * The release-candidate lifecycle file, read from the server (#1238).
 *
 * MIRROR of the pure half of `scripts/rc-state.mjs` — a published `packages/server` cannot
 * import a repo-root script, and `pnpm promote` (the WRITER) runs without the server. The
 * server only ever READS the file (the delivery view, the cadence scheduler's abandon decision,
 * the Sentinel's one line); `rc-state.test.ts` holds both copies to one behaviour on one
 * fixture. Change both or that test goes red.
 *
 * The file lives beside `promote.log`: `<stable checkout>/.kanban/rc-state.json`, where the
 * stable checkout is `KANBAN_STABLE_CHECKOUT` or the sibling `../agentic-kanban-stable` of the
 * project's main checkout — the same resolution `scripts/promote-plan.mjs` makes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RcCandidateSummary, RcState } from "@agentic-kanban/shared/types";

export type { RcCandidateSummary, RcState };

export const RC_STATE_RELPATH = join(".kanban", "rc-state.json");
export const RC_BRANCH_PREFIX = "rc/";
export const RC_STATES: readonly RcState[] = ["cut", "sweeping", "red", "healing", "green", "promoted", "abandoned"];
export const TERMINAL_RC_STATES: readonly RcState[] = ["promoted", "abandoned"];
export const DEFAULT_RC_CADENCE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STABLE_CHECKOUT_DIRNAME = "agentic-kanban-stable";

export interface RcCandidate {
  branch: string;
  sha: string | null;
  state: RcState;
  cutAt: string | null;
  updatedAt: string | null;
  tag: string | null;
  failedSuites: string[];
  note: string | null;
}

export interface RcStateFile {
  version: 1;
  candidates: RcCandidate[];
}

export interface RcCandidatePlan {
  action: "reuse" | "cut";
  branch: string;
  abandon: string | null;
  reason: string;
}

export function isTerminalRcState(state: string | null | undefined): boolean {
  return (TERMINAL_RC_STATES as readonly string[]).includes(String(state));
}

export function parseRcBranch(branch: string | null | undefined): { branch: string; date: string; ordinal: number } | null {
  const m = /^rc\/(\d{8})(?:-(\d+))?$/.exec(String(branch ?? "").trim());
  if (!m) return null;
  return { branch: String(branch).trim(), date: m[1]!, ordinal: m[2] ? Number(m[2]) : 1 };
}

export function nextRcBranch(dateStamp: string, existingBranches: readonly string[] = []): string {
  const taken = new Set(existingBranches.map((b) => String(b).trim()));
  const base = `${RC_BRANCH_PREFIX}${dateStamp}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`no free rc branch for ${dateStamp} after 999 attempts`);
}

export function sortRcBranches(branches: readonly string[] = []): string[] {
  return branches
    .map(parseRcBranch)
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => (a.date === b.date ? b.ordinal - a.ordinal : b.date.localeCompare(a.date)))
    .map((r) => r.branch);
}

export function emptyRcState(): RcStateFile {
  return { version: 1, candidates: [] };
}

export function parseRcState(text: string | null | undefined): RcStateFile {
  if (!text || !String(text).trim()) return emptyRcState();
  try {
    const parsed = JSON.parse(String(text)) as { candidates?: unknown };
    const candidates = Array.isArray(parsed?.candidates) ? (parsed.candidates as Record<string, unknown>[]) : [];
    return {
      version: 1,
      candidates: candidates
        .filter((c) => c && typeof c.branch === "string" && parseRcBranch(c.branch))
        .map((c) => ({
          branch: c.branch as string,
          sha: typeof c.sha === "string" ? c.sha : null,
          state: (RC_STATES as readonly string[]).includes(String(c.state)) ? (c.state as RcState) : "cut",
          cutAt: typeof c.cutAt === "string" ? c.cutAt : null,
          updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : null,
          tag: typeof c.tag === "string" ? c.tag : null,
          failedSuites: Array.isArray(c.failedSuites) ? (c.failedSuites as unknown[]).filter((s): s is string => typeof s === "string") : [],
          note: typeof c.note === "string" ? c.note : null,
        })),
    };
  } catch {
    return emptyRcState();
  }
}

export function findRcCandidate(state: RcStateFile, branch: string): RcCandidate | null {
  return state.candidates.find((c) => c.branch === branch) ?? null;
}

export function currentRcCandidate(state: RcStateFile): RcCandidate | null {
  const byBranch = new Map(state.candidates.map((c) => [c.branch, c] as const));
  const newest = sortRcBranches([...byBranch.keys()])[0];
  return newest ? byBranch.get(newest) ?? null : null;
}

export function planRcCandidate({
  dateStamp,
  state,
  existingBranches = [],
  nowMs = Date.now(),
  cadenceMs = DEFAULT_RC_CADENCE_MS,
}: {
  dateStamp: string;
  state: RcStateFile;
  existingBranches?: readonly string[];
  nowMs?: number;
  cadenceMs?: number;
}): RcCandidatePlan {
  const inFlight = state.candidates
    .filter((c) => !isTerminalRcState(c.state) && existingBranches.includes(c.branch))
    .map((c) => c.branch);
  const newestInFlight = sortRcBranches(inFlight)[0] ?? null;
  const candidate = newestInFlight ? findRcCandidate(state, newestInFlight) : null;

  if (candidate) {
    const sinceMs = candidate.updatedAt ? Date.parse(candidate.updatedAt) : Number.NaN;
    const ageMs = Number.isFinite(sinceMs) ? nowMs - sinceMs : Number.NaN;
    const stuckRed = candidate.state === "red" && Number.isFinite(ageMs) && ageMs > cadenceMs;
    if (!stuckRed) {
      return {
        action: "reuse",
        branch: candidate.branch,
        abandon: null,
        reason: `${candidate.branch} is still in flight (${candidate.state}${candidate.state === "red" ? `, red for ${(ageMs / 3600_000).toFixed(1)}h of a ${(cadenceMs / 3600_000).toFixed(0)}h cadence` : ""}) — reusing it rather than cutting past a sweep or a heal that is under way`,
      };
    }
    return {
      action: "cut",
      branch: nextRcBranch(dateStamp, existingBranches),
      abandon: candidate.branch,
      reason: `${candidate.branch} has been red for ${(ageMs / 3600_000).toFixed(1)}h, longer than one cadence (${(cadenceMs / 3600_000).toFixed(0)}h) — abandoning it and cutting a fresh candidate from master's tip`,
    };
  }
  return {
    action: "cut",
    branch: nextRcBranch(dateStamp, existingBranches),
    abandon: null,
    reason: "no release candidate is in flight — cutting one from master's tip",
  };
}

/** The stable checkout a project's main checkout promotes into — the same rule `promote-plan.mjs` uses. */
export function resolveStableCheckoutFor(repoPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.KANBAN_STABLE_CHECKOUT) return resolve(env.KANBAN_STABLE_CHECKOUT);
  return resolve(repoPath, "..", DEFAULT_STABLE_CHECKOUT_DIRNAME);
}

/** Read the lifecycle file under a stable checkout; absent or unreadable reads as empty. */
export function readRcState(stableCheckout: string): RcStateFile {
  const path = join(stableCheckout, RC_STATE_RELPATH);
  if (!existsSync(path)) return emptyRcState();
  try {
    return parseRcState(readFileSync(path, "utf8"));
  } catch {
    return emptyRcState();
  }
}

/** The wire shape the delivery view and the tracker carry. */
export function toRcCandidateSummary(candidate: RcCandidate | null): RcCandidateSummary | null {
  if (!candidate) return null;
  return {
    branch: candidate.branch,
    sha: candidate.sha,
    state: candidate.state,
    updatedAt: candidate.updatedAt,
    tag: candidate.tag,
    failedSuites: candidate.failedSuites,
  };
}
