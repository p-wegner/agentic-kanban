import type { DependencyType } from "../../schema/index.js";
import type { DecomposableIssue } from "./issue.js";

// Drive-dashboard wire-contract types (pure DTOs). See ../api.ts barrel.

/**
 * Aggregated, at-a-glance view of a running drive (#800).
 *
 * Scope is the drive's meta/epic issue and its direct children (the `parent_of`
 * edges seeded for a drive epic). All fields are computed server-side from the
 * board + dependency graph + board-health-event log — no live build is run, so
 * the endpoint is cheap enough to poll alongside the board.
 */
export interface DriveDashboardIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  /** 0-based dependency depth among the drive's issues (tier graph row). */
  tier: number;
}

export interface DriveDashboardStall {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  /** Open upstream issues that are holding this one back. */
  blockedBy: Array<{ issueNumber: number | null; title: string }>;
}

export interface DriveDashboard {
  drive: {
    id: string;
    projectId: string;
    metaIssueId: string | null;
    target: string;
    completionContract: string | null;
    status: "active" | "completed" | "abandoned";
    startedAt: string;
    finishedAt: string | null;
  };
  /** N/N progress over the drive's scoped issues (meta excluded). */
  progress: {
    total: number;
    done: number;
    inProgress: number;
    inReview: number;
    todo: number;
    /** Issues whose status the wave-planner treats as terminal (done/cancelled). */
    percentDone: number;
  };
  /** Dependency tiers (tier 0 = no open blockers within the drive), ascending. */
  tiers: Array<{
    tier: number;
    issues: DriveDashboardIssue[];
  }>;
  /**
   * True when the meta/epic issue has no `parent_of` children and therefore scopes itself
   * (#1074's fallback) — a drive that is PLANNED but not yet DECOMPOSED. Distinguishes that
   * state from a genuinely single-ticket epic the decomposer declared `tooSmallToDecompose`,
   * which also reads as a one-tier, one-issue dashboard but should not offer to decompose
   * again. False whenever `metaIssueId` is null or the epic already has children (#1130).
   */
  selfScoped: boolean;
  /** Issues currently blocked by open upstream work — the obstacle list. */
  stalls: DriveDashboardStall[];
  /**
   * The most recent merge-category board-health event for the project — a proxy
   * for "last cascade event" (a merge is what unblocks downstream tiers). Null
   * when none has been recorded.
   */
  lastCascade: {
    summary: string;
    issueNumber: number | null;
    createdAt: string;
  } | null;
  /**
   * Cold-build-clean status. The cold-clone gate is expensive (a full fresh
   * clone + build), so this reports the gate's ENABLEMENT and the latest
   * build-related health event rather than running it live.
   */
  buildClean: {
    /** Whether the per-project cold-clone build gate is switched on. */
    coldCloneGateEnabled: boolean;
    /** Whether a verify gate (the keystone merge gate) is configured. */
    verifyGateConfigured: boolean;
    /** Latest server/launch/error health event mentioning a build/verify failure, if any. */
    lastBuildEvent: {
      summary: string;
      issueNumber: number | null;
      createdAt: string;
      eventType: string;
    } | null;
  };
}

/**
 * `POST /api/projects/:projectId/drives/:id/plan` (#1072) — turn a target-only drive into a
 * scopeable one by seeding the meta/epic issue from its target and linking the drive to it.
 *
 * The result carries a {@link DecomposableIssue} rather than a drive-specific shape: the
 * caller's next step is the ordinary `/decompose` -> `/decompose/confirm` pair, which is what
 * actually fills the backlog, and that is the input it wants.
 */
/**
 * A child ticket proposed by `/decompose`, carried on `DrivePlanResult` when planning was
 * asked to decompose in the same gesture (#1133). Mirrors the server's
 * `DecomposeChildProposal`/`DecomposeEpicResult` shapes — declared independently here
 * because shared cannot import server code; kept in step by
 * `drive-plan-decompose.test.ts`.
 */
export interface DrivePlanProposalChild {
  tempId: string;
  title: string;
  description: string;
  // Canonical vocabulary (`normalizeIssuePriority`), not the legacy "urgent" alias — see
  // `lib/issue-priority.ts`. `decomposeEpic` normalizes before this shape is populated, so
  // "urgent" never actually appears here.
  priority: "low" | "medium" | "high" | "critical";
  targetRepo?: string | null;
}

export interface DrivePlanProposalDependency {
  fromTempId: string;
  toTempId: string;
  type: DependencyType;
}

export interface DrivePlanProposal {
  children: DrivePlanProposalChild[];
  dependencies: DrivePlanProposalDependency[];
  alreadyDecomposed: boolean;
  repos: string[];
  tooSmallToDecompose?: boolean;
  coalescedTestOnly?: string[];
}

/**
 * `POST /api/projects/:projectId/drives/:id/plan` (#1072) — turn a target-only drive into a
 * scopeable one by seeding the meta/epic issue from its target and linking the drive to it.
 *
 * The result carries a {@link DecomposableIssue} rather than a drive-specific shape: the
 * caller's next step is the ordinary `/decompose` -> `/decompose/confirm` pair, which is what
 * actually fills the backlog, and that is the input it wants.
 */
export interface DrivePlanResult {
  /** The epic that now scopes the drive. */
  issue: DecomposableIssue;
  /**
   * True when the drive already had a meta issue and this call returned it untouched.
   * Planning is idempotent: it never creates a second epic for the same drive.
   */
  existing: boolean;
  /**
   * Present only when the caller asked for `?decompose=1` (#1133) — the `/decompose`
   * proposal for the epic returned above, so the UI can jump straight to the reviewable
   * preview instead of a second model-free click. Absent for a plain `plan` call, which
   * makes no model call. Also absent if decomposition itself failed — the created (or
   * existing) epic is still returned rather than failing the whole request.
   */
  proposal?: DrivePlanProposal;
}
