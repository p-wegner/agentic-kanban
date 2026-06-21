import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

interface SlowRequestEntry {
  method: string;
  path: string;
  durationMs: number;
  timestamp: string;
}

interface SlowRequestsResponse {
  entries: SlowRequestEntry[];
}

export function SlowRequestsPanel() {
  const [entries, setEntries] = useState<SlowRequestEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<SlowRequestsResponse>("/api/metrics/slow-requests");
      setEntries(data.entries);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">Recent Slow Requests (&gt;200ms)</h3>
        <button
          onClick={load}
          className="text-xs text-brand-600 hover:text-brand-700"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}

      {entries === null && !error && (
        <p className="text-xs text-gray-400">Loading...</p>
      )}

      {entries !== null && entries.length === 0 && (
        <p className="text-xs text-gray-400 italic">No slow requests recorded since last restart.</p>
      )}

      {entries !== null && entries.length > 0 && (
        <div className="rounded border border-gray-200 overflow-hidden text-xs">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-2 py-1.5 font-medium w-12">Method</th>
                <th className="px-2 py-1.5 font-medium">Path</th>
                <th className="px-2 py-1.5 font-medium w-20 text-right">Duration</th>
                <th className="px-2 py-1.5 font-medium w-24 text-right">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {entries.map((entry, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-2 py-1.5 font-mono text-gray-500">{entry.method}</td>
                  <td className="px-2 py-1.5 font-mono text-gray-700 truncate max-w-xs" title={entry.path}>
                    {entry.path}
                  </td>
                  <td className="px-2 py-1.5 text-right text-amber-600 font-medium">
                    {entry.durationMs}ms
                  </td>
                  <td className="px-2 py-1.5 text-right text-gray-400" title={entry.timestamp}>
                    {formatRelativeTime(entry.timestamp)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
