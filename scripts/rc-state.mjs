/**
 * The release-candidate lifecycle file (#1238, decision 019 parts 1 and 4).
 *
 * `pnpm promote` no longer gates master: it cuts `rc/<YYYYMMDD>[-N]` from master's tip, sweeps
 * THAT, and promotes the rc sha. Master keeps merging throughout. What state each candidate is
 * in lives in ONE JSON file under the stable checkout, `<stable>/.kanban/rc-state.json`, so the
 * Sentinel and the delivery view can read it without the repo, the way `promote.log` and
 * `promote-recovery.json` already are.
 *
 * States, in the order a candidate normally passes through them:
 *
 *   cut       the branch exists, nothing has measured it yet
 *   sweeping  a base-branch probe was requested for it and has not landed
 *   red       the sweep failed; `failedSuites` names what; a heal ticket fixes it ON the rc (#1239)
 *   healing   a heal workspace is open against it (#1239 writes this)
 *   green     the sweep passed; the promotion is under way
 *   promoted  tagged `stable-*` and deployed — terminal
 *   abandoned red for longer than one cadence; the next cut starts fresh — terminal
 *
 * This module is the ONE reader/writer of that file. The pure half (parse, plan, terminal
 * predicate, branch naming) is MIRRORED in `packages/server/src/services/rc-state.ts` — a
 * published `packages/server` cannot import a repo-root script and `pnpm promote` runs without
 * the server — and `rc-state.test.ts` holds the two copies to one behaviour on one fixture.
 * Change both or that test goes red.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the lifecycle file lives, relative to the STABLE checkout (beside `promote.log`). */
export const RC_STATE_RELPATH = join(".kanban", "rc-state.json");

/** Every rc branch is `rc/<YYYYMMDD>[-N]`; the prefix is what the default health readers exclude. */
export const RC_BRANCH_PREFIX = "rc/";

export const RC_STATES = Object.freeze(["cut", "sweeping", "red", "healing", "green", "promoted", "abandoned"]);

/** States a candidate never leaves. A new candidate is cut only past one of these. */
export const TERMINAL_RC_STATES = Object.freeze(["promoted", "abandoned"]);

/**
 * How long a candidate may sit RED before the next run abandons it and cuts afresh — one
 * cadence, and the cadence is daily by default (`promote_cadence_<id>`, decision 019 part 4).
 * A hand-run `pnpm promote` uses the same figure: a red rc older than this is not "being
 * healed", it is stuck, and the fix is a fresh candidate carrying the open heal ticket forward.
 */
export const DEFAULT_RC_CADENCE_MS = 24 * 60 * 60 * 1000;

export function isTerminalRcState(state) {
  return TERMINAL_RC_STATES.includes(String(state));
}

/** `{ branch, date, ordinal }` for an `rc/YYYYMMDD[-N]` branch, or null when it is not one. */
export function parseRcBranch(branch) {
  const m = /^rc\/(\d{8})(?:-(\d+))?$/.exec(String(branch ?? "").trim());
  if (!m) return null;
  return { branch: String(branch).trim(), date: m[1], ordinal: m[2] ? Number(m[2]) : 1 };
}

/**
 * The rc name for `dateStamp` that no existing branch already uses: `rc/YYYYMMDD`, then `-2`,
 * `-3`, ... The same shape as `nextStableTag`, because the same rule applies — a name once
 * used points at a candidate a post-mortem may want, so it is never reused for another sha.
 */
export function nextRcBranch(dateStamp, existingBranches = []) {
  const taken = new Set(existingBranches.map((b) => String(b).trim()));
  const base = `${RC_BRANCH_PREFIX}${dateStamp}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`no free rc branch for ${dateStamp} after 999 attempts`);
}

/** Newest-first over rc branch names: by date, then by same-day ordinal. */
export function sortRcBranches(branches = []) {
  return branches
    .map(parseRcBranch)
    .filter(Boolean)
    .sort((a, b) => (a.date === b.date ? b.ordinal - a.ordinal : b.date.localeCompare(a.date)))
    .map((r) => r.branch);
}

/** An empty lifecycle file. */
export function emptyRcState() {
  return { version: 1, candidates: [] };
}

/**
 * Parse the file's text, tolerant of an absent, empty or half-written file — every one of those
 * reads as "no candidates", never as an exception, because a promotion must not refuse over
 * bookkeeping it can rebuild from the branch list.
 */
export function parseRcState(text) {
  if (!text || !String(text).trim()) return emptyRcState();
  try {
    const parsed = JSON.parse(String(text));
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    return {
      version: 1,
      candidates: candidates
        .filter((c) => c && typeof c.branch === "string" && parseRcBranch(c.branch))
        .map((c) => ({
          branch: c.branch,
          sha: typeof c.sha === "string" ? c.sha : null,
          state: RC_STATES.includes(c.state) ? c.state : "cut",
          cutAt: typeof c.cutAt === "string" ? c.cutAt : null,
          updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : null,
          tag: typeof c.tag === "string" ? c.tag : null,
          failedSuites: Array.isArray(c.failedSuites) ? c.failedSuites.filter((s) => typeof s === "string") : [],
          note: typeof c.note === "string" ? c.note : null,
        })),
    };
  } catch {
    return emptyRcState();
  }
}

export function serializeRcState(state) {
  return `${JSON.stringify({ version: 1, candidates: state.candidates }, null, 2)}\n`;
}

export function findRcCandidate(state, branch) {
  return state.candidates.find((c) => c.branch === branch) ?? null;
}

/** The candidate most recently touched — what the Sentinel's one line and the delivery view show. */
export function currentRcCandidate(state) {
  const byBranch = new Map(state.candidates.map((c) => [c.branch, c]));
  const newest = sortRcBranches([...byBranch.keys()])[0];
  return newest ? byBranch.get(newest) : null;
}

/**
 * Move one candidate to `nextState`, creating it when it is new. Returns a NEW state object;
 * the input is not mutated, so a dry run can plan a transition it never writes.
 */
export function upsertRcCandidate(state, branch, patch, atIso = new Date().toISOString()) {
  const existing = findRcCandidate(state, branch);
  const next = {
    branch,
    sha: existing?.sha ?? null,
    state: existing?.state ?? "cut",
    cutAt: existing?.cutAt ?? atIso,
    updatedAt: atIso,
    tag: existing?.tag ?? null,
    failedSuites: existing?.failedSuites ?? [],
    note: existing?.note ?? null,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  };
  if (!RC_STATES.includes(next.state)) throw new Error(`unknown rc state '${next.state}' for ${branch}`);
  return {
    version: 1,
    candidates: [...state.candidates.filter((c) => c.branch !== branch), next],
  };
}

/**
 * Which rc this run works on (#1238 item 1). Pure; the driver lists branches and reads the file.
 *
 *  - `reuse`: today's newest rc is still in flight (`cut`/`sweeping`/`red`/`healing`/`green`)
 *    and, if red, not yet older than one cadence. Re-cutting it would throw away a sweep that
 *    is running or a heal that is under way.
 *  - `cut`: no in-flight candidate. A NEW name is minted past every existing rc branch for the
 *    day (a terminal one keeps its name). `abandon` names an in-flight rc this run retires
 *    first: a red candidate older than `cadenceMs` — it is stuck, not healing, and decision 019
 *    says the next cadence cuts afresh and carries the heal ticket forward.
 *
 * An rc from an EARLIER day that is still in flight is reused too: a candidate is a candidate
 * until it is promoted or abandoned, and the date in its name is when it was cut, not a TTL.
 */
export function planRcCandidate({ dateStamp, state, existingBranches = [], nowMs = Date.now(), cadenceMs = DEFAULT_RC_CADENCE_MS } = {}) {
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

// --- file I/O (mjs only; the server mirror reads through its own fs import) --------------------

export function rcStatePath(stableCheckout) {
  return join(stableCheckout, RC_STATE_RELPATH);
}

export function readRcState(stableCheckout) {
  const path = rcStatePath(stableCheckout);
  if (!existsSync(path)) return emptyRcState();
  return parseRcState(readFileSync(path, "utf8"));
}

export function writeRcState(stableCheckout, state) {
  const path = rcStatePath(stableCheckout);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeRcState(state), "utf8");
  return path;
}

/** One line for the promote log / dry run / Sentinel. */
export function formatRcCandidate(candidate) {
  if (!candidate) return "no release candidate recorded";
  const tag = candidate.tag ? ` tag ${candidate.tag}` : "";
  const suites = candidate.failedSuites?.length ? ` failing: ${candidate.failedSuites.slice(0, 5).join(", ")}${candidate.failedSuites.length > 5 ? ", …" : ""}` : "";
  return `${candidate.branch} @ ${candidate.sha ? candidate.sha.slice(0, 10) : "<no sha>"} is ${candidate.state}${tag} (updated ${candidate.updatedAt ?? "<unknown>"})${suites}`;
}
