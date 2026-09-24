/**
 * `GET /api/internal/monitor-status` — the wire contract, declared once (#567).
 *
 * The route built an untyped object literal and the client re-declared its whole shape
 * by hand in `client/src/lib/monitor-popover.ts` (~90 lines): `MonitorTunables`,
 * `StartMode`, `StartPolicy`, `ResolvedTunables`, `ConductorSchedule`, the two warning
 * shapes, `MonitorAction`, `MonitorStatus`. Being a hand mirror, it had drifted —
 * `refillFocus` widened to `string`, `StartPolicy` lost `postMergeFollowups`, and
 * `currentCycle` / `maintenanceActive` / `maintenanceEnd` were simply absent, so a
 * client reading them got `any` with no warning.
 *
 * Types only — the one runtime helper (`isAutodriveStallWarning`) stays with its
 * consumer, since `types/` is an `export type *` barrel and cannot carry values.
 */
import type { MonitorActionName } from "../../lib/monitor-action.js";
import type { MonitorTunables } from "../../lib/strategy-objective-file.js";
import type { RISK_POSTURES } from "../../lib/risk-posture.js";
import type { DiskHealthSignal } from "../../lib/machine-capacity.js";
import type { AutoMergeSource } from "../../lib/merge-policy.js";

// Re-exported so consumers take it from the wire-contract barrel. The client used to
// deep-import lib/strategy-objective-file for it, which drags a Node-builtin chain into
// the client-safety guard's reachability graph even for a type-only import (#596).
export type { MonitorTunables };
import type { START_MODE_VALUES } from "../../lib/dynamic-preference-keys.js";

export type StartMode = (typeof START_MODE_VALUES)[number];

/** Which auto-start paths a project's Start Mode permits. See decision 008. */
export interface StartPolicy {
  mode: StartMode;
  /** The in-process monitor may auto-start unblocked backlog/todo tickets. */
  autoStartUnblocked: boolean;
  /** The post-merge dependency cascade may start the next unblocked ticket. */
  postMergeCascade: boolean;
  /** The post-merge FOLLOW-UP auto-start may run — a second, independent starter. */
  postMergeFollowups: boolean;
  /** The backlog-empty refill skill may run to generate tickets. */
  backlogRefill: boolean;
  /** Cron/HTTP scheduled runs are honored. */
  scheduledRuns: boolean;
  /** Effective WIP/refill tunables (from the Strategy Bullseye, else legacy prefs). */
  wip: MonitorTunables;
  /** Whether the mode came from an explicit per-project `start_mode_<id>` or was derived. */
  source: "start_mode" | "derived";
  /**
   * Project-wide QUIESCE (#1108) — a maintenance-window hold distinct from Start Mode.
   * `manual` deliberately still allows explicit relaunch (see `StartMode` docs); quiesce
   * does not — it is enforced at the workspace-create/launch chokepoints themselves
   * (`createWorkspace`, `launchSession`), not just at the monitor's own auto-start
   * decision, so it holds regardless of *why* something tried to start a workspace
   * (monitor, cron, conductor, or a human clicking relaunch).
   */
  quiesced: boolean;
  /** Operator-supplied reason, shown on the maintenance banner. */
  quiesceReason?: string;
}

export type RiskPostureLevel = (typeof RISK_POSTURES)[number];

/**
 * The one-dial risk posture (#911, decision 017), fanned out from `risk_posture_<projectId>`
 * (or a per-ticket `risk:<level>` tag override) into every consumer that previously had to be
 * aligned by hand: pre-merge gate tier, review launch, merge-train sizing, file-contention
 * mode, the builder's Stop-hook checks, and worker placement bias.
 *
 * `standard` is defined to reproduce today's behaviour exactly — see `resolveRiskPosture`.
 */
/**
 * Whether a merge may land on top of a red base branch, in increasing order of softness:
 * `block` < `allow-known-debt` < `allow-file-debt-ticket` < `report` (#1015, #1233). Named
 * separately from `RiskPosture` because it is the field the merge gate's red-debt subset rule
 * and the train window's red-base veto key on, and because a project may override it (softer
 * only) via `red_base_policy_<projectId>`.
 *
 * `report` is the softest: a red base never holds anything and files no ticket — the red is
 * only reported (delivery view, sweep row). It exists for decision 019's `flow` posture, where
 * the release candidate's sweep is the only place a full verdict is owed; no shipped level
 * resolves it today.
 */
export type RedBasePolicy = "block" | "allow-known-debt" | "allow-file-debt-ticket" | "report";

/**
 * The EFFECTIVE periodic base-branch sweep for one project (#1031) — reported on
 * `GET /api/projects/:id/base-branch-health` (`sweep`) and per project on
 * `GET /api/projects/health` (`baseSweep`), so an operator can see which projects run the
 * full suite on a schedule and how often, without reading the posture table.
 */
export interface BaseSweepInfo {
  /** `false` = no scheduled sweep at all (the opt-in rule: no posture chosen, or only a tag). */
  scheduled: boolean;
  /** The interval the sweep actually uses, or `null` when `scheduled` is false. */
  intervalMs: number | null;
  /** The LEVEL's nominal cadence — what the project would get once a posture is chosen. */
  nominalIntervalMs: number | null;
  postureLevel: RiskPostureLevel;
  postureSource: RiskPosture["source"];
  /** One human sentence naming the cadence or why there is none. */
  reason: string;
  /** `lastProbeAt + intervalMs` when both are known — a hint, not the scheduler's verdict. */
  nextDueAt: string | null;
}

export interface RiskPosture {
  level: RiskPostureLevel;
  /** Whether the level came from an explicit per-project pref, a per-ticket `risk:` tag
   *  override, or fell back to the default. */
  source: "risk_posture" | "issue_tag" | "default";
  gateTier: "full" | "scoped" | "scoped-base-watch" | "impact";
  reviewMode: "thorough" | "standard" | "train-only" | "none";
  /**
   * How often the periodic base-branch health sweep should run the FULL verify for this
   * project, in ms — the other half of the verification cadence (#983). `null` means no
   * scheduled sweep at all; the per-merge gate is then the only check.
   *
   * **This is the NOMINAL cadence for the level, not the answer to "does a sweep run".**
   * The sweep is OPT-IN: read it through `resolveBaseSweepIntervalMs`, which returns `null`
   * for any project that never explicitly chose a posture, so importing a repo never starts
   * background compute on an idle project.
   */
  sweepIntervalMs: number | null;
  /** Whether a merge is allowed to land on top of a red base branch. */
  redBasePolicy: RedBasePolicy;
  trainMaxSize: number;
  trainMaxWaitMs: number;
  /**
   * How many MERGES one monitor cycle may attempt for this project (#919). Was the
   * board-wide constant `MAX_MONITOR_MERGES_PER_CYCLE = 2`, which put a ~30 merges/hour
   * ceiling on every project regardless of how much verification it had already paid for —
   * a `sprint` project that batches a train has already done the expensive part and should
   * not then land it two tickets at a time.
   */
  mergesPerCycle: number;
  /** How many stalled builders one monitor cycle may relaunch for this project (#919). */
  relaunchesPerCycle: number;
  /** What the builder's own Stop hook checks before allowing exit. */
  builderStopChecks: "tests-and-typecheck" | "tests-capacity-gated" | "typecheck-only" | "none";
  contentionMode: "off" | "warn" | "serialize";
  placementBias: "host-half" | "host-preferred" | "remote-preferred";
  /** One line naming what this posture skips relative to `standard`, for gate/merge
   *  messages — the visibility rule (#911): a weaker posture may only weaken visibly. */
  summary: string;
}

/** `GET /api/board-monitor/tunables` — the resolved WIP/refill numbers and where they came from. */
export interface ResolvedTunablesResponse {
  tunables: MonitorTunables;
  source: "strategy" | "prefs";
  startPolicy?: StartPolicy;
  /**
   * Host disk-health signal (#1127), alongside the CPU/RAM `capacity` read above: `null` on a
   * non-Windows host or when the event log can't be read, never a false alarm.
   */
  diskHealth?: DiskHealthSignal | null;
}

/**
 * Why the next in-process monitor cycle starts nothing for a project (#1102) — the single most
 * relevant hold, for the toolbar Autopilot chip.
 */
export type AutopilotHoldReason =
  | "manual_mode"
  | "conductor_mode"
  | "wip_full"
  | "machine_full"
  | "start_cap"
  | "gate_running"
  | "no_worker"
  | "no_ready_tickets";

/** `GET /api/projects/:id/autopilot` — one glance at a project's auto-start and auto-merge (#1102). */
export interface AutopilotStatusResponse {
  projectId: string;
  startMode: "manual" | "monitor" | "conductor";
  startModeSource: "start_mode" | "derived";
  /** The in-process monitor auto-starts this project (Start Mode `monitor`). */
  autoStart: boolean;
  /** Active WIP right now. */
  running: number;
  /** The WIP limit (`resolveWipLimit`) — the Strategy Bullseye's `activeAgentsTarget` or the default. */
  limit: number;
  /** False when the Bullseye names no target and `limit` is the default. */
  limitConfigured: boolean;
  /** `limit` after the machine-headroom clamp. */
  effectiveLimit: number;
  startsPerCycle: number;
  backlogFloor: number;
  /** Starts the slot arithmetic allows (as if auto-started), before counting ready tickets. */
  slots: number;
  /** Tickets that pass the cheap start gates (counting stops at 25 per pass). */
  eligibleCount: number;
  eligibleCountCapped: boolean;
  /**
   * Todo/Backlog tickets that pass every cheap start gate EXCEPT the dependency gate — they wait
   * only on a blocker that has not landed (#1162). Lets the chip say "backlog blocked" instead of
   * "nothing ready" when the backlog is full but gated. Counted over the same capped scan.
   */
  blockedByDependencies: number;
  /** What the next cycle will start: 0 unless `autoStart`. */
  willStartNextCycle: number;
  holdReason: AutopilotHoldReason | null;
  /**
   * The EFFECTIVE auto-merge answer. `paused_same_failure` (#1207) is the circuit breaker, which
   * lives in `runtime_state` rather than in prefs, so it is overlaid on `resolveAutoMerge`'s
   * verdict by the server rather than resolved from the prefMap.
   */
  autoMerge: { enabled: boolean; source: AutoMergeSource };
  nextCycleAt: string | null;
}

/**
 * The EFFECTIVE risk posture + merge-train read model for one project (#1155) — what the
 * header chip reads instead of re-deriving the posture client-side (the old `RiskPostureChip`
 * used the LEVEL-ONLY client resolver, `@agentic-kanban/shared/lib/risk-posture`, which cannot
 * report anything the level implies or a per-project override changes). Modelled on
 * `AutopilotStatusResponse`: the server does the resolving, the client only renders.
 *
 * `trainMaxSize`/`trainMaxWaitMs` are `resolveTrainOptInSize`'s and `resolveTrainWindowConfig`'s
 * numbers respectively — deliberately NOT the same field, since the queue's opt-in default (1)
 * and the window's collection default (`DEFAULT_TRAIN_MAX_SIZE`) differ (see
 * `merge-train-window.ts`'s header comment). `trainSizeFromPosture`/`trainWaitFromPosture` say
 * whether each number came from the posture (`batchingFromPosture`) or an explicit per-project
 * override, so "why is this 1?" is answerable from the chip alone.
 */
export interface DeliveryStatusResponse {
  projectId: string;
  posture: RiskPosture;
  /** Whether the effective train SIZE (the queue's opt-in) came from an explicit
   *  `train_max_size_<projectId>` override rather than the posture. */
  trainSizeFromOverride: boolean;
  /** The merge-train WINDOW's effective size (`resolveTrainWindowConfig`) — when to stop
   *  collecting, distinct from the queue's opt-in size above. */
  trainWindowMaxSize: number;
  trainWindowMaxWaitMs: number;
  /** Did the train WINDOW pick up the posture's numbers, or stay on the shipped defaults? */
  trainWindowFromPosture: boolean;
  baseSweep: BaseSweepInfo;
  /** The effective red-base policy and whether a red base is holding the train window (#1233). */
  redBase: RedBaseStatus;
}

/**
 * What a red base currently does to this project (#1233): the EFFECTIVE policy (the posture's,
 * after any softer-only project override), the latest sweep verdict, and whether the merge-train
 * window is being HELD by it right now — `resolveBaseRedVeto`'s own answer, so the chip shows
 * the same decision the orchestrator makes. Under `block` a red base the branch has not moved
 * past holds the window; under every other policy it is reported here and never holds.
 */
export interface RedBaseStatus {
  policy: RedBasePolicy;
  /** The latest sweep's outcome for this project, or null when it was never swept. */
  latestOutcome: "green" | "red" | "timeout" | "unverified" | null;
  /** The sha that outcome was recorded at. */
  latestSha: string | null;
  /** True exactly when the train window would be held for a red base on the next tick. */
  holdingWindow: boolean;
  /** Open `heal` tickets filed by the sweep for this project (0 under any policy but `allow-file-debt-ticket`). */
  openHealTickets: number;
}

export interface ConductorSchedule {
  enabled: boolean;
  cron: string;
  agent: "claude" | "codex";
  lastFiredAt: string | null;
  valid: boolean;
  error: string | null;
  description: string | null;
  nextFireAt: string | null;
}

/**
 * The main checkout has uncommitted tracked source changes, which blocks every merge.
 *
 * `type` is NEW (#567): this warning had no discriminant, so the client narrowed the
 * union with `"type" in warning` — a structural test that silently stops working the
 * day a second undiscriminated member is added.
 */
export interface DirtyMainCheckoutWarning {
  type: "dirty_main_checkout";
  projectId: string;
  projectName: string;
  repoPath: string;
  detectedAt: string;
  fileCount: number;
  files: string[];
  message: string;
}

export interface AutodriveStallWarning {
  type: "autodrive_stall";
  projectId: string;
  projectName: string;
  detectedAt: string;
  thresholdMin: number;
  stalledForMin: number;
  lastProgressAt: string;
  activeIssueCount: number;
  workspaceIds: string[];
  issueNumbers: number[];
  cause: string;
  message: string;
}

/**
 * A project's base-branch health probe has a DEGENERATE verdict distribution: many probes, not
 * one green, ever (#681).
 *
 * The gate reads only the latest verdict, where "red again" and "the probe itself is broken"
 * look identical. Measured on the dev board: 200 probes, 199 red + 1 timeout, 0 green over five
 * days, with reds that were unmistakable install artifacts — roughly half of all recorded
 * base-health verdicts were false, and no mechanism said a word. This warning is the mechanism.
 */
export interface DegenerateBaseHealthWarning {
  type: "degenerate_base_health";
  projectId: string;
  projectName: string;
  detectedAt: string;
  /** Probes recorded for this project, ever. */
  probeCount: number;
  greenCount: number;
  redCount: number;
  timeoutCount: number;
  /** ISO timestamps bounding the degenerate window, so the message can name how long it ran. */
  firstProbeAt: string | null;
  lastProbeAt: string | null;
  message: string;
}

/**
 * One or more test suites have been red across CONSECUTIVE base-health probes (#681 half B).
 *
 * The other half of the same ticket. Half A catches a probe that cannot produce a green; this
 * catches a TREE that stays red while every commit message claims otherwise — measured breakage
 * age at repair: ~26 days for `console-tag-ratchet`, 47.9 h / 144 commits for the #614
 * time-spelling ratchet. The durable record was one boolean per probe, so "red again for the
 * same reason" and "red for a new reason" were the same row.
 */
export interface RottedSuiteWarning {
  type: "rotted_suite";
  projectId: string;
  projectName: string;
  detectedAt: string;
  /** How many distinct suites are in a red streak. */
  suiteCount: number;
  /** The longest streak's length, in probes, and its span in whole hours. */
  longestStreakProbes: number;
  longestStreakHours: number;
  suites: RottedSuiteEntry[];
  message: string;
}

export interface RottedSuiteEntry {
  /** Repo-relative test-file path, as the runner printed it. */
  suite: string;
  consecutiveRedProbes: number;
  /** The oldest and newest probe in this suite's current red streak. */
  redSinceAt: string;
  lastRedAt: string;
}

export type MonitorWarning = DirtyMainCheckoutWarning | AutodriveStallWarning | DegenerateBaseHealthWarning | RottedSuiteWarning;

export interface MonitorAction {
  at: string;
  action: MonitorActionName;
  workspaceId: string;
  issueId: string;
  /** HTTP endpoint called for this action, e.g. /api/workspaces/:id/merge */
  endpoint?: string;
  /** HTTP response status code */
  httpStatus?: number;
  /** Truncated response body summary */
  responseSummary?: string;
  /** Post-action verification result */
  verificationResult?: "ok" | "failed" | "skipped";
}

export interface MonitorResourceSummary {
  processCount: number;
  listenerCount: number;
  activeWorkspaceCount: number;
  keptCount: number;
  cleanedCount: number;
  cleanupFailedCount: number;
}

export interface MonitorLastRun {
  at: string;
  relaunched: number;
  merged: number;
  nudged: number;
  resources: MonitorResourceSummary | null;
  warnings: number;
  deferredProjectIds?: string[];
  skippedProjectIds?: string[];
  notStartedProjectIds?: string[];
}

/** One process-tree decision from the resource sweep, as the status endpoint reports it. */
export interface MonitorResourceDecision {
  rootPid: number;
  pids: number[];
  listenerPorts: number[];
  associatedWorkspaceIds: string[];
  action?: "kept" | "cleaned" | "cleanup_failed";
  reason: string;
}

export interface MonitorStatusResponse {
  /**
   * #357 — "will work start on its own?". The global toggle OR any monitor-mode project,
   * NOT the raw `auto_monitor` pref: reporting the raw pref made the board say "monitor
   * off" while cycles were running. The raw toggle is `globalToggle`.
   */
  enabled: boolean;
  globalToggle: boolean;
  monitorDrivenProjectCount: number;
  intervalMin: number;
  /** A timer is armed for a FUTURE cycle. Not the same as "a cycle is running". */
  active: boolean;
  /** A cycle is executing right now. `nextRunAt` is null while this is true. */
  cycleInFlight: boolean;
  lastRun: MonitorLastRun | null;
  /** Progress marker for the cycle IN FLIGHT (null when none is running) — #208. */
  currentCycle: { startedAt: string; phase: string } | null;
  nextRunAt: string | null;
  recentActions: MonitorAction[];
  resourceSnapshot: {
    at: string;
    kept: MonitorResourceDecision[];
    cleaned: MonitorResourceDecision[];
  } | null;
  warnings: MonitorWarning[];
  lastHealthCheckAt: string | null;
  /** Verbose-only: per-phase durations of the last completed cycle (#347). */
  lastCyclePhaseTimings?: unknown;
  maintenanceActive: boolean;
  maintenanceEnd: string | null;
  /**
   * #1021 — "harness share this week: N %": the share of tickets that reached Done in the
   * last 7 days carrying the `harness` tag, so the number the proposal established by a
   * one-off grep is a standing read-off. `sharePct` is null when nothing landed in the
   * window — that is not the same answer as 0 %.
   */
  harnessShare: {
    doneCount: number;
    harnessCount: number;
    sharePct: number | null;
    windowDays: number;
  } | null;
}
