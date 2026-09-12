/**
 * The toolbar Autopilot chip's view model (#1102) — pure, so every label the chip can show is a
 * table of cheap cases rather than a rendered component.
 *
 * One glance answers the four questions that used to need the Monitor popover, the Strategy
 * Bullseye and Settings: is this project on autopilot, how many agents does it run against what
 * limit, will the NEXT cycle start anything (or what holds it), and will the result auto-merge.
 * The numbers come verbatim from `GET /api/projects/:id/autopilot`, which computes "+N next
 * cycle" with the monitor's own slot arithmetic — nothing here estimates.
 */
import type { AutopilotHoldReason, AutopilotStatusResponse } from "@agentic-kanban/shared/types";

export type AutopilotChipTone = "active" | "held" | "idle";

export interface AutopilotChipView {
  /** Filled dot for a driven project, hollow for manual. */
  dot: "●" | "○";
  modeLabel: "Autopilot" | "Manual" | "Conductor";
  /** Everything after the mode, in order: running, next cycle / hold, auto-merge. */
  segments: string[];
  /** The full one-line label: `● Autopilot · 2/4 running · +2 next cycle · auto-merge ✓`. */
  label: string;
  /** What fits a phone toolbar: `● 2/4`. */
  compactLabel: string;
  tone: AutopilotChipTone;
  /** Multi-line tooltip: the hold's remedy and the auto-merge source. */
  title: string;
}

const HOLD_LABEL: Record<AutopilotHoldReason, string> = {
  manual_mode: "manual",
  conductor_mode: "conductor drives",
  wip_full: "WIP full",
  machine_full: "machine full",
  start_cap: "start cap",
  gate_running: "gate running",
  no_worker: "no worker",
  no_ready_tickets: "nothing ready",
};

const HOLD_DETAIL: Record<AutopilotHoldReason, string> = {
  manual_mode: "Start Mode is manual: nothing starts on its own.",
  conductor_mode: "Start Mode is conductor: the out-of-process Conductor loop starts work, not the in-process monitor.",
  wip_full: "Every agent slot is in use. Raise Agents or wait for a ticket to land.",
  machine_full: "The machine has no headroom for another agent and no fleet worker can take it.",
  start_cap: "This cycle already started its maximum. Raise starts per cycle to widen the batch.",
  gate_running: "A verify gate holds the build semaphore, so new starts wait one cycle.",
  no_worker: "The project dispatches to fleet workers in strict mode and none has a free slot.",
  no_ready_tickets: "No Todo ticket passes the start gates (open workspace, dependencies, no-auto-start tag).",
};

const MERGE_DETAIL: Record<AutopilotStatusResponse["autoMerge"]["source"], string> = {
  enabled: "Reviewed work auto-merges.",
  project_disabled: "Auto-merge is switched off for this project.",
  global_off: "Auto-merge is off globally (Settings → Workflow).",
  direct_strategy: "Merge strategy is direct: a human merges.",
};

export function buildAutopilotChipView(status: AutopilotStatusResponse): AutopilotChipView {
  const modeLabel = status.startMode === "monitor" ? "Autopilot" : status.startMode === "conductor" ? "Conductor" : "Manual";
  const dot = status.startMode === "manual" ? "○" : "●";
  const driven = status.startMode !== "manual";

  const running = driven ? `${status.running}/${status.limit} running` : `${status.running} running`;
  const segments = [running];
  if (status.startMode === "monitor") {
    if (status.willStartNextCycle > 0) segments.push(`+${status.willStartNextCycle} next cycle`);
    else if (status.holdReason === "no_ready_tickets" || status.holdReason === null) segments.push("nothing ready");
    else segments.push(`holding: ${HOLD_LABEL[status.holdReason]}`);
  }
  segments.push(status.autoMerge.enabled ? "auto-merge ✓" : "auto-merge ✗");

  const held = status.startMode === "monitor" && status.willStartNextCycle === 0
    && status.holdReason !== null && status.holdReason !== "no_ready_tickets";
  const tone: AutopilotChipTone = !driven ? "idle" : held ? "held" : "active";

  const titleLines = [`${modeLabel}: ${running}${status.effectiveLimit < status.limit ? ` (machine headroom allows ${status.effectiveLimit})` : ""}.`];
  if (status.startMode === "monitor" && status.willStartNextCycle > 0) {
    titleLines.push(`Next cycle starts ${status.willStartNextCycle} of ${status.eligibleCount}${status.eligibleCountCapped ? "+" : ""} ready ticket(s).`);
  } else if (status.holdReason) {
    titleLines.push(HOLD_DETAIL[status.holdReason]);
  }
  titleLines.push(MERGE_DETAIL[status.autoMerge.source]);
  titleLines.push("Click for Start Mode, Agents and auto-merge.");

  return {
    dot,
    modeLabel,
    segments,
    label: [`${dot} ${modeLabel}`, ...segments].join(" · "),
    compactLabel: driven ? `${dot} ${status.running}/${status.limit}` : `${dot} ${status.running}`,
    tone,
    title: titleLines.join("\n"),
  };
}

/** Agents stepper bounds — the Bullseye clamps `activeAgentsTarget` to 1..32 on read. */
export const AGENTS_MIN = 1;
export const AGENTS_MAX = 32;
/** Starts-per-cycle stepper bounds. */
export const STARTS_MIN = 1;
export const STARTS_MAX = 10;

export function clampStep(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
