import type { Dispatch, SetStateAction } from "react";
import type { ScheduleMode } from "../../lib/scheduled-run-form.js";
import type { ScheduledRun } from "../SettingsPanel.shared.js";
import { ScheduledRunRow } from "./ScheduledRunRow.js";
import { ScheduledRunEditForm } from "./ScheduledRunEditForm.js";
import { AddScheduledRunForm } from "./AddScheduledRunForm.js";

type ScheduleSettingsProps = {
  activeProjectId?: string | null;
  scheduledRunsList: ScheduledRun[];
  setScheduledRunsList: Dispatch<SetStateAction<ScheduledRun[]>>;
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
  triggeringRun: string | null;
  setTriggeringRun: Dispatch<SetStateAction<string | null>>;
  editingRun: string | null;
  setEditingRun: Dispatch<SetStateAction<string | null>>;
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
};

export function ScheduleSettings(props: ScheduleSettingsProps) {
  const {
    activeProjectId, scheduledRunsList, setScheduledRunsList,
    triggeringRun, setTriggeringRun,
    editingRun, setEditingRun,
    setEditRunName, setEditRunPrompt, setEditRunInterval, setEditRunCron, setEditRunMode,
  } = props;

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
                  editRunName={props.editRunName}
                  setEditRunName={setEditRunName}
                  editRunPrompt={props.editRunPrompt}
                  setEditRunPrompt={setEditRunPrompt}
                  editRunInterval={props.editRunInterval}
                  setEditRunInterval={setEditRunInterval}
                  editRunCron={props.editRunCron}
                  setEditRunCron={setEditRunCron}
                  editRunMode={props.editRunMode}
                  setEditRunMode={setEditRunMode}
                  savingEditRun={props.savingEditRun}
                  setSavingEditRun={props.setSavingEditRun}
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
        newRunName={props.newRunName}
        setNewRunName={props.setNewRunName}
        newRunPrompt={props.newRunPrompt}
        setNewRunPrompt={props.setNewRunPrompt}
        newRunInterval={props.newRunInterval}
        setNewRunInterval={props.setNewRunInterval}
        newRunCron={props.newRunCron}
        setNewRunCron={props.setNewRunCron}
        newRunMode={props.newRunMode}
        setNewRunMode={props.setNewRunMode}
        savingRun={props.savingRun}
        setSavingRun={props.setSavingRun}
        setScheduledRunsList={setScheduledRunsList}
      />
    </div>
  );
}
