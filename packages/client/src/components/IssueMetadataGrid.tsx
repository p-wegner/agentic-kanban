import type { Dispatch, SetStateAction } from "react";
import type { IssueWithStatus, MilestoneResponse } from "@agentic-kanban/shared";
import { isHttpUrl } from "../lib/url.js";

type Setter<T> = Dispatch<SetStateAction<T>>;

interface IssueMetadataGridProps {
  editing: boolean;
  issue: IssueWithStatus;
  statuses: { id: string; name: string }[];
  issueType: string;
  setIssueType: Setter<string>;
  estimate: string;
  setEstimate: Setter<string>;
  dueDate: string;
  setDueDate: Setter<string>;
  externalKey: string;
  setExternalKey: Setter<string>;
  externalUrl: string;
  setExternalUrl: Setter<string>;
  skipAutoReview: boolean;
  setSkipAutoReview: Setter<boolean>;
  milestoneId: string | null;
  setMilestoneId: Setter<string | null>;
  milestones: MilestoneResponse[];
  estimating: boolean;
  handleStatusChange: (newStatusId: string) => Promise<void> | void;
  handleQuickEstimate: (value: string) => Promise<void> | void;
  handleAiEstimate: () => Promise<void> | void;
  badgeColor: string;
  issueTypeDisplay: React.ReactNode;
}

export function IssueMetadataGrid({
  editing, issue, statuses, issueType, setIssueType, estimate, setEstimate,
  dueDate, setDueDate, externalKey, setExternalKey, externalUrl, setExternalUrl,
  skipAutoReview, setSkipAutoReview, milestoneId, setMilestoneId, milestones,
  estimating, handleStatusChange, handleQuickEstimate, handleAiEstimate,
  badgeColor, issueTypeDisplay,
}: IssueMetadataGridProps) {
  return (
    <>
          {/* Metadata group: Status, Type, Estimate, Due Date — compact two-column grid in view mode */}
          {editing ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">Status</label>
                <select
                  value={issue.statusId}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  disabled={editing}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-gray-50 dark:bg-gray-950 text-gray-500 dark:text-gray-400"
                >
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">Type</label>
                  <select
                    value={issueType}
                    onChange={(e) => setIssueType(e.target.value)}
                    className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    <option value="task">Task</option>
                    <option value="bug">Bug</option>
                    <option value="feature">Feature</option>
                    <option value="chore">Chore</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">Estimate</label>
                  <select
                    value={estimate}
                    onChange={(e) => setEstimate(e.target.value)}
                    className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    <option value="">None</option>
                    <option value="XS">XS</option>
                    <option value="S">S</option>
                    <option value="M">M</option>
                    <option value="L">L</option>
                    <option value="XL">XL</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">Due Date</label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">Milestone</label>
                  <select
                    value={milestoneId ?? ""}
                    onChange={(e) => setMilestoneId(e.target.value || null)}
                    className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  >
                    <option value="">None</option>
                    {milestones.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_2fr] gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">External Key</label>
                  <input
                    type="text"
                    value={externalKey}
                    onChange={(e) => setExternalKey(e.target.value)}
                    placeholder="PROJ-123"
                    className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">External URL</label>
                  <input
                    type="url"
                    value={externalUrl}
                    onChange={(e) => setExternalUrl(e.target.value)}
                    placeholder="https://tracker.example.com/issue/123"
                    className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  />
                </div>
              </div>
              <div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={skipAutoReview}
                    onChange={(e) => setSkipAutoReview(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Skip auto AI code review</span>
                </label>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Status — full width, primary control */}
              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">Status</label>
                <select
                  value={issue.statusId}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              {/* Type + Estimate side by side */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500 dark:text-gray-400">Type:</span>
                  <span className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded capitalize ${badgeColor}`}>
                    {issueTypeDisplay}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500 dark:text-gray-400">Size:</span>
                  <div className="flex items-center gap-0.5">
                    {(["XS", "S", "M", "L", "XL"] as const).map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => handleQuickEstimate(size)}
                        title={issue.estimate === size ? `Clear estimate` : `Set estimate to ${size}`}
                        className={`text-xs font-medium px-1.5 py-0.5 rounded transition-colors ${
                          issue.estimate === size
                            ? "bg-teal-600 text-white"
                            : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-teal-100 hover:text-teal-700 dark:hover:bg-teal-900 dark:hover:text-teal-300"
                        }`}
                      >
                        {size}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={handleAiEstimate}
                      disabled={estimating}
                      title="Estimate with AI (Haiku)"
                      className="ml-0.5 text-xs text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-0.5 px-1 py-0.5"
                    >
                      {estimating ? (
                        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
                        </svg>
                      )}
                      {estimating ? "..." : "AI"}
                    </button>
                  </div>
                </div>
                {issue.dueDate && (() => {
                  const overdue = new Date(issue.dueDate) < new Date(new Date().toDateString()) &&
                    issue.statusName !== "Done" && issue.statusName !== "Cancelled";
                  return (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500 dark:text-gray-400">Due:</span>
                      <span className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded ${overdue ? "bg-red-100 text-red-700" : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"}`}>
                        {new Date(issue.dueDate).toLocaleDateString('en-US', { month: "short", day: "numeric", year: "numeric" })}
                        {overdue && " ⚠ overdue"}
                      </span>
                    </div>
                  );
                })()}
                {issue.milestoneId && milestones.find(m => m.id === issue.milestoneId) && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 dark:text-gray-400">Milestone:</span>
                    <span className="inline-block text-xs font-medium px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                      {milestones.find(m => m.id === issue.milestoneId)!.name}
                    </span>
                  </div>
                )}
                {issue.skipAutoReview && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                    Skip review
                  </span>
                )}
                {issue.externalUrl && isHttpUrl(issue.externalUrl) && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 dark:text-gray-400">Tracker:</span>
                    <a
                      href={issue.externalUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={issue.externalUrl}
                      className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:hover:bg-indigo-900/70"
                    >
                      <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4m-4-6l6-6m0 0v4m0-4h-4" />
                      </svg>
                      {issue.externalKey || "Open link"}
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}
    </>
  );
}
