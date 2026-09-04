import {
  DEFAULT_HARNESS_SHARE_PCT,
  MAX_HARNESS_SHARE_PCT,
  harnessSlots,
} from "@agentic-kanban/shared/lib/harness-budget";
import { countActiveHarnessWip, selectHarnessIssueIds } from "../repositories/harness-tag.repository.js";
import type { db } from "../db/index.js";

/**
 * The HARNESS BUDGET gate for one auto-start cycle (#1021).
 *
 * A sibling module rather than more lines in `monitor-auto-start.ts`: that file sits within a
 * dozen lines of the 1000-line god-module ceiling `scripts/check-god-modules.mjs` enforces, and
 * this is a self-contained concern with its own snapshot — exactly the shape the file-contention
 * gate (`monitor-file-contention.ts`) and the hold recorders (`monitor-start-holds.ts`) already
 * took out of it.
 *
 * Shape deliberately mirrors the contention gate: build a snapshot once per project per cycle,
 * ask it per candidate, and feed launches back in through `noteStarted` so two harness tickets
 * cannot both slip through in the SAME cycle on the strength of a count taken before either
 * started.
 */
export interface HarnessBudgetGate {
  /** Slots this project may spend on harness tickets — `harnessSlots(wipLimit, sharePct)`. */
  readonly slots: number;
  /** The resolved share, for logging and for the "is the budget off?" check. */
  readonly sharePct: number;
  /** Harness builders already running when the snapshot was taken, plus this cycle's starts. */
  readonly used: number;
  /** Is this candidate a harness ticket? */
  isHarness: (issueId: string) => boolean;
  /**
   * May this candidate start? `false` ONLY for a harness ticket whose budget is full — a
   * product ticket is never held by this gate, which is the entire point: the budget shifts
   * concurrency toward product work, it does not reduce it.
   */
  allows: (issueId: string) => boolean;
  /** Record a launch so the rest of THIS cycle sees the slot as taken. */
  noteStarted: (issueId: string) => void;
}

/**
 * A gate that never holds anything — used when the share is 100 % (the documented way to
 * restore pre-#1021 behaviour) and as the fail-open result if the tag lookup throws. A budget
 * is a prioritisation rule, not a safety rule: a broken read must not stop the board starting
 * work.
 */
function openGate(sharePct: number, slots: number): HarnessBudgetGate {
  return {
    slots,
    sharePct,
    used: 0,
    isHarness: () => false,
    allows: () => true,
    noteStarted: () => {},
  };
}

export interface BuildHarnessBudgetGateArgs {
  database: Pick<typeof db, "select">;
  /** The In-Progress status id of the project, i.e. the population the WIP count is taken over. */
  inProgressStatusId: string;
  /** The project's effective WIP limit — the same number `runTodoPull` divides its slots from. */
  wipLimit: number;
  /** Resolved from the Strategy Bullseye via `resolveMonitorTunables`. */
  sharePct?: number;
  /** Candidate issue ids this cycle may start, so the tag lookup is one query. */
  candidateIssueIds: string[];
}

export async function buildHarnessBudgetGate(args: BuildHarnessBudgetGateArgs): Promise<HarnessBudgetGate> {
  const sharePct = args.sharePct ?? DEFAULT_HARNESS_SHARE_PCT;
  const slots = harnessSlots(args.wipLimit, sharePct);
  if (sharePct >= MAX_HARNESS_SHARE_PCT) return openGate(sharePct, slots);

  let harnessCandidates: Set<string>;
  let running: number;
  try {
    harnessCandidates = await selectHarnessIssueIds(args.database, args.candidateIssueIds);
    running = await countActiveHarnessWip(args.database, args.inProgressStatusId);
  } catch (err) {
    console.warn(`[monitor] harness-budget gate could not read the harness tag (starting without it): ${String(err)}`);
    return openGate(sharePct, slots);
  }
  // Nothing tagged and nothing running: the budget cannot bite this cycle, so skip the
  // bookkeeping entirely rather than carrying a gate that always says yes.
  if (harnessCandidates.size === 0 && running === 0) return openGate(sharePct, slots);

  let used = running;
  const gate: HarnessBudgetGate = {
    slots,
    sharePct,
    get used() { return used; },
    isHarness: (issueId: string) => harnessCandidates.has(issueId),
    allows: (issueId: string) => !harnessCandidates.has(issueId) || used < slots,
    noteStarted: (issueId: string) => { if (harnessCandidates.has(issueId)) used += 1; },
  };
  return gate;
}

/**
 * The one-line explanation that rides along with the skip, so a `harness_budget` hold in the
 * monitor log says what the budget actually was rather than only that one existed.
 */
export function describeHarnessBudget(gate: HarnessBudgetGate): string {
  return `harness budget full: ${gate.used}/${gate.slots} slot(s) at ${gate.sharePct}% share`;
}

/**
 * Apply the budget to ONE candidate in the pull loop: returns `true` when the caller must skip
 * it, having already logged and tallied the hold. Lives here rather than inline in
 * `monitor-auto-start.ts` for the same reason the snapshot does — that file is at the
 * god-module ceiling, and the whole rule reads better in one place than split across two.
 *
 * `harness_budget` is a PRIORITISATION hold, not a refusal. The slot goes to product work this
 * cycle and the ticket is the first harness candidate the next cycle considers. It fires only
 * on a `harness`-tagged ticket — a product ticket is never held by this gate — so the budget
 * changes what the board spends its concurrency ON without reducing the concurrency. A
 * `harnessSharePct` of 100 in the Strategy Bullseye disables it (pre-#1021 behaviour).
 */
export function holdForHarnessBudget(
  gate: HarnessBudgetGate,
  issue: { id: string; issueNumber: number | null },
  projectId: string,
  noteSkip: (projectId: string, issueNumber: number | null | undefined, reason: "harness_budget") => void,
  noteIssueSkip: (issueId: string, reason: "harness_budget") => void,
): boolean {
  if (gate.allows(issue.id)) return false;
  console.log(`[monitor] holding #${issue.issueNumber} for the harness budget — ${describeHarnessBudget(gate)}`);
  noteSkip(projectId, issue.issueNumber, "harness_budget");
  noteIssueSkip(issue.id, "harness_budget");
  return true;
}
