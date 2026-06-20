import React from "react";

export interface WorkspacePlanApprovalCardProps {
  wsId: string;
  pendingPlanPath: string;
  planContent: Record<string, string | null>;
  planEditMode: Record<string, boolean>;
  planEditText: Record<string, string>;
  rejectMode: Record<string, boolean>;
  rejectFeedback: Record<string, string>;
  actionLoading: boolean;
  setPlanEditText: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setRejectFeedback: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setRejectMode: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setPlanEditMode: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  handleRejectPlan: (wsId: string, feedback: string) => void;
  handleImplementPlan: (wsId: string, updatedPlanContent?: string) => void;
}

export function WorkspacePlanApprovalCard({
  wsId,
  pendingPlanPath,
  planContent,
  planEditMode,
  planEditText,
  rejectMode,
  rejectFeedback,
  actionLoading,
  setPlanEditText,
  setRejectFeedback,
  setRejectMode,
  setPlanEditMode,
  handleRejectPlan,
  handleImplementPlan,
}: WorkspacePlanApprovalCardProps) {
  return (
              <div className="border border-amber-300 dark:border-amber-700 rounded-lg bg-amber-50 dark:bg-amber-950 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-amber-600 dark:text-amber-400 font-semibold text-sm">📋 Plan Ready for Review</span>
                  <span className="text-xs text-amber-500 dark:text-amber-500">({pendingPlanPath})</span>
                </div>
                {planContent[wsId] ? (
                  planEditMode[wsId] ? (
                    <textarea
                      value={planEditText[wsId] ?? planContent[wsId] ?? ""}
                      onChange={(e) => setPlanEditText((prev) => ({ ...prev, [wsId]: e.target.value }))}
                      className="w-full text-xs font-mono border border-amber-300 dark:border-amber-700 rounded px-2 py-1.5 bg-white dark:bg-gray-900 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-y min-h-[200px]"
                      rows={12}
                    />
                  ) : (
                    <div className="bg-white dark:bg-gray-900 rounded border border-amber-200 dark:border-amber-800 p-2 max-h-64 overflow-y-auto">
                      <pre className="text-xs font-mono whitespace-pre-wrap text-gray-800 dark:text-gray-200">{planContent[wsId]}</pre>
                    </div>
                  )
                ) : (
                  <p className="text-xs text-amber-600 dark:text-amber-400">Plan file not loaded.</p>
                )}
                {rejectMode[wsId] ? (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-amber-700 dark:text-amber-400">Rejection feedback for agent:</label>
                    <textarea
                      value={rejectFeedback[wsId] ?? ""}
                      onChange={(e) => setRejectFeedback((prev) => ({ ...prev, [wsId]: e.target.value }))}
                      placeholder="Explain what's wrong with the plan and how to improve it..."
                      className="w-full text-xs border border-amber-300 dark:border-amber-700 rounded px-2 py-1.5 bg-white dark:bg-gray-900 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-y"
                      rows={3}
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRejectPlan(wsId, rejectFeedback[wsId] || "Please revise the plan.")}
                        disabled={actionLoading}
                        className="text-sm bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-50 font-medium"
                      >
                        Send Rejection
                      </button>
                      <button
                        onClick={() => setRejectMode((prev) => ({ ...prev, [wsId]: false }))}
                        disabled={actionLoading}
                        className="text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-3 py-1.5 rounded hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 flex-wrap">
                    {planEditMode[wsId] ? (
                      <>
                        <button
                          onClick={() => handleImplementPlan(wsId, planEditText[wsId] ?? planContent[wsId] ?? "")}
                          disabled={actionLoading}
                          className="text-sm bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 disabled:opacity-50 font-medium"
                        >
                          ✓ Save &amp; Implement
                        </button>
                        <button
                          onClick={() => setPlanEditMode((prev) => ({ ...prev, [wsId]: false }))}
                          disabled={actionLoading}
                          className="text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-3 py-1.5 rounded hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
                        >
                          Cancel Edit
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => handleImplementPlan(wsId)}
                          disabled={actionLoading}
                          className="text-sm bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 disabled:opacity-50 font-medium"
                          title="Approve plan and start implementation"
                        >
                          ✓ Approve
                        </button>
                        <button
                          onClick={() => {
                            setPlanEditMode((prev) => ({ ...prev, [wsId]: true }));
                            setPlanEditText((prev) => ({ ...prev, [wsId]: planContent[wsId] ?? "" }));
                          }}
                          disabled={actionLoading}
                          className="text-sm bg-amber-500 text-white px-3 py-1.5 rounded hover:bg-amber-600 disabled:opacity-50 font-medium"
                          title="Edit the plan before approving"
                        >
                          ✎ Edit &amp; Approve
                        </button>
                        <button
                          onClick={() => setRejectMode((prev) => ({ ...prev, [wsId]: true }))}
                          disabled={actionLoading}
                          className="text-sm bg-red-500 text-white px-3 py-1.5 rounded hover:bg-red-600 disabled:opacity-50 font-medium"
                          title="Reject plan and send feedback to agent for re-planning"
                        >
                          ✗ Reject
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
  );
}
