import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime, formatAbsoluteTime } from "../lib/formatRelativeTime.js";
import { showToast } from "./Toast.js";

interface TimeEntry {
  id: string;
  issueId: string;
  minutes: number;
  note: string | null;
  createdAt: string;
}

export function formatMinutes(totalMinutes: number): string {
  if (totalMinutes <= 0) return "0m";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

interface IssueWorkLogSectionProps {
  issueId: string;
}

export function IssueWorkLogSection({ issueId }: IssueWorkLogSectionProps) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [totalMinutes, setTotalMinutes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [minutesInput, setMinutesInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    setLoading(true);
    apiFetch<{ entries: TimeEntry[]; totalMinutes: number }>(`/api/issues/${issueId}/time-entries`)
      .then((data) => {
        setEntries(data.entries);
        setTotalMinutes(data.totalMinutes);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [issueId]);

  async function handleAdd() {
    const minutes = parseInt(minutesInput, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      showToast("Minutes must be a positive number", "error");
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      const entry = await apiFetch<TimeEntry>(`/api/issues/${issueId}/time-entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes, note: noteInput.trim() || null }),
      });
      setEntries((prev) => [...prev, entry]);
      setTotalMinutes((prev) => prev + entry.minutes);
      setMinutesInput("");
      setNoteInput("");
      setShowForm(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to log time", "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(entry: TimeEntry) {
    if (deletingId) return;
    setDeletingId(entry.id);
    try {
      await apiFetch(`/api/issues/${issueId}/time-entries/${entry.id}`, { method: "DELETE" });
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      setTotalMinutes((prev) => prev - entry.minutes);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete entry", "error");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
            Work log
          </label>
          {!loading && totalMinutes > 0 && (
            <span className="inline-flex items-center text-xs font-medium px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">
              {formatMinutes(totalMinutes)} total
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="text-xs text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 transition-colors"
        >
          {showForm ? "Cancel" : "+ Log time"}
        </button>
      </div>

      {showForm && (
        <div className="mb-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              value={minutesInput}
              onChange={(e) => setMinutesInput(e.target.value)}
              placeholder="Minutes"
              className="w-24 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            />
            <input
              type="text"
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Note (optional)"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleAdd(); } }}
              className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={submitting || !minutesInput}
              className="text-xs font-medium bg-brand-600 text-white px-2.5 py-1 rounded hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Saving..." : "Log"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">No time logged yet.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-2 text-xs"
            >
              <span className="font-medium text-teal-700 dark:text-teal-300 shrink-0">
                {formatMinutes(entry.minutes)}
              </span>
              {entry.note && (
                <span className="text-gray-600 dark:text-gray-300 truncate flex-1">
                  {entry.note}
                </span>
              )}
              <span
                className="text-gray-400 dark:text-gray-500 shrink-0 ml-auto"
                title={formatAbsoluteTime(entry.createdAt)}
              >
                {formatRelativeTime(entry.createdAt)}
              </span>
              <button
                type="button"
                onClick={() => handleDelete(entry)}
                disabled={deletingId === entry.id}
                className="text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 disabled:opacity-50 transition-colors shrink-0"
                title="Delete entry"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
