import type { Dispatch, SetStateAction } from "react";
import { apiPut } from "../../lib/api.js";
import { buildUpdateRunPayload, isUpdateRunDisabled, runEditPatch, type ScheduleMode } from "../../lib/scheduled-run-form.js";
import type { ScheduledRun } from "../SettingsPanel.shared.js";
import { showToast } from "../Toast.js";
import { ScheduleModeFields } from "./ScheduleModeFields.js";

type ScheduledRunEditFormProps = {
  run: ScheduledRun;
  editRunName: string;
  setEditRunName: Dispatch<SetStateAction<string>>;
  editRunPrompt: string;
  setEditRunPrompt: Dispatch<SetStateAction<string>>;
  editRunInterval: number;
  setEditRunInterval: Dispatch<SetStateAction<number>>;
  editRunCron: string;
  setEditRunCron: Dispatch<SetStateAction<string>>;
  editRunMode: ScheduleMode;
  setEditRunMode: Dispatch<SetStateAction<ScheduleMode>>;
  savingEditRun: boolean;
  setSavingEditRun: Dispatch<SetStateAction<boolean>>;
  setEditingRun: Dispatch<SetStateAction<string | null>>;
  setScheduledRunsList: Dispatch<SetStateAction<ScheduledRun[]>>;
};

/** Inline editor for one scheduled run: name, prompt, schedule, and save/cancel. */
export function ScheduledRunEditForm({
  run, editRunName, setEditRunName, editRunPrompt, setEditRunPrompt, editRunInterval, setEditRunInterval,
  editRunCron, setEditRunCron, editRunMode, setEditRunMode, savingEditRun, setSavingEditRun, setEditingRun, setScheduledRunsList,
}: ScheduledRunEditFormProps) {
  return (
    <div className="space-y-2">
      <input
        type="text"
        value={editRunName}
        onChange={(e) => setEditRunName(e.target.value)}
        placeholder="Name"
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
        autoFocus
      />
      <textarea
        value={editRunPrompt}
        onChange={(e) => setEditRunPrompt(e.target.value)}
        placeholder="Prompt for the agent"
        rows={3}
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
      />
      <div className="space-y-2">
        <ScheduleModeFields
          mode={editRunMode}
          onModeChange={setEditRunMode}
          intervalMinutes={editRunInterval}
          onIntervalChange={setEditRunInterval}
          cron={editRunCron}
          onCronChange={setEditRunCron}
          cronPlaceholder="e.g. 0 9 * * 1-5"
        />
        <div className="flex items-center gap-2">
          <button
            disabled={isUpdateRunDisabled({ name: editRunName, saving: savingEditRun, mode: editRunMode, cron: editRunCron })}
            onClick={async () => {
              if (!editRunName.trim()) return;
              setSavingEditRun(true);
              try {
                await apiPut(`/api/scheduled-runs/${run.id}`, buildUpdateRunPayload({
                  name: editRunName, prompt: editRunPrompt, mode: editRunMode, intervalMinutes: editRunInterval, cron: editRunCron,
                }));
                const patch = runEditPatch({
                  name: editRunName, prompt: editRunPrompt, mode: editRunMode, intervalMinutes: editRunInterval, cron: editRunCron, existingIntervalMinutes: run.intervalMinutes,
                });
                setScheduledRunsList((r) => r.map((x) => x.id === run.id ? { ...x, ...patch } : x));
                setEditingRun(null);
                showToast("Scheduled run updated", "success");
              } catch {
                showToast("Failed to update", "error");
              } finally {
                setSavingEditRun(false);
              }
            }}
            className="text-xs px-3 py-1.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50"
          >
            {savingEditRun ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => setEditingRun(null)}
            className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
