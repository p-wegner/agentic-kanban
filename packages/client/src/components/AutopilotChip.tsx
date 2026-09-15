import { useRef, useState, type ReactNode } from "react";
import { boardStrategyPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { patchStrategyBullseyeJson, type BullseyeTargetPatch } from "@agentic-kanban/shared/lib/strategy-bullseye-patch";
import type { AutopilotStatusResponse } from "@agentic-kanban/shared/types";
import type { AutopilotController } from "../hooks/useAutopilot.js";
import { useDismissable } from "../hooks/useDismissable.js";
import { apiPost } from "../lib/api.js";
import {
  AGENTS_MAX,
  AGENTS_MIN,
  STARTS_MAX,
  STARTS_MIN,
  buildAutopilotChipView,
  clampStep,
  type AutopilotChipTone,
} from "../lib/autopilotChip.js";
import type { StartMode } from "../lib/monitor-popover.js";
import { getSettings, setProjectPref, setSettings } from "../lib/settingsStore.js";
import { showToast } from "../lib/toast.js";
import { Icon } from "./Icon.js";

/**
 * The toolbar Autopilot chip (#1102): one glance for auto-start, the next cycle and auto-merge,
 * replacing the bare "Monitor" button. A click opens a compact panel with the four controls an
 * operator actually reaches for — Start Mode, Agents, auto-merge, starts per cycle — and a link
 * to the full Monitor popover for everything else.
 *
 * Agents and starts per cycle write the project's Strategy Bullseye (the one stored WIP since
 * #1102) through `patchStrategyBullseyeJson`, which keeps every other field of it.
 */

const START_MODES: { id: StartMode; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "Nothing starts on its own" },
  { id: "monitor", label: "Autopilot", hint: "The in-process monitor starts ready tickets up to Agents" },
  { id: "conductor", label: "Conductor", hint: "The out-of-process Conductor loop drives this project" },
];

const TONE_CLASSES: Record<AutopilotChipTone | "warning", string> = {
  warning: "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900",
  active: "bg-accent-50 dark:bg-accent-950 border-accent-200 dark:border-accent-800 text-accent-700 hover:bg-accent-100 dark:hover:bg-accent-900",
  held: "bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900",
  idle: "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800",
};

const WARNING_ICON = "M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z";

const STEP_BUTTON = "w-6 h-6 rounded border border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark text-ink dark:text-gray-200 hover:bg-surface-sunken dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed";

export interface AutopilotChipProps {
  projectId: string | null;
  autopilot: AutopilotController | undefined;
  /** The monitor's warning summary for THIS project, or null — turns the chip red (#637). */
  warningTitle: string | null;
  /** Which monitor mechanisms are running, appended to the tooltip. */
  mechanismsTitle: string;
  /** The running-mechanism dots/badge, shown in front of the label. */
  indicator?: ReactNode;
  /** Whether this project has an out-of-process Conductor loop to start/stop with the mode. */
  orchestratorAvailable: boolean;
  /** The in-process monitor's next cycle, when it has one armed. */
  nextRunAt: string | null;
  onOpenFullMonitor: () => void;
}

export function AutopilotChip(props: AutopilotChipProps) {
  const { autopilot, warningTitle, mechanismsTitle, indicator } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissable(wrapRef, open, () => setOpen(false));

  const status = autopilot?.status ?? null;
  const view = status ? buildAutopilotChipView(status) : null;
  const tone = warningTitle ? "warning" : view?.tone ?? "idle";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        data-testid="autopilot-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={[warningTitle, view?.title, mechanismsTitle].filter(Boolean).join("\n\n")}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap ${TONE_CLASSES[tone]}`}
      >
        {warningTitle ? <Icon className="w-3 h-3 shrink-0" strokeWidth={2.5} d={WARNING_ICON} /> : indicator}
        {view ? (
          <>
            <span className="sm:hidden">{view.compactLabel}</span>
            <span className="hidden sm:inline">{view.label}</span>
          </>
        ) : (
          <span>Autopilot</span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Autopilot"
          data-testid="autopilot-panel"
          className="fixed inset-x-2 bottom-2 z-50 max-h-[75vh] overflow-y-auto sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:mt-1 sm:max-h-none sm:overflow-visible sm:w-[19rem] rounded-xl border border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark shadow-lg p-3 space-y-3 text-xs text-ink dark:text-gray-200"
        >
          {status ? (
            <AutopilotPanelBody {...props} status={status} />
          ) : (
            <div className="text-ink-faint dark:text-gray-500">{autopilot?.error ?? "Loading autopilot status…"}</div>
          )}
          <div className="pt-2 border-t border-black/[0.06] dark:border-white/10 flex justify-end">
            <button
              type="button"
              onClick={() => { setOpen(false); props.onOpenFullMonitor(); }}
              className="text-[11px] font-medium text-accent-700 dark:text-accent-400 hover:underline"
            >
              Full monitor…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AutopilotPanelBody({ projectId, autopilot, orchestratorAvailable, nextRunAt, status }: AutopilotChipProps & { status: AutopilotStatusResponse }) {
  const [saving, setSaving] = useState(false);

  async function save(action: (id: string) => Promise<unknown>, failure: string) {
    if (!projectId || saving) return;
    setSaving(true);
    try {
      await action(projectId);
      await autopilot?.refresh();
    } catch (err) {
      showToast(`${failure}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSaving(false);
    }
  }

  const selectStartMode = (mode: StartMode) => save(async (id) => {
    await setProjectPref(id, "start_mode", mode);
    // Same coupling as the Monitor popover: the Conductor loop follows the mode where one exists.
    if (orchestratorAvailable) {
      await apiPost(`/api/projects/${id}/conductor`, { action: mode === "conductor" ? "start" : "stop" }).catch(() => {});
    }
  }, "Failed to change Start Mode");

  const patchBullseye = (patch: BullseyeTargetPatch) => save(async (id) => {
    const key = boardStrategyPref.key(id);
    const settings = await getSettings();
    // Minting a Bullseye pins the numbers the monitor runs at now, so only the stepped one changes.
    const result = patchStrategyBullseyeJson(settings[key], patch, {
      activeAgentsTarget: status.limit,
      backlogFloor: status.backlogFloor,
      maxNewStartsPerCycle: status.startsPerCycle,
    });
    if (!result.ok) throw new Error("the Strategy Bullseye is not valid JSON — fix it in Strategy Targets first");
    await setSettings({ [key]: result.value });
  }, "Failed to save the Strategy Bullseye");

  const setAutoMerge = (enabled: boolean) =>
    save((id) => setProjectPref(id, "auto_merge_disabled", enabled ? "false" : "true"), "Failed to change auto-merge");

  return (
    <>
      <StartModeControl value={status.startMode} disabled={saving} onSelect={(m) => void selectStartMode(m)} />
      <Stepper
        label="Agents"
        hint={agentsHint(status)}
        value={status.limit}
        min={AGENTS_MIN}
        max={AGENTS_MAX}
        disabled={saving}
        testId="autopilot-agents"
        onChange={(n) => void patchBullseye({ activeAgentsTarget: n })}
      />
      <AutoMergeControl status={status} disabled={saving} onChange={(enabled) => void setAutoMerge(enabled)} />
      <details className="group">
        <summary className="cursor-pointer select-none text-[11px] text-ink-soft dark:text-gray-400">Advanced</summary>
        <div className="mt-2">
          <Stepper
            label="Starts per cycle"
            hint="New workspaces one monitor cycle may launch"
            value={status.startsPerCycle}
            min={STARTS_MIN}
            max={STARTS_MAX}
            disabled={saving}
            testId="autopilot-starts"
            onChange={(n) => void patchBullseye({ maxNewStartsPerCycle: n })}
          />
        </div>
      </details>
      <div className="text-[11px] text-ink-soft dark:text-gray-400" data-testid="autopilot-next-cycle">{nextCycleLine(status, nextRunAt)}</div>
    </>
  );
}

function agentsHint(status: AutopilotStatusResponse): string {
  // "WIP", never "running": the header's agents chip owns that word (#1162).
  const parts = [`WIP ${status.running} of ${status.limit} used`];
  if (status.effectiveLimit < status.limit) parts.push(`machine allows ${status.effectiveLimit}`);
  if (!status.limitConfigured) parts.push("default");
  return parts.join(" · ");
}

function nextCycleLine(status: AutopilotStatusResponse, nextRunAt: string | null): string {
  if (status.startMode !== "monitor") return status.startMode === "manual" ? "Manual: nothing starts on its own." : "The Conductor loop decides what starts.";
  const view = buildAutopilotChipView(status);
  const when = nextRunAt ? ` (${formatUntil(nextRunAt)})` : "";
  return `Next cycle${when}: ${view.segments[1] ?? "nothing ready"}`;
}

function formatUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "due now";
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? "in <1m" : `in ${minutes}m`;
}

function StartModeControl({ value, disabled, onSelect }: { value: StartMode; disabled: boolean; onSelect: (mode: StartMode) => void }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint dark:text-gray-500">Start Mode</div>
      <div role="radiogroup" aria-label="Start Mode" className="grid grid-cols-3 gap-1">
        {START_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="radio"
            aria-checked={value === mode.id}
            title={mode.hint}
            disabled={disabled}
            onClick={() => { if (value !== mode.id) onSelect(mode.id); }}
            className={`px-1.5 py-1 rounded-md border text-[11px] font-medium transition-colors disabled:opacity-50 ${
              value === mode.id
                ? "bg-accent-600 border-accent-600 text-white"
                : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Stepper({ label, hint, value, min, max, disabled, testId, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number; disabled: boolean; testId: string; onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-[10px] text-ink-faint dark:text-gray-500 truncate">{hint}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0" data-testid={testId}>
        <button type="button" aria-label={`Decrease ${label}`} className={STEP_BUTTON} disabled={disabled || value <= min} onClick={() => onChange(clampStep(value - 1, min, max))}>−</button>
        <span className="w-6 text-center font-mono tabular-nums" aria-live="polite">{value}</span>
        <button type="button" aria-label={`Increase ${label}`} className={STEP_BUTTON} disabled={disabled || value >= max} onClick={() => onChange(clampStep(value + 1, min, max))}>+</button>
      </div>
    </div>
  );
}

function AutoMergeControl({ status, disabled, onChange }: { status: AutopilotStatusResponse; disabled: boolean; onChange: (enabled: boolean) => void }) {
  const { source } = status.autoMerge;
  const projectAllows = source !== "project_disabled";
  // The per-project switch can only turn auto-merge OFF on top of the global answer.
  const blockedElsewhere = source === "global_off" || source === "direct_strategy";
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">Auto-merge</div>
        <button
          type="button"
          role="switch"
          aria-checked={status.autoMerge.enabled}
          aria-label="Auto-merge for this project"
          data-testid="autopilot-auto-merge"
          disabled={disabled || (blockedElsewhere && projectAllows)}
          onClick={() => onChange(!projectAllows)}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${status.autoMerge.enabled ? "bg-emerald-500" : "bg-gray-200 dark:bg-gray-600"}`}
        >
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${status.autoMerge.enabled ? "translate-x-[1.125rem]" : "translate-x-0.5"}`} />
        </button>
      </div>
      {blockedElsewhere && (
        <div className="mt-0.5 text-[10px] text-ink-faint dark:text-gray-500">
          {source === "global_off" ? "Off globally — Settings → Workflow → Auto-merge." : "Merge strategy is direct: a human merges."}
        </div>
      )}
    </div>
  );
}
