import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { type AgentOutputFormat } from "../lib/agent-output-parser.js";
import { parseMessagesIntoTurns, type ReplayTurn } from "../lib/session-replay-turns.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionReplayProps {
  sessionId: string;
  sessionLabel?: string;
  outputFormat?: AgentOutputFormat;
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function toolIcon(name: string): string {
  switch (name) {
    case "Read":
    case "view": return "📄";
    case "Edit":
    case "edit": return "✏️";
    case "Write":
    case "create": return "📝";
    case "Bash":
    case "powershell":
    case "shell": return "💻";
    case "Grep":
    case "grep": return "🔍";
    case "Glob":
    case "glob": return "🗂️";
    case "Agent": return "🤖";
    case "WebFetch":
    case "mcp__web_reader__webReader": return "🌐";
    case "WebSearch":
    case "web_search": return "🔎";
    default: return "🔧";
  }
}

function summarizeInput(name: string, inputParsed: Record<string, unknown>): string {
  const file =
    (inputParsed.file_path as string) ||
    (inputParsed.path as string) ||
    "";
  switch (name) {
    case "Read":
    case "view":
      return file || "file";
    case "Edit":
    case "edit":
      return file || "file";
    case "Write":
    case "create":
      return file || "file";
    case "Bash":
    case "powershell":
    case "shell": {
      const cmd = (inputParsed.command as string) || "";
      return cmd.slice(0, 80) + (cmd.length > 80 ? "…" : "");
    }
    case "Grep":
    case "grep":
      return `"${inputParsed.pattern || ""}"`;
    case "Glob":
    case "glob":
      return String(inputParsed.pattern || "");
    case "Agent":
      return (
        (inputParsed.description as string) ||
        ((inputParsed.prompt as string) || "").slice(0, 60) ||
        "subagent"
      );
    default:
      return JSON.stringify(inputParsed).slice(0, 80);
  }
}

// ─── Diff renderer for Edit tools ────────────────────────────────────────────

function renderEditDiff(oldStr: string, newStr: string) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  return (
    <div className="font-mono text-xs overflow-auto max-h-96 rounded border border-gray-700 bg-gray-950">
      <div className="px-2 py-1 bg-gray-800 text-gray-400 text-[10px] border-b border-gray-700">
        — removed &nbsp; + added
      </div>
      <div className="p-2 space-y-0.5">
        {oldLines.map((line, i) => (
          <div key={`old-${i}`} className="text-red-400 bg-red-950/40 px-1 rounded leading-5">
            − {line}
          </div>
        ))}
        {newLines.map((line, i) => (
          <div key={`new-${i}`} className="text-green-400 bg-green-950/40 px-1 rounded leading-5">
            + {line}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Pane components ─────────────────────────────────────────────────────────

function LeftPane({
  turn,
  selectedToolIdx,
  onSelectTool,
}: {
  turn: ReplayTurn;
  selectedToolIdx: number;
  onSelectTool: (idx: number) => void;
}) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [inputExpanded, setInputExpanded] = useState(false);

  useEffect(() => {
    setThinkingExpanded(false);
    setInputExpanded(false);
  }, [turn.index]);

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 space-y-4">
      {/* Thinking */}
      {turn.thinking && (
        <div>
          <button
            onClick={() => setThinkingExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-300"
          >
            <svg
              className={`w-3 h-3 transition-transform ${thinkingExpanded ? "rotate-90" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Thinking
          </button>
          {thinkingExpanded && (
            <div className="mt-1.5 ml-4 text-xs text-gray-500 italic whitespace-pre-wrap leading-relaxed border-l-2 border-gray-700 pl-2">
              {turn.thinking}
            </div>
          )}
        </div>
      )}

      {/* Assistant text */}
      {turn.text ? (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
            Assistant
          </div>
          <div className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
            {turn.text}
          </div>
        </div>
      ) : (
        !turn.thinking && turn.toolCalls.length === 0 && (
          <div className="text-xs text-gray-600 italic">No assistant message in this turn.</div>
        )
      )}

      {/* Tool calls list */}
      {turn.toolCalls.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
            Tool Calls
          </div>
          <div className="space-y-1">
            {turn.toolCalls.map((tc, idx) => (
              <button
                key={tc.id || idx}
                onClick={() => onSelectTool(idx)}
                className={`w-full text-left flex items-start gap-2 px-2.5 py-1.5 rounded text-xs transition-colors ${
                  selectedToolIdx === idx
                    ? "bg-blue-900/60 border border-blue-700 text-blue-200"
                    : "bg-gray-800 hover:bg-gray-750 border border-gray-700 text-gray-300 hover:border-gray-600"
                }`}
              >
                <span className="shrink-0 mt-0.5">{toolIcon(tc.name)}</span>
                <span className="flex-1 min-w-0">
                  <span className="font-semibold">{tc.name}</span>
                  <span className="text-gray-400 ml-1.5 font-mono text-[11px] truncate block">
                    {summarizeInput(tc.name, tc.inputParsed)}
                  </span>
                </span>
                {tc.result?.isError && (
                  <span className="shrink-0 text-red-400 text-[10px]">✗</span>
                )}
                {tc.result && !tc.result.isError && (
                  <span className="shrink-0 text-green-400 text-[10px]">✓</span>
                )}
                {!tc.result && (
                  <span className="shrink-0 text-gray-600 text-[10px]">…</span>
                )}
              </button>
            ))}
          </div>

          {/* Selected tool input */}
          {turn.toolCalls[selectedToolIdx] && (
            <div className="mt-3">
              <button
                onClick={() => setInputExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-300 mb-1.5"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${inputExpanded ? "rotate-90" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                Input
              </button>
              {inputExpanded && (
                <pre className="text-[11px] bg-gray-900 border border-gray-700 rounded p-2 overflow-auto max-h-52 text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
                  {turn.toolCalls[selectedToolIdx].input.length > 4000
                    ? turn.toolCalls[selectedToolIdx].input.slice(0, 4000) + "\n… (truncated)"
                    : turn.toolCalls[selectedToolIdx].input}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RightPane({ turn, selectedToolIdx }: { turn: ReplayTurn; selectedToolIdx: number }) {
  const toolCall = turn.toolCalls[selectedToolIdx];

  if (!toolCall) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        {turn.toolCalls.length === 0 ? "No tool calls in this turn." : "Select a tool call on the left."}
      </div>
    );
  }

  const { name, inputParsed, result } = toolCall;

  // For Edit tools: show a diff view
  const isEditTool = name === "Edit" || name === "edit";
  if (isEditTool && inputParsed.old_str !== undefined && inputParsed.new_str !== undefined) {
    const filePath = (inputParsed.file_path as string) || "";
    return (
      <div className="h-full overflow-y-auto p-4 space-y-3">
        {filePath && (
          <div className="text-xs text-gray-400 font-mono bg-gray-800 rounded px-2 py-1 truncate">
            {filePath}
          </div>
        )}
        {renderEditDiff(String(inputParsed.old_str), String(inputParsed.new_str))}
        {result && (
          <div className="mt-2">
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Result</div>
            <pre className={`text-xs rounded p-2 font-mono whitespace-pre-wrap leading-relaxed max-h-32 overflow-auto ${
              result.isError
                ? "bg-red-950/40 border border-red-800 text-red-300"
                : "bg-gray-900 border border-gray-700 text-gray-300"
            }`}>
              {result.output.slice(0, 500) || "(empty)"}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // For Write/create tools: show the written content
  const isWriteTool = name === "Write" || name === "create";
  if (isWriteTool && inputParsed.file_path) {
    const content = (inputParsed.content as string) || (inputParsed.file_text as string) || "";
    return (
      <div className="h-full overflow-y-auto p-4 space-y-3">
        <div className="text-xs text-gray-400 font-mono bg-gray-800 rounded px-2 py-1 truncate">
          {String(inputParsed.file_path)}
        </div>
        <pre className="text-xs bg-gray-900 border border-gray-700 rounded p-2 overflow-auto max-h-96 text-green-300 font-mono whitespace-pre-wrap leading-relaxed">
          {content.length > 6000 ? content.slice(0, 6000) + "\n… (truncated)" : content || "(empty)"}
        </pre>
        {result && (
          <div>
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Result</div>
            <pre className={`text-xs rounded p-2 font-mono whitespace-pre-wrap max-h-24 overflow-auto ${
              result.isError
                ? "bg-red-950/40 border border-red-800 text-red-300"
                : "bg-gray-900 border border-gray-700 text-gray-400"
            }`}>
              {result.output.slice(0, 300) || "(empty)"}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // Default: show result output
  if (!result) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        No result yet.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
        {result.isError ? "❌ Error" : "✅ Result"}
      </div>
      <pre className={`text-xs rounded p-3 font-mono whitespace-pre-wrap leading-relaxed overflow-auto max-h-full ${
        result.isError
          ? "bg-red-950/40 border border-red-800 text-red-300"
          : "bg-gray-900 border border-gray-700 text-gray-300"
      }`}>
        {result.output.length > 8000
          ? result.output.slice(0, 8000) + "\n… (truncated)"
          : result.output || "(empty)"}
      </pre>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SessionReplay({
  sessionId,
  sessionLabel,
  outputFormat = "claude-stream-json",
  onClose,
}: SessionReplayProps) {
  const [turns, setTurns] = useState<ReplayTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentTurnIdx, setCurrentTurnIdx] = useState(0); // 0-based
  const [selectedToolIdx, setSelectedToolIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch<AgentOutputMessage[]>(`/api/sessions/${sessionId}/output`)
      .then((messages) => {
        const parsed = parseMessagesIntoTurns(messages ?? [], outputFormat);
        setTurns(parsed);
        setCurrentTurnIdx(0);
        setSelectedToolIdx(0);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load session output");
      })
      .finally(() => setLoading(false));
  }, [sessionId, outputFormat]);

  // Reset tool selection when turn changes
  useEffect(() => {
    setSelectedToolIdx(0);
  }, [currentTurnIdx]);

  const goTo = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(turns.length - 1, idx));
      setCurrentTurnIdx(clamped);
    },
    [turns.length],
  );

  // Keyboard navigation
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Don't steal keys when an input/textarea is focused
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      if (e.key === "j" || e.key === "ArrowRight") {
        e.preventDefault();
        goTo(currentTurnIdx + 1);
      } else if (e.key === "k" || e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(currentTurnIdx - 1);
      } else if (e.key === "g") {
        e.preventDefault();
        goTo(0);
      } else if (e.key === "G") {
        e.preventDefault();
        goTo(turns.length - 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentTurnIdx, goTo, turns.length, onClose]);

  const turn = turns[currentTurnIdx];

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[60] bg-gray-950 flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-900 border-b border-gray-700 shrink-0">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="text-sm font-semibold text-white flex-1 min-w-0 truncate">
          Session Replay
          {sessionLabel && (
            <span className="ml-2 text-gray-400 font-normal">{sessionLabel}</span>
          )}
        </div>
        {!loading && turns.length > 0 && (
          <div className="text-sm text-gray-400 shrink-0">
            Turn <span className="text-white font-semibold">{currentTurnIdx + 1}</span>
            {" / "}{turns.length}
          </div>
        )}
        <div className="text-[10px] text-gray-600 shrink-0 hidden sm:block">
          j/k ← → &nbsp;|&nbsp; g/G start/end &nbsp;|&nbsp; Esc close
        </div>
      </div>

      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-gray-400 text-sm animate-pulse">Loading session output…</div>
        </div>
      )}

      {error && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-red-400 text-sm">{error}</div>
        </div>
      )}

      {!loading && !error && turns.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-gray-500 text-sm">No turns found in this session.</div>
        </div>
      )}

      {!loading && !error && turns.length > 0 && (
        <>
          {/* Scrubber */}
          <div className="px-4 py-2 bg-gray-900 border-b border-gray-700 shrink-0">
            <div className="flex items-center gap-3">
              <button
                onClick={() => goTo(0)}
                disabled={currentTurnIdx === 0}
                className="text-gray-500 hover:text-white disabled:opacity-30 transition-colors"
                title="First turn (g)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7M18 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => goTo(currentTurnIdx - 1)}
                disabled={currentTurnIdx === 0}
                className="text-gray-500 hover:text-white disabled:opacity-30 transition-colors"
                title="Previous turn (k / ←)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>

              <div className="flex-1 relative">
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, turns.length - 1)}
                  value={currentTurnIdx}
                  onChange={(e) => goTo(Number(e.target.value))}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer
                    bg-gray-700 accent-blue-500"
                />
                {/* Tick marks for every 10th turn */}
                {turns.length > 10 && (
                  <div className="absolute top-3 left-0 right-0 flex justify-between px-0.5">
                    {Array.from({ length: Math.floor(turns.length / 10) }, (_, i) => {
                      const pos = ((i + 1) * 10 / (turns.length - 1)) * 100;
                      return pos <= 100 ? (
                        <div
                          key={i}
                          className="absolute w-px h-1 bg-gray-600"
                          style={{ left: `${pos}%` }}
                        />
                      ) : null;
                    })}
                  </div>
                )}
              </div>

              <button
                onClick={() => goTo(currentTurnIdx + 1)}
                disabled={currentTurnIdx === turns.length - 1}
                className="text-gray-500 hover:text-white disabled:opacity-30 transition-colors"
                title="Next turn (j / →)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button
                onClick={() => goTo(turns.length - 1)}
                disabled={currentTurnIdx === turns.length - 1}
                className="text-gray-500 hover:text-white disabled:opacity-30 transition-colors"
                title="Last turn (G)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M6 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>

          {/* Two-pane content */}
          <div className="flex-1 min-h-0 flex divide-x divide-gray-700">
            {/* Left pane */}
            <div className="w-1/2 flex flex-col min-h-0">
              <div className="px-4 py-2 bg-gray-900 border-b border-gray-700 flex items-center gap-2 shrink-0">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                  Turn {currentTurnIdx + 1}
                </span>
                {turn.thinking && (
                  <span className="text-[10px] text-gray-600">· has thinking</span>
                )}
                {turn.toolCalls.length > 0 && (
                  <span className="text-[10px] text-gray-600">
                    · {turn.toolCalls.length} tool{turn.toolCalls.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <LeftPane
                  turn={turn}
                  selectedToolIdx={selectedToolIdx}
                  onSelectTool={setSelectedToolIdx}
                />
              </div>
            </div>

            {/* Right pane */}
            <div className="w-1/2 flex flex-col min-h-0">
              <div className="px-4 py-2 bg-gray-900 border-b border-gray-700 flex items-center gap-2 shrink-0">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                  {turn.toolCalls[selectedToolIdx]
                    ? `${toolIcon(turn.toolCalls[selectedToolIdx].name)} ${turn.toolCalls[selectedToolIdx].name}`
                    : "Result"}
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <RightPane turn={turn} selectedToolIdx={selectedToolIdx} />
              </div>
            </div>
          </div>

          {/* Bottom stats bar */}
          <div className="shrink-0 px-4 py-2 bg-gray-900 border-t border-gray-700 flex items-center gap-4 text-[11px] text-gray-500">
            <span className="font-medium text-gray-400">
              Cumulative at turn {currentTurnIdx + 1}:
            </span>
            {turn.cumulativeInputTokens > 0 && (
              <span title="Input / output tokens">
                {formatTokenCount(turn.cumulativeInputTokens)} in
                {" / "}
                {formatTokenCount(turn.cumulativeOutputTokens)} out
              </span>
            )}
            {turn.cumulativeCostUsd > 0 && (
              <span>${turn.cumulativeCostUsd.toFixed(4)}</span>
            )}
            <span className="ml-auto text-gray-600">
              {turn.toolCalls.length > 0
                ? `${turn.toolCalls.filter((tc) => tc.result).length}/${turn.toolCalls.length} results`
                : "no tool calls"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
