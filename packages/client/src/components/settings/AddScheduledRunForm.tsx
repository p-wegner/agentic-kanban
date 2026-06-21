import type { Dispatch, SetStateAction } from "react";
import { apiPost } from "../../lib/api.js";
import { buildCreateRunPayload, isCreateRunDisabled, type ScheduleMode } from "../../lib/scheduled-run-form.js";
import type { ScheduledRun } from "../SettingsPanel.shared.js";
import { showToast } from "../Toast.js";
import { ScheduleModeFields } from "./ScheduleModeFields.js";

type AddScheduledRunFormProps = {
  activeProjectId?: string | null;
  newRunName: string;
  setNewRunName: Dispatch<SetStateAction<string>>;
  newRunPrompt: string;
  setNewRunPrompt: Dispatch<SetStateAction<string>>;
  newRunInterval: number;
  setNewRunInterval: Dispatch<SetStateAction<number>>;
  newRunCron: string;
  setNewRunCron: Dispatch<SetStateAction<string>>;
  newRunMode: ScheduleMode;
  setNewRunMode: Dispatch<SetStateAction<ScheduleMode>>;
  savingRun: boolean;
  setSavingRun: Dispatch<SetStateAction<boolean>>;
  setScheduledRunsList: Dispatch<SetStateAction<ScheduledRun[]>>;
};

/** Form for adding a new scheduled run to the active project. */
export function AddScheduledRunForm({
  activeProjectId, newRunName, setNewRunName, newRunPrompt, setNewRunPrompt, newRunInterval, setNewRunInterval,
  newRunCron, setNewRunCron, newRunMode, setNewRunMode, savingRun, setSavingRun, setScheduledRunsList,
}: AddScheduledRunFormProps) {
  return (
    <div className="border-t border-gray-100 pt-3 space-y-2">
      <p className="text-xs font-medium text-gray-600">Add scheduled run</p>
      <input
        type="text"
        value={newRunName}
        onChange={(e) => setNewRunName(e.target.value)}
        placeholder="Name (e.g. Daily standup update)"
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      <textarea
        value={newRunPrompt}
        onChange={(e) => setNewRunPrompt(e.target.value)}
        placeholder="Prompt for the agent"
        rows={3}
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
      />
      <div className="space-y-2">
        <ScheduleModeFields
          mode={newRunMode}
          onModeChange={setNewRunMode}
          intervalMinutes={newRunInterval}
          onIntervalChange={setNewRunInterval}
          cron={newRunCron}
          onCronChange={setNewRunCron}
          cronPlaceholder="e.g. 0 9 * * 1-5  (weekdays at 09:00)"
        />
        <button
          disabled={isCreateRunDisabled({ name: newRunName, prompt: newRunPrompt, saving: savingRun, projectId: activeProjectId, mode: newRunMode, cron: newRunCron })}
          onClick={async () => {
            if (!newRunName.trim() || !newRunPrompt.trim() || !activeProjectId) return;
            setSavingRun(true);
            try {
              const created = await apiPost<ScheduledRun>("/api/scheduled-runs", buildCreateRunPayload({
                name: newRunName, prompt: newRunPrompt, projectId: activeProjectId, mode: newRunMode, intervalMinutes: newRunInterval, cron: newRunCron,
              }));
              setScheduledRunsList((r) => [...r, created]);
              setNewRunName("");
              setNewRunPrompt("");
              setNewRunInterval(60);
              setNewRunCron("");
              setNewRunMode("interval");
              showToast("Scheduled run created", "success");
            } catch { showToast("Failed to create", "error"); }
            finally { setSavingRun(false); }
          }}
          className="text-xs px-3 py-1.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50"
        >
          {savingRun ? "Creating…" : "Add"}
        </button>
      </div>
    </div>
  );
}
