import { useMemo, useState, type ReactElement } from "react";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import {
  WORKER_RESTART_SETTING_KEYS,
  type WorkerSettingKey,
  type WorkerSettingsEnvelope,
  type WorkerSettingsReport,
} from "@agentic-kanban/shared/lib/worker-settings";
import { saveWorkerSettings } from "../hooks/useWorkerFleetQueries.js";
import { formFromWorker, pinnedNote, settingsFromForm, type WorkerSettingsFormState } from "../lib/workerSettingsForm.js";

export interface WorkerSettingsPanelProps {
  workerId: string;
  maxConcurrency: number;
  labels: string[];
  providers: string[];
  desiredSettings?: WorkerSettingsEnvelope;
  settingsReport?: WorkerSettingsReport;
  projects: Array<{ id: string; name: string }>;
  onSaved: () => void;
}

const INPUT = "w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs disabled:opacity-50";

/**
 * Per-worker settings (#1381): edited here, stored on the board, pushed to the worker in its
 * heartbeat response. A key the worker's own `start` flag pins is shown read-only.
 */
export function WorkerSettingsPanel(props: WorkerSettingsPanelProps) {
  const { workerId, desiredSettings, settingsReport, projects } = props;
  const pinned: WorkerSettingKey[] = settingsReport?.pinned ?? [];
  const [form, setForm] = useState<WorkerSettingsFormState>(() => formFromWorker(desiredSettings?.settings, props));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = desiredSettings !== undefined && settingsReport?.appliedRev !== desiredSettings.rev;
  const set = <K extends keyof WorkerSettingsFormState>(key: K, value: WorkerSettingsFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const projectOptions = useMemo(() => projects.map((p) => (
    <option key={p.id} value={p.id}>{p.name}</option>
  )), [projects]);

  const field = (key: WorkerSettingKey, label: string, control: (disabled: boolean) => ReactElement) => {
    const note = pinnedNote(key, pinned);
    return (
      <label className="block text-xs text-gray-600 dark:text-gray-300">
        <span className="mb-0.5 flex items-center gap-1.5">
          {label}
          {note && <span className="rounded bg-amber-100 px-1 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" title={note}>pinned by flag</span>}
          {WORKER_RESTART_SETTING_KEYS.includes(key) && !note && <span className="text-gray-400">applies on worker restart</span>}
        </span>
        {control(note !== null)}
      </label>
    );
  };

  const multi = (key: "allowedProjects" | "deniedProjects") => (disabled: boolean) => (
    <select
      multiple
      disabled={disabled}
      className={INPUT}
      value={form[key]}
      onChange={(e) => set(key, [...e.target.selectedOptions].map((o) => o.value))}
    >
      {projectOptions}
    </select>
  );

  const save = async () => {
    const parsed = settingsFromForm(form);
    if ("error" in parsed) { setError(parsed.error); return; }
    setSaving(true);
    setError(null);
    try {
      await saveWorkerSettings(workerId, parsed.settings);
      props.onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded border border-gray-200 dark:border-gray-700 p-3" data-testid="worker-settings-panel">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-200">
        Settings
        {pending && <span className="rounded bg-blue-100 px-1.5 py-0.5 font-normal text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">waiting for the worker to apply</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {field("maxConcurrency", "Max concurrency", (d) => (
          <input type="number" min={1} max={64} disabled={d} className={INPUT} value={form.maxConcurrency} onChange={(e) => set("maxConcurrency", e.target.value)} />
        ))}
        {field("labels", "Labels (comma separated)", (d) => (
          <input disabled={d} className={INPUT} value={form.labels} onChange={(e) => set("labels", e.target.value)} />
        ))}
        {field("providers", "Providers (empty = any)", (d) => (
          <input disabled={d} className={INPUT} value={form.providers} onChange={(e) => set("providers", e.target.value)} />
        ))}
        {field("profileAlias", "Profile alias (default=anth)", (d) => (
          <input disabled={d} className={INPUT} value={form.profileAlias} onChange={(e) => set("profileAlias", e.target.value)} />
        ))}
        {field("allowedProjects", "Allowed projects (none selected = all)", multi("allowedProjects"))}
        {field("deniedProjects", "Denied projects", multi("deniedProjects"))}
        {field("minFreeRamGb", "Min free RAM, GB (empty = no floor)", (d) => (
          <input type="number" min={0} step="0.5" disabled={d} className={INPUT} value={form.minFreeRamGb} onChange={(e) => set("minFreeRamGb", e.target.value)} />
        ))}
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
        <input type="checkbox" checked={form.drain} onChange={(e) => set("drain", e.target.checked)} />
        Drain — take no new work; running sessions finish
      </label>
      {error && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
      <button
        onClick={() => void save()}
        disabled={saving}
        className="mt-2 rounded border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}
