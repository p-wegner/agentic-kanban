import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface FlakyTestEntry {
  testName: string;
  file: string | null;
  suite: string | null;
  runner: string;
  totalRuns: number;
  passCount: number;
  failCount: number;
  flakeRate: number;
  score: number;
  lastSeen: string;
  isPinned: boolean;
  lastError: string | null;
}

type SortKey = "score" | "flakeRate" | "totalRuns" | "lastSeen";
type SortDir = "asc" | "desc";

interface FlakyTestsPanelProps {
  projectId: string | null;
}

export function FlakyTestsPanel({ projectId }: FlakyTestsPanelProps) {
  const [tests, setTests] = useState<FlakyTestEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [runnerFilter, setRunnerFilter] = useState<string>("all");
  const [showPinnedOnly, setShowPinnedOnly] = useState(false);
  const [expandedTest, setExpandedTest] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [creatingTicket, setCreatingTicket] = useState<string | null>(null);

  const fetchTests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<FlakyTestEntry[]>(
        `/api/flaky-tests?limit=100&windowDays=${windowDays}`,
      );
      setTests(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load flaky tests");
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    fetchTests();
  }, [fetchTests]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const runners = useMemo(() => {
    const set = new Set(tests.map(t => t.runner));
    return ["all", ...Array.from(set)];
  }, [tests]);

  const filtered = useMemo(() => {
    let list = tests;
    if (runnerFilter !== "all") list = list.filter(t => t.runner === runnerFilter);
    if (showPinnedOnly) list = list.filter(t => t.isPinned);
    return [...list].sort((a, b) => {
      const mult = sortDir === "asc" ? 1 : -1;
      const av = a[sortKey] as number | string;
      const bv = b[sortKey] as number | string;
      if (typeof av === "number" && typeof bv === "number") return mult * (av - bv);
      return mult * String(av).localeCompare(String(bv));
    });
  }, [tests, runnerFilter, showPinnedOnly, sortKey, sortDir]);

  async function handlePin(test: FlakyTestEntry) {
    try {
      await apiFetch("/api/flaky-tests/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testName: test.testName, file: test.file }),
      });
      showToast("Pinned as known-flaky", "success");
      setTests(prev => prev.map(t => t.testName === test.testName ? { ...t, isPinned: true } : t));
    } catch {
      showToast("Failed to pin test", "error");
    }
  }

  async function handleUnpin(test: FlakyTestEntry) {
    try {
      await apiFetch("/api/flaky-tests/pin", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testName: test.testName }),
      });
      showToast("Unpinned", "success");
      setTests(prev => prev.map(t => t.testName === test.testName ? { ...t, isPinned: false } : t));
    } catch {
      showToast("Failed to unpin test", "error");
    }
  }

  async function handleCreateTicket(test: FlakyTestEntry) {
    if (!projectId) return;
    setCreatingTicket(test.testName);
    try {
      const title = `Fix flaky test: ${test.testName.slice(0, 80)}`;
      const desc = [
        `## Flaky Test\n`,
        `**Test:** \`${test.testName}\``,
        `**File:** \`${test.file ?? "unknown"}\``,
        `**Runner:** ${test.runner}`,
        `**Flake rate:** ${(test.flakeRate * 100).toFixed(1)}% (${test.failCount}/${test.totalRuns} runs failed)`,
        `**Last seen:** ${new Date(test.lastSeen).toLocaleString()}`,
        test.lastError ? `\n**Last error:**\n\`\`\`\n${test.lastError}\n\`\`\`` : "",
        `\n## Goal\nInvestigate and fix the root cause of this intermittent test failure.`,
        `Consult \`list_flaky_tests\` MCP tool for current flaky test data.`,
      ].filter(Boolean).join("\n");

      const resp = await apiFetch<{ issueNumber: number }>(`/api/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title, description: desc, priority: "medium" }),
      });
      showToast(`Created ticket #${resp.issueNumber}`, "success");
    } catch {
      showToast("Failed to create ticket", "error");
    } finally {
      setCreatingTicket(null);
    }
  }

  const SortHeader = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none whitespace-nowrap"
      onClick={() => handleSort(k)}
    >
      {label}
      {sortKey === k && (
        <span className="ml-1">{sortDir === "desc" ? "↓" : "↑"}</span>
      )}
    </th>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Flaky Tests Radar</h2>
          {tests.length > 0 && (
            <span className="text-xs bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded-full font-medium">
              {filtered.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={windowDays}
            onChange={e => setWindowDays(Number(e.target.value))}
            className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
          >
            <option value={7}>Last 7d</option>
            <option value={30}>Last 30d</option>
            <option value={90}>Last 90d</option>
          </select>
          {runners.length > 2 && (
            <select
              value={runnerFilter}
              onChange={e => setRunnerFilter(e.target.value)}
              className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
            >
              {runners.map(r => <option key={r} value={r}>{r === "all" ? "All runners" : r}</option>)}
            </select>
          )}
          <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showPinnedOnly}
              onChange={e => setShowPinnedOnly(e.target.checked)}
              className="rounded"
            />
            Pinned only
          </label>
          <button
            onClick={fetchTests}
            disabled={loading}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 disabled:opacity-40"
            title="Refresh"
          >
            <svg className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-4 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-600 text-sm gap-2">
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>No flaky tests detected</p>
            <p className="text-xs text-center max-w-xs">
              Tests appear here when they pass in some sessions and fail in others within the same window.
              Ingest test results via <code className="font-mono">POST /api/flaky-tests/parse</code>.
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
              <tr>
                <SortHeader k="score" label="Score" />
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Test</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">File</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Runner</th>
                <SortHeader k="flakeRate" label="Flake%" />
                <SortHeader k="totalRuns" label="Runs" />
                <SortHeader k="lastSeen" label="Last seen" />
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map(test => (
                <>
                  <tr
                    key={test.testName}
                    className={`hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer ${test.isPinned ? "bg-amber-50/50 dark:bg-amber-950/30" : ""}`}
                    onClick={() => setExpandedTest(expandedTest === test.testName ? null : test.testName)}
                  >
                    <td className="px-3 py-2 font-mono text-gray-500 dark:text-gray-400">
                      {test.score.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      <div className="flex items-center gap-1">
                        {test.isPinned && (
                          <span title="Known-flaky (pinned)" className="text-amber-500">📌</span>
                        )}
                        <span className="font-medium text-gray-800 dark:text-gray-200 truncate" title={test.testName}>
                          {test.testName.length > 60 ? `…${test.testName.slice(-57)}` : test.testName}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400 max-w-[180px]">
                      <span className="truncate block" title={test.file ?? undefined}>
                        {test.file ? test.file.split(/[/\\]/).pop() : "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${test.runner === "playwright" ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300" : "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300"}`}>
                        {test.runner}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <div className="w-16 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-red-500"
                            style={{ width: `${Math.round(test.flakeRate * 100)}%` }}
                          />
                        </div>
                        <span className="text-gray-700 dark:text-gray-300 font-medium">
                          {(test.flakeRate * 100).toFixed(0)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                      <span title={`${test.passCount} passed, ${test.failCount} failed`}>
                        {test.totalRuns}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {new Date(test.lastSeen).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => test.isPinned ? handleUnpin(test) : handlePin(test)}
                          className={`px-2 py-0.5 rounded text-xs border transition-colors ${test.isPinned ? "border-amber-300 dark:border-amber-700 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950" : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                          title={test.isPinned ? "Unpin" : "Pin as known-flaky"}
                        >
                          {test.isPinned ? "Unpin" : "Pin"}
                        </button>
                        {projectId && (
                          <button
                            onClick={() => handleCreateTicket(test)}
                            disabled={creatingTicket === test.testName}
                            className="px-2 py-0.5 rounded text-xs border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
                            title="Create fix ticket"
                          >
                            {creatingTicket === test.testName ? "…" : "Ticket"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedTest === test.testName && (
                    <tr key={`${test.testName}-expanded`} className="bg-gray-50 dark:bg-gray-900">
                      <td colSpan={8} className="px-4 py-3">
                        <div className="space-y-2">
                          <div className="grid grid-cols-3 gap-4 text-xs">
                            <div>
                              <span className="text-gray-500 dark:text-gray-400">Full test name</span>
                              <p className="font-mono text-gray-800 dark:text-gray-200 break-all mt-0.5">{test.testName}</p>
                            </div>
                            {test.file && (
                              <div>
                                <span className="text-gray-500 dark:text-gray-400">File</span>
                                <p className="font-mono text-gray-800 dark:text-gray-200 break-all mt-0.5">{test.file}</p>
                              </div>
                            )}
                            <div>
                              <span className="text-gray-500 dark:text-gray-400">Stats</span>
                              <p className="text-gray-800 dark:text-gray-200 mt-0.5">
                                {test.passCount} passed / {test.failCount} failed / {test.totalRuns} total
                              </p>
                            </div>
                          </div>
                          {test.lastError && (
                            <div>
                              <span className="text-xs text-gray-500 dark:text-gray-400">Last error</span>
                              <pre className="mt-0.5 p-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-300 overflow-auto max-h-32 whitespace-pre-wrap">
                                {test.lastError}
                              </pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-800 shrink-0 flex items-center justify-between">
        <p className="text-xs text-gray-400 dark:text-gray-600">
          {filtered.length} flaky test{filtered.length !== 1 ? "s" : ""} detected · 5%–95% failure rate required
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-600">
          MCP: <code className="font-mono">list_flaky_tests</code>
        </p>
      </div>
    </div>
  );
}
