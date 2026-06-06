import type { Dispatch, SetStateAction } from "react";
import { WorkflowAgentBehaviourSection, WorkflowBoardMonitorSection, WorkflowFollowUpSection, WorkflowLearningSection, WorkflowProcessPipelineSection, WorkflowReviewMergeSection, type MonitorTunables, type Settings, type SettingsBoolSetter, type SettingsTextSetter, type SkillSetting } from "../SettingsPanel.shared.js";

type WorkflowSettingsProps = {
  settings: Settings;
  set: SettingsTextSetter;
  setBool: SettingsBoolSetter;
  setSettings: Dispatch<SetStateAction<Settings>>;
  activeProjectId?: string | null;
  autoReviewOn: boolean;
  monitorStatus: { enabled: boolean; intervalMin: number; active: boolean; lastRun: string | null; nextRunAt: string | null; recentActions: string[]; maintenanceActive?: boolean; maintenanceEnd?: string | null } | null;
  monitorTunables: { tunables: MonitorTunables; source: "strategy" | "prefs" } | null;
  monitorRunning: boolean;
  migratingToStrategy: boolean;
  skills: SkillSetting[];
  onRunMonitorNow: () => void;
  onMigrateToStrategy: () => void;
};

export function WorkflowSettings({ settings, set, setBool, setSettings, activeProjectId, autoReviewOn, monitorStatus, monitorTunables, monitorRunning, migratingToStrategy, skills, onRunMonitorNow: handleMonitorRunNow, onMigrateToStrategy: handleMigrateToStrategy }: WorkflowSettingsProps) {
  return (
<>
                  <WorkflowProcessPipelineSection settings={settings} />
                  <WorkflowAgentBehaviourSection settings={settings} set={set} setBool={setBool} />
                  <WorkflowReviewMergeSection
                    settings={settings}
                    set={set}
                    setBool={setBool}
                    autoReviewOn={autoReviewOn}
                  />
                  <WorkflowLearningSection settings={settings} set={set} setBool={setBool} />
                  <WorkflowFollowUpSection
                    settings={settings}
                    set={set}
                    setBool={setBool}
                    activeProjectId={activeProjectId}
                    onButlerEventFeedOverrideChange={(value) => {
                      setSettings((s) => ({
                        ...s,
                        [`butler_event_feed_${activeProjectId}` as keyof Settings]: value,
                      }));
                    }}
                  />

                  <WorkflowBoardMonitorSection
                    settings={settings}
                    set={set}
                    setBool={setBool}
                    activeProjectId={activeProjectId}
                    monitorStatus={monitorStatus}
                    monitorTunables={monitorTunables}
                    monitorRunning={monitorRunning}
                    migratingToStrategy={migratingToStrategy}
                    skills={skills}
                    onRunMonitorNow={handleMonitorRunNow}
                    onMigrateToStrategy={handleMigrateToStrategy}
                  />
                </>
  );
}
