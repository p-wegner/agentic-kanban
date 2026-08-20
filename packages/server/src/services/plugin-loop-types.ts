import type {
  PluginLoopCheck,
  PluginLoopGate,
  PluginLoopProgressStep,
  PluginManifest,
  PluginPlaceholderVars,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { PluginRow } from "../repositories/plugins.repository.js";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { CreateIssueInput, CreateIssueResult } from "./issue.service.js";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "./workspace-internals.js";
import type { LoopStartOutcome } from "./plugin-loop-start.service.js";
import type { LoopStall } from "./plugin-loop-stall.js";

/**
 * Types for the board-owned converging analysis loops engine (`plugin-loop.service.ts`).
 * Split out (#465) so the engine file stays under the god-module line ceiling — pure
 * interfaces, no logic.
 */

/**
 * One plugin RUN, resolved once (#554) — see `resolvePluginRunContext` in plugin.service.
 * Every entry point (butler fragment, script, view, loop plan, loop gate) needs the same
 * four things, and assembling them by hand is what let `{{repoPath}}` disagree per site.
 */
export interface PluginRunContext {
  plugin: PluginRow & { manifest: PluginManifest };
  project: { id: string; name: string; repoPath: string };
  /** Where this plugin's output goes: the leading repo, or its sidecar. */
  outputRepoPath: string;
  vars: PluginPlaceholderVars;
}

/** A run context plus the flat argument object the loop engine takes. */
export interface PluginLoopRunContext extends PluginRunContext {
  args: {
    pluginRowId: string;
    manifest: PluginManifest;
    pluginSlug: string;
    pluginName: string;
    pluginLocalPath: string;
    loopName: string;
    projectId: string;
    projectName: string;
    repoPath: string;
    leadingRepoPath: string;
    workflowTemplateId: string | null;
  };
}

export interface LoopCreatedTicket {
  unitId: string;
  issueId: string;
  issueNumber: number | null;
  title: string;
  /** Repo-relative artifacts the unit declared (#288). */
  artifacts?: string[];
}

export interface LoopAdvanceResult {
  loop: string;
  /** The planner's verdict: no outstanding units (or an explicit `converged: true`). */
  converged: boolean;
  note: string | null;
  /** Units the planner reported this advance. */
  planned: number;
  created: LoopCreatedTicket[];
  /**
   * Units already ticketed by an earlier advance. `issueId` is carried (#360) because the
   * post-resolve report has to resolve each of these units' REAL state, and it must not do that
   * through `issues.statusName` (measured ≥84s late, #358).
   */
  skippedExisting: Array<{ unitId: string; issueId: string; issueNumber: number | null; statusName: string }>;
  /** Units dropped because the advance hit `maxUnitsPerAdvance` — replanned next time. */
  capped: number;
  /**
   * What this advance DID about starting each ticket it created (#351/#354/#357). The surface and
   * the butler must report from this, never from a pipeline-level word like "generating": the two
   * previous reporting bugs were an over-claim ("State: generating" for a parked ticket) and a
   * silence (nothing at all after an approval).
   */
  startOutcomes: LoopStartOutcome[];
  /**
   * #357/#360 — the pre-rendered, falsifiable sentences the butler and the HTTP reply report,
   * covering EVERY unit this advance planned: the ones it created (from `startOutcomes`) AND the
   * ones it found already ticketed, each resolved from its real workspace/provisioning state.
   *
   * `startOutcomes` alone was the defect: it is built from `created` only, so when another advance
   * queued behind a gate resolve won the lock and created the unit first, this advance reported
   * `skippedExisting` with an EMPTY `startOutcomes` and the butler's fallback branch asserted that
   * nothing was planned — while the unit was 80s from a live workspace. 2 of 3 live approvals.
   */
  startNotices: string[];
  /**
   * Who will actually start the created tickets. `manual` means nobody will —
   * the tickets sit in the backlog until the user sets Start Mode or launches
   * them by hand, so the UI has to say so rather than imply the loop is running.
   */
  startMode: string;
  warnings: string[];
  /** Human gate the plan reported (#286) — null when not blocked on a person. */
  gate: PluginLoopGate | null;
  /** Declarative progress strip (#289). */
  progress: { steps: PluginLoopProgressStep[] } | null;
  /** Structured check results (#290). */
  checks: PluginLoopCheck[] | null;
}

export interface LoopStatus {
  name: string;
  label: string;
  description: string | null;
  skill: string;
  /** Open (non-terminal) tickets this loop has created. */
  openTickets: number;
  /**
   * The open tickets themselves (#429) — same rows the count is derived from.
   *
   * `stranded` (#413) marks the phantom shape: the ticket is open, it HAS had a workspace,
   * and none of them is live. Nothing will close it, so the loop's "round in progress —
   * the next round is planned automatically once they close" is a promise it cannot keep.
   * A merely QUEUED ticket (planned, never provisioned) has no workspace at all and is not
   * stranded — that distinction is the whole reason `hasAnyWorkspace` is carried.
   */
  openTicketRefs: Array<{
    issueId: string;
    issueNumber: number | null;
    statusName: string;
    stranded: boolean;
  }>;
  /**
   * Issue numbers of the open tickets that genuinely belong to a round still in flight (#431).
   *
   * The gate card renders when this is EMPTY, which is not the same question as
   * `openTickets === 0`: that count includes the gate's own ticket, so anything holding it
   * non-terminal — a review parked for a human, a refused merge, an orphaned workspace — used to
   * take the gate off the screen precisely when it was the thing the operator needed. See
   * `gateBlockingTickets`.
   */
  gateBlockedBy: Array<number | null>;
  /** Terminal (Done/Cancelled) tickets this loop has created. */
  closedTickets: number;
  /** True when a human has paused this loop's monitor-driven auto-advance. */
  paused: boolean;
  /**
   * True when the planner's last advance reported the JOB done (no units + `converged: true`)
   * and that verdict was persisted. The monitor stops advancing such a loop; a manual "Advance
   * now" still replans it and clears the flag if there is work again.
   */
  converged: boolean;
  /** The planner's note from the most recent advance (persisted in the timeline). */
  note: string | null;
  /** When the loop last advanced (ISO), null before the first advance. */
  lastAdvanceAt: string | null;
  /** Human gate the loop is currently blocked on (#286), from the latest advance. */
  gate: PluginLoopGate | null;
  /**
   * When the CURRENT gate was first reached (ISO), from its one-time `gate-reached` event;
   * null when there is no gate (or it predates this field being recorded).
   *
   * Not the same as `lastAdvanceAt` and not interchangeable with it: the monitor re-plans a
   * gated loop every cycle, so `lastAdvanceAt` keeps moving while the human has not acted.
   * Anything that wants to say how long a decision has been waiting — the inbox, an
   * age badge, a nag — must use THIS. Reading `lastAdvanceAt` instead makes a gate that has
   * sat untouched for an hour look like it appeared moments ago (observed on a live run).
   */
  gateSince: string | null;
  /** Declarative pipeline progress (#289), from the latest advance. */
  progress: { steps: PluginLoopProgressStep[] } | null;
  /** Structured check results (#290), from the latest advance. */
  checks: PluginLoopCheck[] | null;
  /**
   * #357 — what the last advance DID about starting the tickets it planned, as pre-rendered
   * sentences. The surface needs this because the gate card VANISHES on approval and nothing took
   * its place: `note` alone ("Planned step 5/9 …") states that a plan exists and says nothing about
   * what happens next, which is indistinguishable from "nothing will ever happen".
   */
  startNotices: string[];
  /**
   * A finished-but-unlanded loop ticket (#299): the builder is done (In Review/Done) but
   * its workspace has not merged, so the planner — which reads the MAIN checkout — cannot
   * see the artifacts and every re-advance is a silent dedupe no-op. The UI renders this
   * as its own state with a one-click Merge; null when nothing is stuck.
   *
   * #336/#363 widened this to a second, differently-shaped stall — a workspace parked
   * `ready_for_merge` whose issue never left In Progress — so the value now carries a `reason`
   * and a `mergeSafe` flag. Read `mergeSafe` before offering a merge: #363's parked branch had
   * ZERO commits, and landing it would have closed the unit without its artifacts.
   */
  awaitingMerge: LoopStall | null;
  /**
   * The butler's pre-read verdict for the CURRENT gate (#309), from the latest
   * `gate-recommendation` timeline event — null when there is no gate, the
   * recommendation is for an older gate, or the feature is off.
   */
  gateRecommendation: { actionId: string; reason: string } | null;
  /**
   * Session-cost rollup for this loop's unit tickets (#294), in USD. `null` when the
   * caller opted out of the (expensive) rollup via `loopStatuses(..., { includeCosts:
   * false })` — the cross-project inbox does, since it never renders cost.
   */
  totalCostUsd: number | null;
}

export interface PluginLoopDeps {
  database: Database;
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  /**
   * Injected so a freshly planned loop ticket can be STARTED in the advance path instead of
   * waiting for a monitor cycle to notice it (#351). Absent on dep-less route constructions, which
   * degrade to the old poll-dependent behaviour and say so via a `queued-no-starter` outcome.
   */
  createWorkspace?: (input: CreateWorkspaceInput) => Promise<CreateWorkspaceResult>;
  /** Externally reachable board API base URL (`{{boardUrl}}` in planner command/env) —
   *  resolved by the composition root, not read from env here. */
  boardUrl: string;
  /** For the one-shot gate-reached notification (#287); absent on dep-less routes. */
  boardEvents?: BoardEvents;
}

/** What an advance persists into the timeline (`advance` event payload). */
export interface AdvanceEventPayload {
  planned: number;
  created: Array<{ unitId: string; issueId: string; issueNumber: number | null; title: string; artifacts?: string[] }>;
  skippedExisting: number;
  capped: number;
  converged: boolean;
  note: string | null;
  gate: PluginLoopGate | null;
  progress: { steps: PluginLoopProgressStep[] } | null;
  checks: PluginLoopCheck[] | null;
  /**
   * #357 — pre-rendered, falsifiable sentences about what happened to the tickets this advance
   * planned. Persisted so the loop panel has something to SHOW where the gate card used to be: a
   * freshly planned unit previously left the surface with `note` alone ("Planned step 5/9 …"), a
   * statement that a plan exists with nothing about what the human should do about it.
   */
  startNotices?: string[];
  /**
   * #448 — how many advances this ONE row stands for, including the first. Absent or 1 means
   * "happened once"; 47 means the same no-op advance was observed 47 times. See
   * `collapseRepeatedNoOpAdvance` for the exact contract. Renderable as `×47`.
   */
  repeatCount?: number;
  /**
   * #448 — when the FIRST of those repeats happened (ISO). Only present on a collapsed row; the
   * row's own `createdAt` is the MOST RECENT repeat, so this is the other end of the run
   * ("unchanged since <firstSeenAt>").
   */
  firstSeenAt?: string;
}
