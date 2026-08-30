/**
 * The PRIMARY state a workspace card leads with — surface tint, dot, and label (#944).
 *
 * This was an if-chain expressed twice inside `WorkspaceSummarySection`: once to pick the
 * container's border/background classes, and again to pick the dot and text. The two chains
 * had to stay in the same order to agree, and nothing checked that they did — adding the
 * in-flight gate state meant editing both, in two places, with the precedence encoded only as
 * the sequence of ternaries. Extracted per this package's `lib/<feature>.ts` convention (a pure
 * core beside the component that renders it), which also brings the component back under the
 * god-module gate's per-function branch ceiling.
 *
 * **Precedence is the contract here**, and it is the reason the module exists rather than the
 * side effect of one: an in-flight merge gate outranks everything, because during the gate the
 * workspace's own `status` is `idle` (the agent has finished) — so every lower branch would
 * render a 30-45 minute verify run identically to a workspace nobody has touched in a week.
 */
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { gateActivityDotClass } from "./badgeTones.js";

/** The per-issue "main" workspace summary (non-null; the card renders it only when present). */
type WorkspaceMain = NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>;

export type WorkspaceCardStateKind =
  | "gate"
  | "reviewing"
  | "fixing"
  | "awaiting-plan-approval"
  | "conflicts"
  | "default";

export interface WorkspaceCardState {
  kind: WorkspaceCardStateKind;
  /** Border + background classes for the clickable workspace strip. */
  surfaceClass: string;
  /** Solid dot colour class. */
  dotClass: string;
  /** Whether the dot animates — reserved for states that are actually progressing. */
  pulse: boolean;
  /**
   * Text for the leading label, or null for the default state, which shows the branch name in
   * that slot instead.
   */
  label: string | null;
  /** Text colour for the label. */
  labelClass: string;
  /** Tooltip for the label (the gate's detail line); null when there is nothing to add. */
  labelTitle: string | null;
}

const SURFACE = {
  gateRunning: "border-sky-100 bg-sky-50 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-900/30",
  gateStalled: "border-red-100 bg-red-50 hover:bg-red-100 dark:border-red-800 dark:bg-red-900/30",
  reviewing: "border-accent-200 bg-accent-50 hover:bg-accent-100 dark:border-accent-700 dark:bg-accent-900/40",
  fixing: "border-orange-100 bg-orange-50 hover:bg-orange-100",
  awaitingPlan: "border-amber-200 bg-amber-50 hover:bg-amber-100",
  conflicts: "border-red-100 bg-red-50 hover:bg-red-100",
  default: "border-brand-100 bg-brand-50 hover:bg-brand-100 hover:border-brand-200",
} as const;

/** Dot colour for the default state, which is the only one that reads raw `status`. */
function defaultDotClass(status: string): string {
  if (status === "active") return "bg-green-500";
  if (status === "idle") return "bg-amber-500";
  return "bg-gray-400";
}

/** Pick the one state a workspace card leads with. Order is the contract — see the header. */
export function deriveWorkspaceCardState(main: WorkspaceMain): WorkspaceCardState {
  const gate = main.gateActivity;
  if (gate) {
    const stalled = gate.phase === "stalled";
    return {
      kind: "gate",
      surfaceClass: stalled ? SURFACE.gateStalled : SURFACE.gateRunning,
      dotClass: gateActivityDotClass(gate.phase),
      // A stalled gate must NOT pulse: a pulsing dot reads as "working", which is the one
      // thing that phase exists to report is not happening.
      pulse: !stalled,
      label: gate.label,
      labelClass: stalled ? "text-red-700 dark:text-red-300" : "text-sky-700 dark:text-sky-300",
      labelTitle: gate.detail,
    };
  }
  if (main.status === "reviewing") {
    return {
      kind: "reviewing",
      surfaceClass: SURFACE.reviewing,
      dotClass: "bg-accent-500",
      pulse: true,
      label: "AI Reviewing",
      labelClass: "text-accent-700 dark:text-accent-300",
      labelTitle: null,
    };
  }
  if (main.status === "fixing") {
    return {
      kind: "fixing",
      surfaceClass: SURFACE.fixing,
      dotClass: "bg-orange-500",
      pulse: true,
      label: "AI Fixing Conflicts",
      labelClass: "text-orange-700",
      labelTitle: null,
    };
  }
  if (main.status === "awaiting-plan-approval") {
    return {
      kind: "awaiting-plan-approval",
      surfaceClass: SURFACE.awaitingPlan,
      dotClass: "bg-amber-500",
      pulse: false,
      label: "Plan Awaiting Approval",
      labelClass: "text-amber-700",
      labelTitle: null,
    };
  }
  if (main.conflicts?.hasConflicts) {
    return {
      kind: "conflicts",
      surfaceClass: SURFACE.conflicts,
      dotClass: "bg-red-500",
      pulse: false,
      label: "Merge Conflicts",
      labelClass: "text-red-700",
      labelTitle: null,
    };
  }
  return {
    kind: "default",
    surfaceClass: SURFACE.default,
    dotClass: defaultDotClass(main.status),
    pulse: false,
    label: null,
    labelClass: "",
    labelTitle: null,
  };
}
