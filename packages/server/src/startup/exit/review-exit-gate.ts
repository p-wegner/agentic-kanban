/**
 * The review-exit gate, posture-aware (#1260).
 *
 * After a clean review, `handleReviewSessionExit` used to run the full pre-merge gate on every
 * posture and withhold `readyForMerge` until it passed. Under a posture whose MERGE path gates
 * anyway, that paid the test gate twice per ticket: once solo at review-exit (25-40 min on this
 * repo), then again when the merge job or train gated the tree that lands. The solo verdict was
 * also thrown away whenever the base moved before the merge (#243), which on a busy board is most
 * of the time. Measured on the stable board, 2026-09-26: three passed solo gates (2463 s, 1489 s,
 * 1508 s) discarded that way.
 *
 * Under those postures the review-exit gate now runs the project's TYPECHECK command only. It
 * still withholds `readyForMerge` on a red typecheck (a non-compiling branch is not worth a merge
 * slot), but the test step is skipped here and runs exactly once, at merge.
 *
 * A FULL gate whose base moved during the run by verdict-neutral paths only (e.g. a Bullseye save
 * committing just `scripts/board-monitor/objective.md`) keeps its verdict, re-keyed to the new
 * base, inside `runGateWithEvidence` (`services/base-move-relevance.ts`); any other base move
 * still discards it.
 *
 * The typecheck-only run must never read as a passed test gate downstream. It produces NO token
 * and its persisted evidence carries no `ranAt`/`stage`, so:
 *  - the monitor's `gateTokenFromWorkspaceEvidence` (which needs both) returns `RUN_GATE`;
 *  - `reusePersistedGateVerdict` (the HTTP merge path, #893) needs a `ranAt` and a
 *    `verify`/`smoke` stage, and returns null;
 *  - the #797 synchronous foundational merge is handed `RUN_GATE`, since `token` is null;
 *  - the train gates its assembled tree regardless of any workspace evidence.
 * The typecheck also never goes through `runPreMergeGate`, so it cannot bank a green in the #492
 * tree memo that the merge gate would then replay for the same merged tree.
 *
 * `source` and `message` on the evidence row say what ran ("typecheck-only"), which is the honest
 * record; `ranAt`/`stage` stay null because nothing proved the tests.
 */
import type { RiskPosture, RiskPostureLevel } from "@agentic-kanban/shared/types";
import { runSetupScript, type SetupScriptResult } from "@agentic-kanban/shared/lib/setup-script";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../../db/index.js";
import { runGateWithEvidence, type GateWithEvidence } from "../../services/merge-gate-evidence.js";
import type { MergeGateShas } from "../../services/merge-gate-token.js";
import type { PreMergeGateWorkspace } from "../../services/pre-merge-gate.types.js";
import { formatPostureNote, resolveIssueRiskPosture } from "../../services/risk-posture.service.js";
import { getStackProfile } from "../../services/stack-profile.service.js";

/** The evidence `source` of a full review-exit gate (unchanged since #182). */
export const REVIEW_EXIT_GATE_SOURCE = "review-exit gate";

/** The evidence `source` of a typecheck-only review-exit run (#1260). */
export const REVIEW_EXIT_TYPECHECK_ONLY_SOURCE = "review-exit gate (typecheck-only; tests deferred to the merge gate)";

/** Wall-clock ceiling for the typecheck. `pnpm typecheck` here is ~10-60 s; this is a hang guard. */
const REVIEW_EXIT_TYPECHECK_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Postures whose review-exit gate skips the test step (#1260). The same set as
 * `FLUSH_ALLOWED_LEVELS`, for the same reason:
 *  - `strict`/`standard` define a per-ticket gate and promise a green master (`redBasePolicy`
 *    `block`); their review-exit gate stays exactly as it was.
 *  - `iterate`/`flow`: the per-merge gate is the test-impact selection, run by the merge job or
 *    train on the tree that lands. A solo run of the same selection at review-exit is a duplicate
 *    whose verdict #243 discards whenever the base moves.
 *  - `fast`/`sprint`: the posture defines the gate as once per TRAIN; a per-ticket test run at
 *    review-exit contradicts that definition.
 */
const REVIEW_EXIT_DEFERS_TESTS: ReadonlySet<RiskPostureLevel> = new Set(["iterate", "fast", "sprint", "flow"]);

export function reviewExitDefersTestsToMerge(posture: Pick<RiskPosture, "level">): boolean {
  return REVIEW_EXIT_DEFERS_TESTS.has(posture.level);
}

/** A review-exit gate outcome: the #243 protocol's result, plus which mode produced it. */
export interface ReviewExitGate extends GateWithEvidence {
  /** True when only the typecheck ran; the evidence built from it claims no test pass. */
  typecheckOnly: boolean;
}

/** What `armReadyForMerge` persists for a review-exit pass. */
export interface ReviewExitEvidence {
  ranAt: string | null;
  stage: string | null;
  source: string;
  branchSha: string | null;
  baseSha: string | null;
  message: string;
}

/**
 * The evidence to persist beside `readyForMerge`. A full gate records its pass as before; a
 * typecheck-only run records WHAT ran (`source`, `message`) but no `ranAt`/`stage`, so no merge
 * path can read it as a passed test gate (see the module doc for each consumer).
 */
export function buildReviewExitEvidence(gate: ReviewExitGate, gateShas: MergeGateShas): ReviewExitEvidence {
  if (gate.typecheckOnly) {
    return { ranAt: null, stage: null, source: REVIEW_EXIT_TYPECHECK_ONLY_SOURCE, branchSha: null, baseSha: null, message: gate.message };
  }
  return {
    ranAt: gate.ranAt,
    stage: gate.stage,
    source: REVIEW_EXIT_GATE_SOURCE,
    branchSha: gateShas.branchSha ?? null,
    baseSha: gateShas.baseSha ?? null,
    message: gate.message,
  };
}

export interface RunReviewExitGateArgs {
  workspace: PreMergeGateWorkspace;
  projectId: string;
  issueId: string;
  prefMap: Map<string, string>;
  database: Database;
  /** Injectable seams, so a test needs no repo, no build and no real posture tag read. */
  resolvePosture?: (issueId: string, projectId: string, prefMap: Map<string, string>, database: Database) => Promise<RiskPosture>;
  readTypecheckCommand?: (projectId: string, database: Database) => Promise<string | null>;
  runTypecheck?: (workingDir: string, command: string) => Promise<SetupScriptResult>;
  runFullGate?: typeof runGateWithEvidence;
}

async function readProfileTypecheckCommand(projectId: string, database: Database): Promise<string | null> {
  return (await getStackProfile(projectId, database))?.typecheckCommand?.trim() || null;
}

function runTypecheckCommand(workingDir: string, command: string): Promise<SetupScriptResult> {
  return runSetupScript(workingDir, command, { timeoutMs: REVIEW_EXIT_TYPECHECK_TIMEOUT_MS });
}

/**
 * Run the review-exit gate. `strict`/`standard` (and any posture that cannot be resolved, or a
 * project with no typecheck command) run the full gate through the #243 protocol, exactly as
 * before. The deferring postures run the typecheck only.
 */
export async function runReviewExitGate(args: RunReviewExitGateArgs): Promise<ReviewExitGate> {
  const { workspace, projectId, issueId, prefMap, database } = args;
  const runFullGate = args.runFullGate ?? runGateWithEvidence;
  // An unreadable posture fails CLOSED to the full gate: running more than asked is safe.
  const posture = await (args.resolvePosture ?? resolveIssueRiskPosture)(issueId, projectId, prefMap, database)
    .catch(() => null);
  const defers = posture !== null && reviewExitDefersTestsToMerge(posture);
  const command = defers && workspace.workingDir
    ? await (args.readTypecheckCommand ?? readProfileTypecheckCommand)(projectId, database).catch(() => null)
    : null;
  if (!defers || !command || !workspace.workingDir) {
    if (defers) {
      console.log(`[workflow] review-exit gate for workspace ${workspace.id}: posture '${posture!.level}' defers tests to the merge gate, but ${workspace.workingDir ? "the project has no typecheck command" : "the workspace has no worktree"} — running the full gate instead (#1260)`);
    }
    return { ...(await runFullGate({ workspace, projectId, source: REVIEW_EXIT_GATE_SOURCE, database })), typecheckOnly: false };
  }
  const startedAtMs = Date.now();
  let result: SetupScriptResult;
  try {
    result = await (args.runTypecheck ?? runTypecheckCommand)(workspace.workingDir, command);
  } catch (err) {
    result = { exitCode: -1, stdout: "", stderr: errorMessage(err) };
  }
  const durationMs = Date.now() - startedAtMs;
  const passed = result.exitCode === 0 && !result.timedOut && !result.noProgress;
  const note = formatPostureNote(posture);
  const message = passed
    ? `review-exit gate passed (typecheck only: \`${command}\` in ${Math.round(durationMs / 1000)}s; test step SKIPPED here, the merge gate runs it once)${note}`
    : `review-exit typecheck failed (\`${command}\`, exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${`${result.stdout}\n${result.stderr}`.trim().slice(-1500)}${note}`;
  console.log(`[workflow] workspace ${workspace.id}: ${message.split("\n")[0]} (#1260)`);
  return {
    passed,
    ran: true,
    stage: "verify",
    message,
    shasBefore: {},
    evidenceShas: {},
    baseMoveKept: null,
    moved: null,
    movedDetail: null,
    ranAt: new Date().toISOString(),
    token: null,
    durationMs,
    typecheckOnly: true,
  };
}
