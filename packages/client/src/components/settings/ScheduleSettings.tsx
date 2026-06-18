import type { Dispatch, SetStateAction } from "react";
import { apiFetch, apiPost, apiPut, apiDelete } from "../../lib/api.js";
import { describeCronExpression, validateCronExpression } from "../../lib/cron-utils.js";
import { formatNextFire, formatScheduledRunTime, type ScheduledRun } from "../SettingsPanel.shared.js";
import { showToast } from "../Toast.js";

type ScheduleMode = "interval" | "cron";

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

export function ScheduleSettings({ activeProjectId, scheduledRunsList, setScheduledRunsList, newRunName, setNewRunName, newRunPrompt, setNewRunPrompt, newRunInterval, setNewRunInterval, newRunCron, setNewRunCron, newRunMode, setNewRunMode, savingRun, setSavingRun, triggeringRun, setTriggeringRun, editingRun, setEditingRun, editRunName, setEditRunName, editRunPrompt, setEditRunPrompt, editRunInterval, setEditRunInterval, editRunCron, setEditRunCron, editRunMode, setEditRunMode, savingEditRun, setSavingEditRun }: ScheduleSettingsProps) {
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
                                <div className="flex items-center gap-2">
                                  <label className="text-xs text-gray-600">Schedule:</label>
                                  <select
                                    value={editRunMode}
                                    onChange={(e) => setEditRunMode(e.target.value as "interval" | "cron")}
                                    className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500"
                                  >
                                    <option value="interval">Interval (minutes)</option>
                                    <option value="cron">Cron expression</option>
                                  </select>
                                </div>
                                {editRunMode === "interval" ? (
                                  <div className="flex items-center gap-2">
                                    <label className="text-xs text-gray-600 whitespace-nowrap">Every</label>
                                    <input
                                      type="number"
                                      min={1}
                                      value={editRunInterval}
                                      onChange={(e) => setEditRunInterval(Number(e.target.value))}
                                      className="w-20 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                                    />
                                    <span className="text-xs text-gray-600">minutes</span>
                                  </div>
                                ) : (
                                  <div className="space-y-1">
                                    <input
                                      type="text"
                                      value={editRunCron}
                                      onChange={(e) => setEditRunCron(e.target.value)}
                                      placeholder="e.g. 0 9 * * 1-5"
                                      className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                                    />
                                    {editRunCron.trim() && (() => {
                                      const v = validateCronExpression(editRunCron);
                                      return v.valid
                                        ? <p className="text-xs text-green-600">{describeCronExpression(editRunCron)}</p>
                                        : <p className="text-xs text-red-500">{v.error}</p>;
                                    })()}
                                  </div>
                                )}
                                <div className="flex items-center gap-2">
                                  <button
                                    disabled={!editRunName.trim() || savingEditRun || (editRunMode === "cron" && (!editRunCron.trim() || !validateCronExpression(editRunCron).valid))}
                                    onClick={async () => {
                                      if (!editRunName.trim()) return;
                                      setSavingEditRun(true);
                                      try {
                                        const payload: Record<string, unknown> = { name: editRunName.trim(), prompt: editRunPrompt.trim() };
                                        if (editRunMode === "cron") {
                                          payload.cronExpression = editRunCron.trim();
                                          payload.intervalMinutes = 60;
                                        } else {
                                          payload.intervalMinutes = editRunInterval;
                                          payload.cronExpression = "";
                                        }
                                        await apiPut(`/api/scheduled-runs/${run.id}`, payload);
                                        setScheduledRunsList((r) => r.map((x) => x.id === run.id ? { ...x, name: editRunName.trim(), prompt: editRunPrompt.trim(), intervalMinutes: editRunMode === "interval" ? editRunInterval : x.intervalMinutes, cronExpression: editRunMode === "cron" ? editRunCron.trim() : null } : x));
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
                          ) : (
                            <>
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={run.enabled}
                                  onChange={async (e) => {
                                    const enabled = e.target.checked;
                                    try {
                                      await apiPut(`/api/scheduled-runs/${run.id}`, { enabled });
                                      setScheduledRunsList((r) => r.map((x) => x.id === run.id ? { ...x, enabled } : x));
                                    } catch {
                                      showToast("Failed to update", "error");
                                    }
                                  }}
                                  className="rounded border-gray-300"
                                />
                                <span className="flex-1 text-sm font-medium text-gray-800">{run.name}</span>
                                <span className="text-xs text-gray-400">{run.cronExpression ? describeCronExpression(run.cronExpression) : `every ${run.intervalMinutes}m`}</span>
                                <button
                                  onClick={async () => {
                                    const enabled = !run.enabled;
                                    try {
                                      await apiPut(`/api/scheduled-runs/${run.id}`, { enabled });
                                      setScheduledRunsList((r) => r.map((x) => x.id === run.id ? { ...x, enabled, nextFireAt: enabled ? x.nextFireAt : null } : x));
                                      showToast(enabled ? "Scheduled run resumed" : "Scheduled run paused", "success");
                                    } catch {
                                      showToast("Failed to update", "error");
                                    }
                                  }}
                                  className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded border border-gray-200"
                                >
                                  {run.enabled ? "Pause" : "Resume"}
                                </button>
                                <button
                                  onClick={() => { setEditingRun(run.id); setEditRunName(run.name); setEditRunPrompt(run.prompt ?? ""); setEditRunInterval(run.intervalMinutes); setEditRunCron(run.cronExpression ?? ""); setEditRunMode(run.cronExpression ? "cron" : "interval"); }}
                                  className="text-xs text-gray-400 hover:text-brand-600"
                                >
                                  Edit
                                </button>
                                <button
                                  disabled={triggeringRun === run.id}
                                  onClick={async () => {
                                    setTriggeringRun(run.id);
                                    try {
                                      await apiPost(`/api/scheduled-runs/${run.id}/run`);
                                      showToast("Run triggered", "success");
                                      const runs = await apiFetch<ScheduledRun[]>(`/api/scheduled-runs?projectId=${activeProjectId}`);
                                      setScheduledRunsList(runs);
                                    } catch { showToast("Trigger failed", "error"); }
                                    finally { setTriggeringRun(null); }
                                  }}
                                  className="text-xs px-2 py-1 text-brand-600 hover:bg-brand-50 rounded border border-brand-200"
                                >
                                  {triggeringRun === run.id ? "Running…" : "Run now"}
                                </button>
                                <button
                                  onClick={async () => {
                                    if (!confirm(`Delete scheduled run "${run.name}"?`)) return;
                                    try {
                                      await apiDelete(`/api/scheduled-runs/${run.id}`);
                                      setScheduledRunsList((r) => r.filter((x) => x.id !== run.id));
                                      showToast("Deleted", "success");
                                    } catch {
                                      showToast("Failed to delete", "error");
                                    }
                                  }}
                                  className="text-xs text-gray-400 hover:text-red-600"
                                >
                                  Delete
                                </button>
                              </div>
                              {run.prompt && (
                                <p className="text-xs text-gray-500 pl-5 truncate">{run.prompt}</p>
                              )}
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 pl-5 text-xs text-gray-500">
                                <p>
                                  Issue: {run.systemIssue ? (
                                    <span className="font-medium text-gray-700">#{run.systemIssue.issueNumber} {run.systemIssue.title}</span>
                                  ) : run.systemIssueId ? (
                                    <span className="text-red-600">missing issue</span>
                                  ) : (
                                    <span>none</span>
                                  )}
                                </p>
                                <p>
                                  Workspace: {run.lastRunWorkspace ? (
                                    <span className="font-medium text-gray-700">{run.lastRunWorkspace.branch} ({run.lastRunWorkspace.status})</span>
                                  ) : run.lastRunWorkspaceId ? (
                                    <span className="text-red-600">missing workspace</span>
                                  ) : (
                                    <span>none</span>
                                  )}
                                </p>
                              </div>
                              {run.lastRunAt ? (() => {
                                const status = run.lastRunStatus ?? "unknown";
                                const isRunning = status === "running";
                                const isError = status === "error" || status === "failed";
                                const isSuccess = status === "success" || status === "completed";
                                const icon = isRunning ? "●" : isSuccess ? "✓" : "✗";
                                const colorClass = isRunning ? "text-blue-500" : isSuccess ? "text-green-600" : "text-red-600";
                                const timeStr = new Date(run.lastRunAt).toLocaleString('en-US');
                                const content = (
                                  <span className={`font-medium ${colorClass}`}>{icon} {status}</span>
                                );
                                return (
                                  <p className="text-xs text-gray-400 pl-5" title={timeStr}>
                                    Last run: {timeStr} — {run.lastRunWorkspaceId ? (
                                      <button
                                        className={`underline font-medium ${colorClass} hover:opacity-75`}
                                        onClick={() => {
                                          // Navigate to workspace output — emit a custom event the parent can handle
                                          window.dispatchEvent(new CustomEvent("open-workspace", { detail: { workspaceId: run.lastRunWorkspaceId } }));
                                        }}
                                      >{icon} {status}</button>
                                    ) : content}
                                  </p>
                                );
                              })() : (
                                <p className="text-xs text-gray-400 pl-5">Never run</p>
                              )}
                              <p className={`text-xs pl-5 ${run.enabled ? "text-blue-500" : "text-gray-400"}`} title={formatScheduledRunTime(run.nextFireAt)}>
                                Next run: {run.enabled ? formatNextFire(run.nextFireAt) : "paused"}
                              </p>
                              {run.latestHistory?.reason && (
                                <p className="text-xs text-red-600 pl-5">
                                  Last reason: {run.latestHistory.reason}
                                </p>
                              )}
                              {run.history && run.history.length > 0 && (
                                <details className="pl-5">
                                  <summary className="text-xs text-gray-500 cursor-pointer">Recent history</summary>
                                  <div className="mt-1 space-y-1">
                                    {run.history.map((entry) => (
                                      <div key={entry.id} className="text-xs text-gray-500 flex flex-wrap gap-x-2">
                                        <span className="font-medium text-gray-700">{entry.status}</span>
                                        <span>{formatScheduledRunTime(entry.startedAt)}</span>
                                        <span>{entry.triggeredBy}</span>
                                        {entry.reason && <span className="text-red-600">{entry.reason}</span>}
                                      </div>
                                    ))}
                                  </div>
                                </details>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* New run form */}
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
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-600">Schedule:</label>
                        <select
                          value={newRunMode}
                          onChange={(e) => setNewRunMode(e.target.value as "interval" | "cron")}
                          className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        >
                          <option value="interval">Interval (minutes)</option>
                          <option value="cron">Cron expression</option>
                        </select>
                      </div>
                      {newRunMode === "interval" ? (
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-600 whitespace-nowrap">Every</label>
                          <input
                            type="number"
                            min={1}
                            value={newRunInterval}
                            onChange={(e) => setNewRunInterval(Number(e.target.value))}
                            className="w-20 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                          />
                          <span className="text-xs text-gray-600">minutes</span>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <input
                            type="text"
                            value={newRunCron}
                            onChange={(e) => setNewRunCron(e.target.value)}
                            placeholder="e.g. 0 9 * * 1-5  (weekdays at 09:00)"
                            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                          />
                          {newRunCron.trim() && (() => {
                            const v = validateCronExpression(newRunCron);
                            return v.valid
                              ? <p className="text-xs text-green-600">{describeCronExpression(newRunCron)}</p>
                              : <p className="text-xs text-red-500">{v.error}</p>;
                          })()}
                        </div>
                      )}
                      <button
                        disabled={!newRunName.trim() || !newRunPrompt.trim() || savingRun || !activeProjectId || (newRunMode === "cron" && (!newRunCron.trim() || !validateCronExpression(newRunCron).valid))}
                        onClick={async () => {
                          if (!newRunName.trim() || !newRunPrompt.trim() || !activeProjectId) return;
                          setSavingRun(true);
                          try {
                            const payload: Record<string, unknown> = { name: newRunName.trim(), prompt: newRunPrompt.trim(), projectId: activeProjectId };
                            if (newRunMode === "cron") {
                              payload.cronExpression = newRunCron.trim();
                              payload.intervalMinutes = 60;
                            } else {
                              payload.intervalMinutes = newRunInterval;
                            }
                            const created = await apiPost<ScheduledRun>("/api/scheduled-runs", payload);
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
                </div>
  );
}
