import { TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared/lib/status-view";
import type { Database } from "../db/index.js";
import {
  countAllIssueComments,
  countRetentionEligible,
  listRetentionDeletableGroups,
  deleteRetentionDeletable,
  type CommentRetentionScope,
  type RetentionDeletableGroup,
} from "../repositories/issue-comment-retention.repository.js";

/**
 * Retention POLICY for machine-generated issue comments (#738). The queries live in
 * `repositories/issue-comment-retention.repository.ts` — a service must not run raw
 * persistence (`services-bypass-repositories`), and the ranking CTE this policy describes is
 * exactly the kind of query that rule exists to keep behind a seam.
 *
 * The live board holds 99,797 comments — 133 MB of table in a 191 MB database — and almost
 * all of it is a machine reporting the same merge-attempt state on issues that closed weeks
 * ago. Those rows have no value once the issue is done. Human comments do, forever.
 *
 * PROVENANCE IS THE WHOLE PROBLEM, so the policy is an intersection of two explicit
 * allowlists, and everything outside it is KEPT:
 *
 *   - `author` must be in {@link SWEEPABLE_AUTHORS}. The column is plain text with no
 *     constraint, so an unknown value is possible — and an unknown author is not provably a
 *     machine. `user` is obviously excluded; so are `agent` and `butler`, whose comments are
 *     written content (182 + 165 rows on the live board, nearly all distinct bodies), not
 *     repeated state reports.
 *   - `kind` must be in {@link SWEEPABLE_KINDS}. Author alone is not enough: `system` also
 *     writes `note`s, which are one-off observations someone will want to read.
 *
 * Both lists are deliberately narrow. Widening one is a decision to make in daylight; a
 * default that sweeps "anything that looks machine-generated" is how a human comment
 * eventually disappears.
 *
 * The other three fail-closed edges:
 *   - The issue must be in a TERMINAL status (Done/Cancelled) by name. The join is INNER, so
 *     an issue with no status row, or a status this board does not recognise, keeps its
 *     comments.
 *   - The comment must be older than the cutoff. A row whose `created_at` does not compare
 *     older is kept, including a malformed one.
 *   - The newest {@link DEFAULT_KEEP_PER_THREAD} comment(s) of each (issue, kind, workspace)
 *     thread are always kept, so retention never empties a thread — the last known state of a
 *     merge attempt stays readable forever.
 */
export const SWEEPABLE_AUTHORS = ["system", "preflight"] as const;
export const SWEEPABLE_KINDS = ["merge-attempt", "preflight-verdict"] as const;

export const DEFAULT_RETAIN_DAYS = 30;
export const DEFAULT_KEEP_PER_THREAD = 1;

export interface CommentRetentionOptions {
  /** Comments younger than this many days are never swept. */
  retainDays?: number;
  /** Newest N comments per (issue, kind, workspace) thread are never swept. */
  keepPerThread?: number;
  /**
   * ISO timestamp the cutoff is computed from. The persisted-value spelling (`now?: string`)
   * because it is compared against a stored `created_at` column, not used for arithmetic.
   */
  now?: string;
}

export type CommentRetentionBreakdown = RetentionDeletableGroup;

export interface CommentRetentionPlan {
  /** Comments created strictly before this ISO timestamp are eligible. */
  cutoff: string;
  retainDays: number;
  keepPerThread: number;
  /** Total rows in the table right now — context for the numbers below. */
  totalRows: number;
  /** Rows matching author + kind + terminal status + age, BEFORE the keep-per-thread floor. */
  eligibleRows: number;
  /** Eligible rows the floor protects (the newest per thread). */
  protectedByThreadFloor: number;
  /** What a run would actually delete. */
  deletableRows: number;
  /** Sum of body+payload lengths of the deletable rows — recoverable text, not page-level bytes. */
  deletableBytes: number;
  breakdown: CommentRetentionBreakdown[];
}

function resolveScope(opts: CommentRetentionOptions): CommentRetentionScope & { retainDays: number } {
  const retainDays = opts.retainDays ?? DEFAULT_RETAIN_DAYS;
  const keepPerThread = opts.keepPerThread ?? DEFAULT_KEEP_PER_THREAD;
  if (!Number.isFinite(retainDays) || retainDays < 0) throw new Error("retainDays must be a non-negative number");
  if (!Number.isFinite(keepPerThread) || keepPerThread < 1) {
    // Refusing 0 is deliberate: a thread retention can empty entirely leaves a reader unable
    // to tell "nothing ever happened here" from "the record was swept".
    throw new Error("keepPerThread must be at least 1");
  }
  const nowMs = Date.parse(opts.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new Error(`unparseable now: ${opts.now}`);
  return {
    authors: SWEEPABLE_AUTHORS,
    kinds: SWEEPABLE_KINDS,
    terminalStatusNames: TERMINAL_STATUS_NAMES,
    cutoff: new Date(nowMs - retainDays * 86_400_000).toISOString(),
    keepPerThread,
    retainDays,
  };
}

/** What a retention run WOULD do. Reads only. */
export async function planCommentRetention(
  opts: CommentRetentionOptions,
  database: Database,
): Promise<CommentRetentionPlan> {
  const scope = resolveScope(opts);
  const totalRows = await countAllIssueComments(database);
  const eligibleRows = await countRetentionEligible(scope, database);
  const breakdown = await listRetentionDeletableGroups(scope, database);
  const deletableRows = breakdown.reduce((sum, r) => sum + r.rows, 0);

  return {
    cutoff: scope.cutoff,
    retainDays: scope.retainDays,
    keepPerThread: scope.keepPerThread,
    totalRows,
    eligibleRows,
    protectedByThreadFloor: eligibleRows - deletableRows,
    deletableRows,
    deletableBytes: breakdown.reduce((sum, r) => sum + r.bytes, 0),
    breakdown,
  };
}

export interface CommentRetentionResult {
  plan: CommentRetentionPlan;
  /** Rows actually deleted. 0 on a dry run. */
  deleted: number;
  dryRun: boolean;
}

/**
 * Run retention. DRY BY DEFAULT — `dryRun: false` has to be asked for explicitly, because
 * the rows this deletes are board history and there is no undo short of a backup.
 */
export async function runCommentRetention(
  opts: CommentRetentionOptions & { dryRun?: boolean },
  database: Database,
): Promise<CommentRetentionResult> {
  const dryRun = opts.dryRun !== false;
  const plan = await planCommentRetention(opts, database);
  if (dryRun || plan.deletableRows === 0) return { plan, deleted: 0, dryRun };

  await deleteRetentionDeletable(resolveScope(opts), database);
  return { plan, deleted: plan.deletableRows, dryRun };
}

/** Human-readable one-screen summary of a plan — used by the CLI, and worth having in logs. */
export function formatCommentRetentionPlan(plan: CommentRetentionPlan): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const mib = (v: number) => `${(v / 1_048_576).toFixed(1)} MiB`;
  const lines = [
    `issue_comments retention (#738)`,
    `  cutoff:            ${plan.cutoff} (retainDays=${plan.retainDays}, keepPerThread=${plan.keepPerThread})`,
    `  sweepable authors: ${SWEEPABLE_AUTHORS.join(", ")}`,
    `  sweepable kinds:   ${SWEEPABLE_KINDS.join(", ")}`,
    `  terminal statuses: ${TERMINAL_STATUS_NAMES.join(", ")}  (unknown/missing status => KEEP)`,
    `  total rows:        ${n(plan.totalRows)}`,
    `  eligible:          ${n(plan.eligibleRows)}`,
    `  kept by floor:     ${n(plan.protectedByThreadFloor)}`,
    `  WOULD DELETE:      ${n(plan.deletableRows)} rows, ${mib(plan.deletableBytes)} of body+payload text`,
  ];
  for (const r of plan.breakdown) {
    lines.push(`    - ${r.author}/${r.kind}: ${n(r.rows)} rows, ${mib(r.bytes)}`);
  }
  return lines.join("\n");
}

/**
 * CLI entry — driven by `scripts/comment-retention.mjs`. It lives beside the policy rather
 * than in the script file so the runnable thing and the rules it runs cannot drift apart.
 */
/** Program output on stdout (see the note at its first use), deliberately not a log line. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
export async function commentRetentionCli(argv: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  const retainDaysArg = flag("retain-days");
  const keepArg = flag("keep-per-thread");

  const { db } = await import("../db/index.js");
  const result = await runCommentRetention(
    {
      retainDays: retainDaysArg === undefined ? undefined : Number(retainDaysArg),
      keepPerThread: keepArg === undefined ? undefined : Number(keepArg),
      dryRun: !apply,
    },
    db,
  );
  // CLI output, not log lines: this is a report an operator asked for on stdout, so it goes
  // through process.stdout rather than console.* — which is also why the #616 tag convention
  // (greppable per-subsystem LOG lines) does not apply to it.
  out(formatCommentRetentionPlan(result.plan));
  if (result.dryRun) {
    out(`\nDRY RUN — nothing was deleted. Re-run with --apply to delete these ${result.plan.deletableRows.toLocaleString("en-US")} rows.`);
  } else {
    out(`\nAPPLIED — deleted ${result.deleted.toLocaleString("en-US")} rows.`);
    out(`SQLite does not hand freed pages back to the OS on DELETE — run 'pnpm db:repair' (which VACUUMs) to shrink the file.`);
  }
  return 0;
}

// Direct execution via tsx, e.g. `node scripts/comment-retention.mjs`.
if (process.argv[1] && process.argv[1].split("\\").join("/").endsWith("issue-comment-retention.service.ts")) {
  commentRetentionCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[retention] failed", err);
      process.exit(1);
    });
}
