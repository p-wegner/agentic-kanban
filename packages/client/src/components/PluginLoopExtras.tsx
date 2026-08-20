import { useState } from "react";
import { showToast } from "../lib/toast.js";
import { apiPost } from "../lib/api.js";
import { ProgressStepper, stepCost, type LoopUnitCost } from "./ProgressStepper.js";
import { GateCard, formatGateAge, splitGateQuestion } from "./GateCard.js";
import {
  ArtifactViewer,
  detectGateBookkeeping,
  findMatchingLines,
  parseMarkdownOutline,
  segmentArtifact,
  slugifyHeading,
  splitHighlight,
  type ArtifactSegment,
  type GateBookkeepingBlock,
  type GateBookkeepingItem,
  type MarkdownHeading,
} from "./ArtifactViewer.js";
import {
  LoopTimeline,
  collapseTimelineEvents,
  timelineCategory,
  type LoopEvent,
  type TimelineCategory,
  type TimelineRow,
} from "./LoopTimeline.js";

export { ProgressStepper, stepCost, type LoopUnitCost };
export { GateCard, formatGateAge, splitGateQuestion };
export {
  ArtifactViewer,
  detectGateBookkeeping,
  findMatchingLines,
  parseMarkdownOutline,
  segmentArtifact,
  slugifyHeading,
  splitHighlight,
  type ArtifactSegment,
  type GateBookkeepingBlock,
  type GateBookkeepingItem,
  type MarkdownHeading,
};
export {
  LoopTimeline,
  collapseTimelineEvents,
  timelineCategory,
  type LoopEvent,
  type TimelineCategory,
  type TimelineRow,
};

/**
 * The loop pane's structured extras (#286–#294): approval gate card, pipeline
 * stepper, check badges, artifact viewer, and the audit timeline. Split out of
 * PluginActionPanes so that file stays under the god-module ceiling and each
 * concern here is independently testable.
 *
 * #465 — GateCard, ArtifactViewer and LoopTimeline were each split into their own file (this
 * file was 1942 lines / 24 top-level fns); this file now re-exports them so every existing
 * import of `./PluginLoopExtras.js` keeps resolving unchanged (mirrors the ProgressStepper
 * split already done for #464).
 */

// #694 — declared in `lib/pluginLoopTypes.ts` and re-exported here so every existing
// `from "./PluginLoopExtras.js"` import keeps resolving. `lib/gateCardPolicy.ts` needs these
// three, and a lib module importing from components is the upward type-only edge
// `9d9cce93be` removed and HEAD had reintroduced.
import type { PluginGateAction, PluginGate, PluginCheck } from "../lib/pluginLoopTypes.js";
// Imported AND re-exported: this module still renders with them (`ChecksBadges`), and a bare
// `export type { … } from` would re-export without binding the names locally.
export type { PluginGateAction, PluginGate, PluginCheck };
export type PluginProgressStep = {
  id: string;
  label: string;
  // "planned"/"stalled" (#479/#481) are the board's own reconciliation of a planner's
  // "generating" claim against the ticket's real workspace state — see `reconcileProgressStepStates`
  // in packages/server/src/services/plugin-loop-step-state.ts.
  state: "done" | "generating" | "awaiting-approval" | "needs-revision" | "locked" | "failed" | "pending"
    | "planned" | "stalled";
  version?: string;
  artifacts?: string[];
  /**
   * The board ticket this step resolved to (#481), attached server-side by
   * `reconcileProgressStepStates` and present only on the DOWNGRADED states — the two where
   * the user has to act. Mirrors `PluginLoopProgressStep` in shared.
   */
  ticket?: { issueId: string; issueNumber: number | null };
};
export type StartPolicy = { mode: string; autoStartUnblocked: boolean } | null;

/**
 * The loop's "work exists but nothing landed it" state (#299/#336/#363).
 *
 * `mergeSafe` is load-bearing, not decoration: on #363's live stall the parked branch had ZERO
 * commits, so a one-click Merge would have closed the unit without its artifacts. Read it before
 * offering the button.
 */
export type LoopStall = {
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string;
  reason?: "builder-finished-unmerged" | "workspace-parked-issue-unfinished" | "unit-already-landed"
    | "workspace-closed-unmerged";
  mergeSafe?: boolean;
  detail?: string;
  since?: string;
  contradictoryReadyFlag?: boolean;
};

// ── State chips (#293) ────────────────────────────────────────────────

/** Why the loop planned nothing — four look-alike states, told apart explicitly. */
export function LoopStateChips({ loop, startPolicy, onSwitchToMonitor, switchingMode = false }: {
  loop: {
    paused: boolean; converged: boolean; openTickets: number;
    gate: PluginGate | null; note: string | null; closedTickets: number;
    awaitingMerge?: LoopStall | null;
  };
  startPolicy: StartPolicy;
  /**
   * One-click fix for the manual-Start-Mode chip (#428). The chip is the PERSISTENT statement
   * of the problem — the advance result carries the same warning but only on the advance that
   * actually creates tickets, so it is gone the moment you navigate away while the loop stays
   * stuck. The remedy belongs next to the durable signal, not the transient one.
   */
  onSwitchToMonitor?: () => void;
  switchingMode?: boolean;
}) {
  const chips: Array<{ text: string; tone: "gray" | "amber" | "green" | "blue" | "red" }> = [];
  if (loop.paused) chips.push({ text: "Paused", tone: "amber" });
  // #363: two different stalls reach this field now, and calling the parked one "step done"
  // is the misreport the ticket was filed for — that workspace's ticket never finished and its
  // branch may hold nothing at all.
  if (loop.awaitingMerge) {
    // #337: three states reach this field. Calling an ALREADY-LANDED leftover "waiting for merge"
    // is the misreport that ticket was filed for — the operator docs map that wording to "click
    // Merge now", which on already-merged work is the wrong action.
    chips.push(loop.awaitingMerge.reason === "unit-already-landed"
      ? { text: "Step landed — leftover workspace closing", tone: "gray" }
      // #445: a workspace that CLOSED unmerged is a third failure, and calling it "parked" would
      // suggest something is still holding it. Nothing is — the ticket can no longer finish.
      : loop.awaitingMerge.reason === "workspace-closed-unmerged"
        ? { text: "Step stranded — workspace closed without merging", tone: "red" }
        : loop.awaitingMerge.mergeSafe === false
          ? { text: "Step parked — ticket never finished", tone: "red" }
          : { text: "Step done — waiting for merge", tone: "amber" });
  }
  else if (loop.openTickets > 0) chips.push({ text: "Round running", tone: "blue" });
  else if (loop.converged) chips.push({ text: "Converged", tone: "green" });
  else if (loop.gate) chips.push({ text: "Waiting on you", tone: "amber" });
  else if (loop.note && loop.closedTickets + loop.openTickets > 0) chips.push({ text: "Waiting on input", tone: "amber" });
  // The worst trap: under manual start mode the monitor never runs the planner, which is
  // indistinguishable from convergence unless somebody says so.
  if (startPolicy && startPolicy.mode === "manual" && !loop.converged) {
    chips.push({ text: "Start mode is Manual — the monitor will not drive this loop", tone: "red" });
  }
  if (chips.length === 0) return null;
  const toneClass = {
    gray: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    green: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  } as const;
  const manualChip = startPolicy?.mode === "manual" && !loop.converged;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-loop-state-chips">
      {chips.map((chip) => (
        <span key={chip.text} className={`text-[11px] px-2 py-0.5 rounded ${toneClass[chip.tone]}`}>
          {chip.text}
        </span>
      ))}
      {manualChip && onSwitchToMonitor && (
        <button
          type="button"
          onClick={onSwitchToMonitor}
          disabled={switchingMode}
          data-testid="plugin-loop-switch-start-mode"
          title="Set this project's Start Mode to monitor so the board starts this loop's tickets"
          className="text-[11px] px-2 py-0.5 rounded border border-red-300 dark:border-red-700 text-red-800 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
        >
          {switchingMode ? "Switching…" : "Switch to monitor"}
        </button>
      )}
    </div>
  );
}

// ── Check badges (#290) ───────────────────────────────────────────────

export function ChecksBadges({ checks }: { checks: PluginCheck[] | null }) {
  if (!checks || checks.length === 0) return null;
  const tone = {
    pass: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    fail: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  } as const;
  const mark = { pass: "✓", warn: "⚠", fail: "✕" } as const;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-loop-checks">
      {checks.map((check) => (
        <span
          key={check.name}
          title={check.detail ?? check.name}
          className={`text-[11px] px-2 py-0.5 rounded cursor-default ${tone[check.verdict]}`}
        >
          {mark[check.verdict]} {check.name}
        </span>
      ))}
    </div>
  );
}

// ── Awaiting-merge card (#299) ───────────────────────────────────────

/**
 * The loop's silent-stall state, made loud: the step's agent finished but the
 * workspace never landed, so the planner (reading the MAIN checkout) is blind
 * and every advance is a dedupe no-op. One click triggers the board merge; the
 * merge-to-advance hook (#298) then surfaces the gate on its own.
 *
 * #363 added a SECOND stall to the same field — a workspace parked `ready_for_merge` whose
 * issue never left In Progress — and it must NOT get the merge button. The live instance's
 * branch had zero commits; merging it would close the unit without its artifacts and deadlock
 * the loop, which is the outcome `exit-workflow.ts` already refuses by name. So when
 * `mergeSafe === false` this card reports and links, and does not offer to land anything.
 */
export function AwaitingMergeCard({ awaitingMerge, onMergeStarted }: {
  awaitingMerge: LoopStall;
  onMergeStarted: () => void;
}) {
  const [merging, setMerging] = useState(false);
  async function merge() {
    if (merging) return;
    setMerging(true);
    try {
      await apiPost(`/api/workspaces/${awaitingMerge.workspaceId}/merge?async=1`, {});
      showToast("Merge started — the loop advances automatically once it lands", "success");
      // Give the async merge a moment to land before the surface refetch.
      setTimeout(onMergeStarted, 8000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Merge failed to start", "error");
      setMerging(false);
    }
  }
  // #337 — an already-landed leftover is neither "parked" (nothing is wrong) nor mergeable
  // (the work is already on the base branch). It gets its own, calm copy: the previous wording
  // told the operator to click Merge now on a step whose merge commit was already on master.
  const landed = awaitingMerge.reason === "unit-already-landed";
  const stranded = awaitingMerge.reason === "workspace-closed-unmerged";
  const parked = !landed && awaitingMerge.mergeSafe === false;
  const ref = awaitingMerge.issueNumber != null ? `#${awaitingMerge.issueNumber} ` : "";
  return (
    <div
      className={parked
        ? "rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 max-w-2xl flex items-center gap-3"
        : landed
          ? "rounded border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-3 max-w-2xl flex items-center gap-3"
          : "rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 max-w-2xl flex items-center gap-3"}
      data-testid="plugin-loop-awaiting-merge"
      data-stall-reason={awaitingMerge.reason ?? "builder-finished-unmerged"}
    >
      <div className={parked
        ? "flex-1 text-xs text-red-900 dark:text-red-200"
        : landed
          ? "flex-1 text-xs text-gray-700 dark:text-gray-300"
          : "flex-1 text-xs text-amber-900 dark:text-amber-200"}>
        <span className="font-medium">
          {stranded
            ? "Step stranded, workspace closed without merging:"
            : parked
            ? "Step parked, ticket never finished:"
            : landed
              ? "Step already landed — nothing to merge:"
              : "Step finished but not landed:"}
        </span>{" "}
        {ref}{awaitingMerge.issueTitle}.
        {" "}{awaitingMerge.detail ?? "Until the merge lands, the planner cannot see the artifacts."}
        {awaitingMerge.contradictoryReadyFlag && (
          <>{" "}<span className="font-medium">
            The workspace also reports ready_for_merge and readyForMerge=false at the same time — treat both as unreliable.
          </span></>
        )}
      </div>
      {parked ? (
        <a
          href={`/workspaces/${awaitingMerge.workspaceId}`}
          className="text-sm px-3 py-1.5 rounded border border-red-400 dark:border-red-600 text-red-800 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40 shrink-0"
          data-testid="plugin-loop-inspect-stall"
        >
          Inspect workspace
        </a>
      ) : landed ? (
        <a
          href={`/workspaces/${awaitingMerge.workspaceId}`}
          className="text-sm px-3 py-1.5 rounded border border-gray-400 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 shrink-0"
          data-testid="plugin-loop-inspect-stall"
        >
          Inspect workspace
        </a>
      ) : (
        <button
          onClick={() => void merge()}
          disabled={merging}
          className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 shrink-0"
          data-testid="plugin-loop-merge-now"
        >
          {merging ? "Merging…" : "Merge now"}
        </button>
      )}
    </div>
  );
}
