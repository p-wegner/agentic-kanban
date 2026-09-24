/**
 * The miss-rate JOIN (#1234, #954 step 5) — sweep reds against the merges since the last green.
 *
 * WHY. The `impact` tier has been this board's gate since #983, and its miss rate still read
 * UNKNOWN: the outcome ledger (`.test-impact/outcomes.jsonl`, one row per gate run) knows what
 * each gate SELECTED and RAN, and the base sweep (`recordBaseSweepOutcome`) knows which suites
 * the full suite found red — but nobody joined the two. `impact.mjs stats` cannot: it computes a
 * miss only INSIDE one row (`failed − selected`), and a gate row can never contain a suite it did
 * not run. The miss the selection makes is visible only across rows: the sweep's red suite,
 * against every gate that landed between the last green sweep and this red one.
 *
 * WHAT A MISS IS HERE. For each suite a red sweep names: the merges landed since the previous
 * green sweep are the ledger rows whose `commit` is in `git log <lastGreenSha>..<redSha>`. A row
 * whose gate did NOT run that suite is a CANDIDATE — its change could have broken the suite and
 * its gate could not have seen it. One or more candidates ⇒ a `miss` row naming them all (the
 * join attributes, it does not bisect). Every intervening gate DID run the suite ⇒ nothing the
 * selection dropped could explain the red, so it is a `flake-or-environment` row, not a miss.
 * A green sweep after reds writes a `heal` row naming the suites that were open.
 *
 * "Ran the suite" is `selected ∪ seenFiles ∪ failed` — a `ran: full` row ran everything, and a
 * suite the row itself names as FAILED was certainly executed (which is also how a #1230
 * `guardFailure` row's guards count as run: they are in its `failed`).
 *
 * WHERE IT GOES. A separate sidecar, `.test-impact/misses.jsonl`, written directly by this module.
 * The outcomes ledger's shape belongs to `impact.mjs` (an external tool whose `record` takes no
 * free-form field), and a join row is a different kind of fact from a gate observation anyway —
 * it names a sweep and several gates. Keeping them apart also keeps `impact.mjs stats` reading a
 * ledger it understands.
 *
 * `staleMap: true` marks a miss whose candidate set includes a row the gate itself tagged as not a
 * valid observation of the selection (`-nochange`, `-partialselection`, `-unattributed` — the
 * gate logs `impact map is STALE` on the same runs). The rate (`test-impact-miss-rate.ts`)
 * excludes those and reports how many it excluded, so a stale map inflates a visible counter
 * rather than the headline number.
 *
 * Row shapes written:
 *   {kind:"miss",  sweepAt, sweepSha, suite, candidateCommits: [...], tier, staleMap?: true}
 *   {kind:"flake-or-environment", sweepAt, sweepSha, suite}
 *   {kind:"heal",  sweepAt, sweepSha, suites: [...]}
 *
 * Never throws: the join is an observation, never a reason to fail a health probe.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { OUTCOMES_RELATIVE_PATH } from "./test-impact-outcome.service.js";

/** The sidecar, relative to the repo root that owns the outcomes ledger. */
export const MISSES_RELATIVE_PATH = ".test-impact/misses.jsonl";

/** The `source` prefix a pre-merge gate row carries (`recordVerifyGateOutcome` passes `"ci"`). */
const GATE_SOURCE = "ci";

/** Source suffixes the gate uses to say "this row is not a valid observation of the selection". */
const SUSPECT_SUFFIXES = ["-nochange", "-partialselection", "-unattributed"];

/** One outcome-ledger row, as `impact.mjs`'s `writeOutcome` produces it (plus the #1230/#1234 patches). */
export interface LedgerRow {
  at?: string;
  commit?: string;
  source?: string;
  result?: string;
  changed?: string[];
  selected?: string[];
  failed?: string[];
  seenFiles?: string[];
  tier?: string;
  ran?: string;
  guardFailure?: boolean;
  durationMs?: number;
  steps?: Record<string, number>;
  [key: string]: unknown;
}

export interface MissRow {
  kind: "miss";
  sweepAt: string;
  sweepSha: string;
  suite: string;
  /** Short shas of the gate rows whose selection did not run `suite`. */
  candidateCommits: string[];
  /** The candidates' selection tier; `mixed` when they disagree, `null` when none says. */
  tier: string | null;
  staleMap?: true;
}

export interface FlakeRow {
  kind: "flake-or-environment";
  sweepAt: string;
  sweepSha: string;
  suite: string;
}

export interface HealRow {
  kind: "heal";
  sweepAt: string;
  sweepSha: string;
  suites: string[];
}

export type SweepJoinRow = MissRow | FlakeRow | HealRow;

/** One JSON object per line; an unparseable line is dropped, exactly as the skill's reader does. */
export function parseJsonlRows<T>(text: string | null | undefined): T[] {
  const rows: T[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as unknown;
      if (row && typeof row === "object") rows.push(row as T);
    } catch {
      /* a half-written last line is normal for an append-only log */
    }
  }
  return rows;
}

export function isGateRow(row: LedgerRow): boolean {
  const source = String(row.source ?? "");
  return source === GATE_SOURCE || source.startsWith(`${GATE_SOURCE}-`);
}

/** A gate row the producer itself tagged as not an observation of the selection. */
export function isSuspectGateRow(row: LedgerRow): boolean {
  const source = String(row.source ?? "");
  return SUSPECT_SUFFIXES.some((suffix) => source.includes(suffix));
}

/** Forward-slash, no leading `./` — the form `select` names test files in. */
function normalizedSuitePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Did this gate run execute `suite`? `full` ran everything; otherwise what it selected, saw, or failed. */
export function gateRanSuite(row: LedgerRow, suite: string): boolean {
  if (row.ran === "full") return true;
  const target = normalizedSuitePath(suite);
  const ran = [...(row.selected ?? []), ...(row.seenFiles ?? []), ...(row.failed ?? [])].map(normalizedSuitePath);
  return ran.includes(target);
}

/**
 * The ledger rows that landed in `lastGreen..red`. `commit` on a row is the SHORT sha of the
 * worktree HEAD at gate time (the branch tip); a merge commit's second parent is in the log, so a
 * prefix match places it. A squash-merged branch's tip is not in the log and is not attributed —
 * accepted, and why the number is reported as what it counts rather than as a truth.
 */
export function rowsInWindow(rows: LedgerRow[], commitsSinceGreen: readonly string[]): LedgerRow[] {
  const shas = commitsSinceGreen.map((sha) => sha.trim().toLowerCase()).filter(Boolean);
  return rows.filter((row) => {
    if (!isGateRow(row)) return false;
    const short = String(row.commit ?? "").trim().toLowerCase();
    if (!short) return false;
    return shas.some((sha) => sha.startsWith(short) || short.startsWith(sha));
  });
}

function tierOf(candidates: LedgerRow[]): string | null {
  const tiers = [...new Set(candidates.map((row) => row.tier).filter((tier): tier is string => typeof tier === "string" && tier.length > 0))];
  if (tiers.length === 0) return null;
  return tiers.length === 1 ? tiers[0]! : "mixed";
}

/** The suites a `miss`/`flake-or-environment` row has named since the last `heal` row — what a green sweep heals. */
export function openRedSuites(missRows: readonly SweepJoinRow[]): string[] {
  const open = new Set<string>();
  for (const row of missRows) {
    if (row.kind === "heal") open.clear();
    else open.add(row.suite);
  }
  return [...open].sort();
}

export interface SweepJoinInput {
  /** ISO — persisted onto every row, so the sanctioned spelling is `now?: string` at the I/O seam. */
  sweepAt: string;
  sweepSha: string;
  passed: boolean;
  /** Repo-relative suite paths the sweep found red (empty for a green sweep). */
  failedSuites: readonly string[];
  /** The outcomes ledger, parsed. */
  ledgerRows: readonly LedgerRow[];
  /** `git log --format=%H <lastGreenSha>..<sweepSha>`. */
  commitsSinceGreen: readonly string[];
  /** The sidecar so far — decides what a green sweep heals. */
  priorRows: readonly SweepJoinRow[];
}

/** Pure half of the join: the rows one sweep verdict adds to the sidecar. */
export function computeSweepJoinRows(input: SweepJoinInput): SweepJoinRow[] {
  const { sweepAt, sweepSha } = input;
  if (input.passed) {
    const suites = openRedSuites(input.priorRows);
    return suites.length > 0 ? [{ kind: "heal", sweepAt, sweepSha, suites }] : [];
  }
  const window = rowsInWindow([...input.ledgerRows], input.commitsSinceGreen);
  const out: SweepJoinRow[] = [];
  for (const suite of [...new Set(input.failedSuites.map(normalizedSuitePath))].sort()) {
    const candidates = window.filter((row) => !gateRanSuite(row, suite));
    if (candidates.length === 0) {
      out.push({ kind: "flake-or-environment", sweepAt, sweepSha, suite });
      continue;
    }
    const row: MissRow = {
      kind: "miss",
      sweepAt,
      sweepSha,
      suite,
      candidateCommits: [...new Set(candidates.map((c) => String(c.commit)))],
      tier: tierOf(candidates),
    };
    if (candidates.some(isSuspectGateRow)) row.staleMap = true;
    out.push(row);
  }
  return out;
}

/** `git log --format=%H <from>..<to>` through the adapter; `null` when git could not answer. */
export async function listCommitsBetween(repoPath: string, fromSha: string, toSha: string): Promise<string[] | null> {
  const result = await gitExec(["log", "--format=%H", `${fromSha}..${toSha}`], { cwd: repoPath, timeout: 60_000 });
  if (!execSucceeded(result)) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export interface RecordSweepJoinInput {
  projectId: string;
  /** The project's MAIN checkout — where both files live and where `git log` runs. */
  repoPath: string;
  /** Sha of the last GREEN sweep — the window's lower bound. */
  lastGreenSha: string;
  sweepSha: string;
  passed: boolean;
  failedSuites: readonly string[];
  /** ISO; persisted. Injected for tests. */
  now?: string;
  /** Injected for tests — defaults to {@link listCommitsBetween}. */
  listCommits?: (repoPath: string, fromSha: string, toSha: string) => Promise<string[] | null>;
  log?: (message: string) => void;
}

export interface RecordSweepJoinResult {
  written: SweepJoinRow[];
  reason?: string;
}

/** I/O half: read both files, run the join, append. Never throws. */
export async function recordSweepJoin(input: RecordSweepJoinInput): Promise<RecordSweepJoinResult> {
  const log = input.log ?? ((message: string) => console.warn(`[test-impact] ${message}`));
  try {
    const outcomesPath = resolve(input.repoPath, OUTCOMES_RELATIVE_PATH);
    const missesPath = resolve(input.repoPath, MISSES_RELATIVE_PATH);
    const ledgerRows = existsSync(outcomesPath) ? parseJsonlRows<LedgerRow>(readFileSync(outcomesPath, "utf8")) : [];
    const priorRows = existsSync(missesPath) ? parseJsonlRows<SweepJoinRow>(readFileSync(missesPath, "utf8")) : [];
    const commits = await (input.listCommits ?? listCommitsBetween)(input.repoPath, input.lastGreenSha, input.sweepSha);
    if (commits === null) {
      const reason = `git log ${input.lastGreenSha.slice(0, 8)}..${input.sweepSha.slice(0, 8)} failed in ${input.repoPath}`;
      log(`no miss-rate join recorded for project ${input.projectId}: ${reason}`);
      return { written: [], reason };
    }
    const rows = computeSweepJoinRows({
      sweepAt: input.now ?? new Date().toISOString(),
      sweepSha: input.sweepSha,
      passed: input.passed,
      failedSuites: input.failedSuites,
      ledgerRows,
      commitsSinceGreen: commits,
      priorRows,
    });
    if (rows.length === 0) return { written: [] };
    mkdirSync(dirname(missesPath), { recursive: true });
    appendFileSync(missesPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const misses = rows.filter((row) => row.kind === "miss").length;
    const flakes = rows.filter((row) => row.kind === "flake-or-environment").length;
    const heals = rows.filter((row) => row.kind === "heal").length;
    console.log(
      `[test-impact] miss-rate join for project ${input.projectId}: ${misses} miss, ${flakes} flake-or-environment, ` +
        `${heals} heal row(s) against ${commits.length} commit(s) since the last green sweep → ${MISSES_RELATIVE_PATH}`,
    );
    return { written: rows };
  } catch (err) {
    const reason = `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    log(`no miss-rate join recorded for project ${input.projectId}: ${reason}`);
    return { written: [], reason };
  }
}
