import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api.js";
import type { ScheduleMode } from "../../lib/scheduled-run-form.js";
import type { ScheduledRun } from "../SettingsPanel.shared.js";
import { ScheduledRunRow } from "./ScheduledRunRow.js";
import { ScheduledRunEditForm } from "./ScheduledRunEditForm.js";
import { AddScheduledRunForm } from "./AddScheduledRunForm.js";

type ScheduleSettingsProps = {
  activeProjectId?: string | null;
};

/**
 * Self-contained Schedule tab. Owns all scheduled-run state and lazily fetches the
 * list when the tab opens (and when the active project changes) — previously 15
 * useState hooks + a bootstrap fetch + 30 props were hoisted into SettingsPanel.
 */
export function ScheduleSettings({ activeProjectId }: ScheduleSettingsProps) {
  const [scheduledRunsList, setScheduledRunsList] = useState<ScheduledRun[]>([]);
  const [newRunName, setNewRunName] = useState("");
  const [newRunPrompt, setNewRunPrompt] = useState("");
  const [newRunInterval, setNewRunInterval] = useState(60);
  const [newRunCron, setNewRunCron] = useState("");
  const [newRunMode, setNewRunMode] = useState<ScheduleMode>("interval");
  const [savingRun, setSavingRun] = useState(false);
  const [triggeringRun, setTriggeringRun] = useState<string | null>(null);
  const [editingRun, setEditingRun] = useState<string | null>(null);
  const [editRunName, setEditRunName] = useState("");
  const [editRunPrompt, setEditRunPrompt] = useState("");
  const [editRunInterval, setEditRunInterval] = useState(60);
  const [editRunCron, setEditRunCron] = useState("");
  const [editRunMode, setEditRunMode] = useState<ScheduleMode>("interval");
  const [savingEditRun, setSavingEditRun] = useState(false);

  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    apiFetch<ScheduledRun[]>(`/api/scheduled-runs?projectId=${activeProjectId}`)
      .then((runs) => { if (!cancelled) setScheduledRunsList(runs); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [activeProjectId]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        Configure recurring agent runs. Each scheduled run creates a direct workspace on its system issue at the configured interval.
      </p>

      {/* Existing runs */}
      {scheduledRunsList.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No scheduled runs configured yet.</p>
      ) : (
        <div className="space-y-2">
          {scheduledRunsList.map((run) => (
            <div key={run.id} className="border border-gray-200 rounded-md px-3 py-2 space-y-1">
              {editingRun === run.id ? (
                <ScheduledRunEditForm
                  run={run}
                  editRunName={editRunName}
                  setEditRunName={setEditRunName}
                  editRunPrompt={editRunPrompt}
                  setEditRunPrompt={setEditRunPrompt}
                  editRunInterval={editRunInterval}
                  setEditRunInterval={setEditRunInterval}
                  editRunCron={editRunCron}
                  setEditRunCron={setEditRunCron}
                  editRunMode={editRunMode}
                  setEditRunMode={setEditRunMode}
                  savingEditRun={savingEditRun}
                  setSavingEditRun={setSavingEditRun}
                  setEditingRun={setEditingRun}
                  setScheduledRunsList={setScheduledRunsList}
                />
              ) : (
                <ScheduledRunRow
                  run={run}
                  activeProjectId={activeProjectId}
                  triggeringRun={triggeringRun}
                  setTriggeringRun={setTriggeringRun}
                  setScheduledRunsList={setScheduledRunsList}
                  onStartEdit={() => {
                    setEditingRun(run.id);
                    setEditRunName(run.name);
                    setEditRunPrompt(run.prompt ?? "");
                    setEditRunInterval(run.intervalMinutes);
                    setEditRunCron(run.cronExpression ?? "");
                    setEditRunMode(run.cronExpression ? "cron" : "interval");
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* New run form */}
      <AddScheduledRunForm
        activeProjectId={activeProjectId}
        newRunName={newRunName}
        setNewRunName={setNewRunName}
        newRunPrompt={newRunPrompt}
        setNewRunPrompt={setNewRunPrompt}
        newRunInterval={newRunInterval}
        setNewRunInterval={setNewRunInterval}
        newRunCron={newRunCron}
        setNewRunCron={setNewRunCron}
        newRunMode={newRunMode}
        setNewRunMode={setNewRunMode}
        savingRun={savingRun}
        setSavingRun={setSavingRun}
        setScheduledRunsList={setScheduledRunsList}
      />
    </div>
  );
}
