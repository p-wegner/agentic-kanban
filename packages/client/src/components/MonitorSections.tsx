import { useEffect, useState } from "react";
import { apiFetch, apiPut } from "../lib/api.js";
import type { OrchestratorStatus } from "../hooks/useOrchestrator.js";
import { parseCycleLine } from "../lib/monitor-popover.js";
import type { BoardHealthEvent, ConductorSchedule } from "../lib/monitor-popover.js";

export function SubToggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-gray-600 dark:text-gray-300">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-emerald-500" : "bg-gray-200 dark:bg-gray-600"}`}
        title={checked ? "On" : "Off"}
      >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[0.875rem]" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

// Cron schedule for the off-process Conductor (ticket #841). Self-contained: fetches and
// writes /api/projects/:id/conductor-schedule itself so it needs no props threaded through
// BoardPage. Drives one off-process board-monitor cycle per scheduled tick (independent of
// the always-on loop), and tracks the next/last fire so the user can see it ran.
export function ConductorCronSection({
  projectId,
  formatAge,
  formatCountdown,
}: {
  projectId: string;
  formatAge: (isoStr: string) => string;
  formatCountdown: (isoStr: string) => string;
}) {
  const [schedule, setSchedule] = useState<ConductorSchedule | null>(null);
  const [cronInput, setCronInput] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<{ available: boolean; schedule: ConductorSchedule }>(`/api/projects/${projectId}/conductor-schedule`);
      setSchedule(data.schedule);
      setCronInput(data.schedule.cron);
      setAgent(data.schedule.agent);
    } catch { /* leave prior state */ }
  }

  useEffect(() => { void load(); }, [projectId]);

  async function save(patch: { enabled?: boolean; cron?: string; agent?: "claude" | "codex" }) {
    setSaving(true);
    setError(null);
    try {
      const data = await apiPut<{ schedule: ConductorSchedule }>(`/api/projects/${projectId}/conductor-schedule`, patch);
      setSchedule(data.schedule);
      setCronInput(data.schedule.cron);
      setAgent(data.schedule.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save schedule");
    } finally {
      setSaving(false);
    }
  }

  const enabled = schedule?.enabled ?? false;
  // Cheap client-side shape check (5 or 6 whitespace-separated fields) so a typo gets
  // immediate feedback instead of waiting for the blur → server round-trip to reject it.
  const trimmedCron = cronInput.trim();
  const cronShapeInvalid = trimmedCron.length > 0 && ![5, 6].includes(trimmedCron.split(/\s+/).length);

  return (
    <div className="rounded-md bg-gray-50 dark:bg-gray-950 px-2 py-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Cron schedule</span>
        <SubToggle
          label=""
          checked={enabled}
          disabled={saving || (!enabled && (!cronInput.trim() || cronShapeInvalid))}
          onChange={(v) => save({ enabled: v, cron: cronInput.trim() })}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={cronInput}
          placeholder="*/30 * * * *"
          spellCheck={false}
          onChange={(e) => setCronInput(e.target.value)}
          onBlur={() => { if (!cronShapeInvalid && cronInput.trim() !== (schedule?.cron ?? "")) void save({ cron: cronInput.trim() }); }}
          className={`flex-1 min-w-0 font-mono text-[11px] border rounded-md px-2 py-1 focus:outline-none focus:ring-1 bg-white dark:bg-gray-900 ${cronShapeInvalid ? "border-red-300 dark:border-red-700 focus:ring-red-400" : "border-gray-200 dark:border-gray-700 focus:ring-emerald-400"}`}
        />
        <select
          value={agent}
          disabled={saving}
          onChange={(e) => { const a = e.target.value as "claude" | "codex"; setAgent(a); void save({ agent: a }); }}
          className="text-[11px] border border-gray-200 dark:border-gray-700 rounded-md px-1 py-1 bg-white dark:bg-gray-900"
        >
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
      </div>
      {cronShapeInvalid && <p className="text-[10px] text-red-600 dark:text-red-400 leading-snug">Cron needs 5 fields (min hour day month weekday), e.g. <span className="font-mono">*/30 * * * *</span>.</p>}
      {error && <p className="text-[10px] text-red-600 dark:text-red-400 leading-snug">{error}</p>}
      {schedule?.cron && schedule.error && !error && (
        <p className="text-[10px] text-red-600 dark:text-red-400 leading-snug">{schedule.error}</p>
      )}
      {schedule?.valid && schedule.description && (
        <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-snug">{schedule.description}</p>
      )}
      {enabled && schedule?.nextFireAt && (
        <div className="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
          <span>Next fire</span>
          <span className="font-mono">in {formatCountdown(schedule.nextFireAt)}</span>
        </div>
      )}
      {schedule?.lastFiredAt && (
        <div className="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
          <span>Last fired</span>
          <span className="font-mono">{formatAge(schedule.lastFiredAt)}</span>
        </div>
      )}
      <p className="text-[9px] text-gray-400 dark:text-gray-500 leading-snug">Fires one off-process board-monitor cycle per tick (skipped while the loop is already running).</p>
    </div>
  );
}

export function PolicyRow({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={on ? "text-emerald-600 dark:text-emerald-400" : "text-gray-300 dark:text-gray-600"}>{on ? "✓" : "✕"}</span>
      <span className={`text-[10px] ${on ? "text-gray-600 dark:text-gray-300" : "text-gray-400 dark:text-gray-500"}`}>{label}</span>
    </div>
  );
}

export function MonitorStatusDots({ autoMonitor, butlerEnabled }: { autoMonitor: boolean; butlerEnabled: boolean }) {
  if (!autoMonitor && !butlerEnabled) {
    return <div className="w-2 h-2 rounded-full shrink-0 bg-gray-300 dark:bg-gray-600" />;
  }
  return (
    <div className="flex items-center gap-0.5">
      {autoMonitor && <span className="w-2 h-2 rounded-full shrink-0 bg-green-500 animate-pulse" title="Auto-monitor" />}
      {butlerEnabled && <span className="w-2 h-2 rounded-full shrink-0 bg-violet-500 animate-pulse" title="Monitor Butler" />}
    </div>
  );
}

export function MonitorButlerSection({
  enabled,
  intervalMin,
}: {
  enabled: boolean;
  intervalMin: number;
}) {
  return (
    <div className={`px-3 py-2.5 border-b border-gray-100 dark:border-gray-800 ${enabled ? "bg-violet-50/40 dark:bg-violet-950/20" : ""}`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${enabled ? "bg-violet-500 animate-pulse" : "bg-gray-300 dark:bg-gray-600"}`}
            title={enabled ? "Monitor Butler active" : "Monitor Butler disabled"}
          />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">Monitor Butler</span>
        </div>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${enabled ? "bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300" : "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"}`}>
          {enabled ? `every ${intervalMin}m` : "off"}
        </span>
      </div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
        {enabled
          ? "LLM-driven monitor — reads objective.md and runs a fresh agent session on schedule."
          : "LLM-driven monitor is off. Enable via Settings → Workflow → Board Monitoring."}
      </div>
    </div>
  );
}

export function OrchestratorSection({
  orchestrator,
  notify,
  onNotifyChange,
  formatAge,
}: {
  orchestrator: OrchestratorStatus;
  notify: boolean;
  onNotifyChange?: (v: boolean) => void;
  formatAge: (isoStr: string) => string;
}) {
  const cycles = [...orchestrator.recentCycles].reverse(); // newest first
  const hitCap = orchestrator.lastExit === 124;
  const dead = !orchestrator.alive;

  return (
    <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800 bg-indigo-50/40 dark:bg-indigo-950/20">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${dead ? "bg-red-500" : orchestrator.phase === "running" ? "bg-green-500 animate-pulse" : "bg-emerald-400"}`}
            title={dead ? "Loop not running" : orchestrator.phase === "running" ? "Cycle in progress" : "Idle between cycles"}
          />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">Orchestrator loop</span>
        </div>
        {onNotifyChange && (
          <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Desktop notification on noteworthy cycles (merges, flags, loop death)">
            <span className="text-[10px] text-gray-500 dark:text-gray-400">Notify</span>
            <button
              type="button"
              onClick={() => onNotifyChange(!notify)}
              className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${notify ? "bg-indigo-500" : "bg-gray-200 dark:bg-gray-600"}`}
            >
              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${notify ? "translate-x-3.5" : "translate-x-0.5"}`} />
            </button>
          </label>
        )}
      </div>

      {/* Status line */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px]">
        <span className={`font-medium ${dead ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>
          {dead ? "Not running" : orchestrator.phase === "running" ? `Cycle ${orchestrator.iteration ?? "?"} running` : `Idle (after cycle ${orchestrator.iteration ?? "?"})`}
        </span>
        {orchestrator.lastLogAt && (
          <span className="text-gray-400 dark:text-gray-500 font-mono text-[10px]">· {formatAge(orchestrator.lastLogAt)}</span>
        )}
        {hitCap && (
          <span className="px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-[10px] font-medium" title="Last cycle hit the 30-minute cap (usually babysitting a long merge)">hit 30m cap</span>
        )}
      </div>

      {/* Recent cycles (from state.md) */}
      {cycles.length === 0 ? (
        <div className="text-gray-400 dark:text-gray-500 text-[11px]">No cycles recorded yet</div>
      ) : (
        <div className="space-y-1">
          {cycles.map((line, i) => {
            const { age, text } = parseCycleLine(line);
            return (
              <div key={i} className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 rounded-full bg-indigo-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-gray-700 dark:text-gray-300 text-[11px] leading-snug line-clamp-2">{text}</div>
                  {age && <div className="text-gray-400 dark:text-gray-500 text-[10px] font-mono">{formatAge(age)}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RecentBoardHealthEventsSection({
  events,
  loading,
  error,
  formatAge,
  onViewAll,
  projectId,
  onOpenReplay,
}: {
  events: BoardHealthEvent[];
  loading: boolean;
  error: string | null;
  formatAge: (isoStr: string) => string;
  onViewAll?: () => void;
  projectId?: string | null;
  onOpenReplay?: (event: BoardHealthEvent) => void;
}) {
  return (
    <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Recent events</div>
        {onViewAll && (
          <button
            onClick={onViewAll}
            className="text-[10px] text-brand-600 dark:text-brand-400 hover:underline"
          >
            View all
          </button>
        )}
      </div>
      {loading ? (
        <div className="text-gray-400 dark:text-gray-500 text-[11px]">Loading events...</div>
      ) : error ? (
        <div className="text-red-600 dark:text-red-400 text-[11px] leading-snug">{error}</div>
      ) : events.length === 0 ? (
        <div className="text-gray-400 dark:text-gray-500 text-[11px]">No board health events yet</div>
      ) : (
        <div className="space-y-1.5">
          {events.map((event) => (
            <div
              key={event.id}
              className={`flex items-start gap-2 group ${projectId && onOpenReplay ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-md px-1 -mx-1 py-0.5 transition-colors" : ""}`}
              onClick={projectId && onOpenReplay ? () => onOpenReplay(event) : undefined}
            >
              <span
                className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${event.level === "error" ? "bg-red-500" : "bg-sky-400"}`}
                title={event.type}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className={`font-semibold text-[10px] uppercase ${event.level === "error" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}>
                    {event.type.replace(/_/g, " ")}
                  </span>
                  <span className="text-gray-400 dark:text-gray-500 shrink-0 text-[10px] font-mono">{formatAge(event.timestamp)}</span>
                </div>
                <div className="text-gray-700 dark:text-gray-300 text-[11px] leading-snug line-clamp-2">{event.summary}</div>
                {event.details && (
                  <div className="text-gray-400 dark:text-gray-500 text-[10px] leading-snug truncate" title={event.details}>{event.details}</div>
                )}
              </div>
              {projectId && onOpenReplay && (
                <svg className="w-2.5 h-2.5 text-gray-300 dark:text-gray-600 group-hover:text-gray-500 dark:group-hover:text-gray-400 shrink-0 mt-1 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                </svg>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
