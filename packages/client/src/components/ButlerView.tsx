import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { apiFetch } from "../lib/api.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";

interface ButlerState {
  active: boolean;
  sessionId: string | null;
  contextTokens?: number;
}

/** Event shape emitted by the server butler SSE stream (butler-sdk.service.ts). */
type ButlerEvent =
  | { type: "ready" }
  | { type: "session"; sessionId: string }
  | { type: "turn-start" }
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "result"; text?: string; isError?: boolean }
  | { type: "usage"; contextTokens: number }
  | { type: "error"; message: string };

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "activity";
  text: string;
  ts: number;
}

interface ButlerViewProps {
  projectId: string;
  columns: StatusWithIssues[];
  liveActivity: Record<string, string>;
  liveStats: Record<string, LiveSessionStats>;
  onIssueClick: (issue: IssueWithStatus) => void;
}

function formatRelativeTs(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function formatToolLabel(name: string): string {
  if (name === "Read") return "📄 Reading a file";
  if (name === "Write" || name === "Edit") return "✏️ Editing a file";
  if (name === "Bash") return "⚡ Running a command";
  if (name === "Glob" || name === "Grep") return "🔎 Searching the project";
  if (name === "WebSearch" || name === "WebFetch") return "🔍 Searching the web";
  if (name.includes("list_issues")) return "📋 Listing board issues";
  if (name.includes("get_board_status")) return "📊 Checking board status";
  return `🔧 ${name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ")}`;
}

function ActivityStrip({ columns, liveActivity, liveStats, onIssueClick }: Omit<ButlerViewProps, "projectId">) {
  const activeIssues = useMemo(() => {
    const result: IssueWithStatus[] = [];
    for (const col of columns) {
      for (const issue of col.issues) {
        const ws = issue.workspaceSummary?.main;
        if (ws && (ws.status === "active" || ws.status === "fixing" || ws.status === "reviewing")) {
          result.push(issue);
        }
      }
    }
    return result;
  }, [columns]);

  if (activeIssues.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 px-4 py-2 flex gap-2 flex-wrap items-center">
      <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 shrink-0">Active agents:</span>
      {activeIssues.map((issue) => {
        const ws = issue.workspaceSummary!.main!;
        const activity = liveActivity[issue.id];
        const stats = liveStats[issue.id];
        const statusDot = ws.status === "active" || ws.status === "fixing"
          ? "bg-green-500 animate-pulse"
          : "bg-violet-400";
        return (
          <button
            key={issue.id}
            onClick={() => onIssueClick(issue)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 text-xs text-gray-700 dark:text-gray-300 transition-colors max-w-[260px]"
            title={activity || `#${issue.issueNumber} ${issue.title}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
            <span className="font-medium text-gray-500 dark:text-gray-400">#{issue.issueNumber}</span>
            <span className="truncate">{issue.title}</span>
            {stats && (
              <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                {Math.round(stats.contextTokens / 1000)}k
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] bg-blue-600 text-white rounded-2xl rounded-tr-md px-4 py-2.5 shadow-sm">
          <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
          <p className="text-[10px] text-blue-200 mt-1 text-right">{formatRelativeTs(msg.ts)}</p>
        </div>
      </div>
    );
  }

  if (msg.role === "activity") {
    return (
      <div className="flex justify-center mb-1">
        <span className="text-[11px] text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 rounded-full">
          {msg.text}
        </span>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl rounded-tl-md px-4 py-2.5 shadow-sm">
        <div className="text-sm text-gray-800 dark:text-gray-200 prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-1">
          <ReactMarkdown>{msg.text}</ReactMarkdown>
        </div>
        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{formatRelativeTs(msg.ts)}</p>
      </div>
    </div>
  );
}

export function ButlerView({ projectId, columns, liveActivity, liveStats, onIssueClick }: ButlerViewProps) {
  const [butlerState, setButlerState] = useState<ButlerState | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [contextTokens, setContextTokens] = useState(0);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [customizePrompt, setCustomizePrompt] = useState("");
  const [customizeBusy, setCustomizeBusy] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const assistantBufRef = useRef("");
  const assistantMsgIdRef = useRef<string | null>(null);

  // Append/replace the streaming assistant bubble as text deltas arrive.
  function appendAssistantText(delta: string) {
    assistantBufRef.current += delta;
    const text = assistantBufRef.current;
    setChatMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.id === assistantMsgIdRef.current) {
        return [...prev.slice(0, -1), { ...last, text }];
      }
      const id = `asst-${Date.now()}-${Math.random()}`;
      assistantMsgIdRef.current = id;
      return [...prev, { id, role: "assistant", text, ts: Date.now() }];
    });
  }

  function handleButlerEvent(e: ButlerEvent) {
    switch (e.type) {
      case "session":
        setButlerState({ active: true, sessionId: e.sessionId });
        break;
      case "usage":
        setContextTokens(e.contextTokens);
        break;
      case "turn-start":
        setSending(true);
        assistantBufRef.current = "";
        assistantMsgIdRef.current = null;
        break;
      case "text":
        appendAssistantText(e.text);
        break;
      case "tool":
        setChatMessages((prev) => [...prev, { id: `act-${Date.now()}-${Math.random()}`, role: "activity", text: formatToolLabel(e.name), ts: Date.now() }]);
        break;
      case "result":
        assistantBufRef.current = "";
        assistantMsgIdRef.current = null;
        setSending(false);
        break;
      case "error":
        setChatMessages((prev) => [...prev, { id: `err-${Date.now()}`, role: "activity", text: `Error: ${e.message}`, ts: Date.now() }]);
        setSending(false);
        break;
      case "ready":
      default:
        break;
    }
  }

  function openStream() {
    eventSourceRef.current?.close();
    const es = new EventSource(`/api/projects/${projectId}/butler/stream`);
    es.onmessage = (ev) => {
      try {
        handleButlerEvent(JSON.parse(ev.data) as ButlerEvent);
      } catch {
        // ignore non-JSON (heartbeat pings use a named event, not onmessage)
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
    eventSourceRef.current = es;
  }

  // Load butler state on mount / project change, and open the stream if active.
  useEffect(() => {
    setLoadingState(true);
    setButlerState(null);
    setChatMessages([]);
    setSending(false);
    setContextTokens(0);
    setCustomizeOpen(false);
    assistantBufRef.current = "";
    assistantMsgIdRef.current = null;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    apiFetch<ButlerState>(`/api/projects/${projectId}/butler`)
      .then((state) => {
        setButlerState(state);
        setContextTokens(state.contextTokens ?? 0);
        if (state.active) openStream();
      })
      .catch(() => setButlerState({ active: false, sessionId: null }))
      .finally(() => setLoadingState(false));

    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  async function handleStart() {
    setStarting(true);
    try {
      const result = await apiFetch<ButlerState>(
        `/api/projects/${projectId}/butler/ensure`,
        { method: "POST", body: "{}" },
      );
      setButlerState({ active: true, sessionId: result.sessionId });
      openStream();
    } catch (err) {
      console.error("Failed to start butler", err);
    } finally {
      setStarting(false);
    }
  }

  // Clear the butler's conversation context: stop+forget the session, wipe the chat.
  // The next message starts a fresh session (also re-reads any customized skill).
  async function handleClearContext() {
    if (sending) return;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    try {
      await apiFetch(`/api/projects/${projectId}/butler`, { method: "DELETE" });
    } catch { /* ignore */ }
    setChatMessages([]);
    setContextTokens(0);
    assistantBufRef.current = "";
    assistantMsgIdRef.current = null;
    setButlerState({ active: true, sessionId: null });
    openStream();
  }

  async function openCustomize() {
    setCustomizeOpen(true);
    setCustomizeBusy(true);
    try {
      const r = await apiFetch<{ prompt: string; isOverride: boolean }>(`/api/projects/${projectId}/butler/skill`);
      setCustomizePrompt(r.prompt);
    } catch {
      setCustomizePrompt("");
    } finally {
      setCustomizeBusy(false);
    }
  }

  async function saveCustomize() {
    setCustomizeBusy(true);
    try {
      await apiFetch(`/api/projects/${projectId}/butler/skill`, {
        method: "PUT",
        body: JSON.stringify({ prompt: customizePrompt }),
      });
      setCustomizeOpen(false);
      // Apply immediately: a fresh session re-reads the skill.
      await handleClearContext();
    } catch (err) {
      console.error("Failed to save butler customization", err);
    } finally {
      setCustomizeBusy(false);
    }
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || sending || !butlerState?.active) return;

    const userMsg: ChatMessage = { id: `user-${Date.now()}`, role: "user", text: content, ts: Date.now() };
    setChatMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);
    assistantBufRef.current = "";
    assistantMsgIdRef.current = null;

    try {
      await apiFetch<{ ok: boolean }>(
        `/api/projects/${projectId}/butler/message`,
        { method: "POST", body: JSON.stringify({ content }) },
      );
    } catch (err) {
      setChatMessages((prev) => [...prev, {
        id: `err-${Date.now()}`,
        role: "activity",
        text: `Error: ${err instanceof Error ? err.message : "Failed to send message"}`,
        ts: Date.now(),
      }]);
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const hasButler = butlerState?.active === true;

  if (loadingState) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        <div className="flex items-center gap-2">
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          <span className="text-sm">Loading butler...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ActivityStrip columns={columns} liveActivity={liveActivity} liveStats={liveStats} onIssueClick={onIssueClick} />

      {!hasButler ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-sm">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shadow-lg">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Project Butler</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              A warm, persistent Claude agent that lives in your repository. Ask questions, get summaries, or run quick tasks — all without creating a new workspace.
            </p>
            <button
              onClick={handleStart}
              disabled={starting}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 shadow-sm"
            >
              {starting ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Starting butler...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <polygon points="5,3 19,12 5,21" fill="currentColor" stroke="none" />
                  </svg>
                  Start Butler
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Butler toolbar: context usage + clear + customize */}
          <div className="shrink-0 flex items-center justify-end gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-1.5 text-xs">
            <span
              className="text-gray-400 dark:text-gray-500 mr-auto"
              title="Approximate context-window tokens used by the butler's conversation"
            >
              {contextTokens > 0 ? `${(contextTokens / 1000).toFixed(1)}k context` : "warm session"}
            </span>
            <button
              onClick={openCustomize}
              className="px-2 py-1 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title="Customize the butler's behavior (edits the project's butler skill)"
            >
              ⚙ Customize
            </button>
            <button
              onClick={handleClearContext}
              disabled={sending}
              className="px-2 py-1 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
              title="Clear the butler's conversation context and start fresh"
            >
              🧹 Clear context
            </button>
          </div>

          {customizeOpen && (
            <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-4 py-3">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Butler behavior (project override)</span>
                  <span className="text-[10px] text-gray-400 dark:text-gray-500">Placeholders: {"{{projectName}}"}, {"{{repoPath}}"}, {"{{serverPort}}"}</span>
                </div>
                <textarea
                  value={customizePrompt}
                  onChange={(e) => setCustomizePrompt(e.target.value)}
                  disabled={customizeBusy}
                  rows={8}
                  className="w-full resize-y rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                  placeholder="Leave empty to revert to the default butler behavior."
                />
                <div className="flex items-center justify-end gap-2 mt-2">
                  <button onClick={() => setCustomizeOpen(false)} disabled={customizeBusy} className="px-3 py-1.5 text-xs rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">Cancel</button>
                  <button onClick={saveCustomize} disabled={customizeBusy} className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
                    {customizeBusy ? "Saving…" : "Save & apply"}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">Saving clears the current context so the new behavior takes effect immediately.</p>
              </div>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
            {chatMessages.length === 0 && (
              <div className="flex items-center justify-center h-full text-center">
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Butler is ready.</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Ask anything about your project or the board.</p>
                </div>
              </div>
            )}
            <div className="max-w-3xl mx-auto">
              {chatMessages.map((msg) => (
                <ChatBubble key={msg.id} msg={msg} />
              ))}
              {sending && (
                <div className="flex justify-start mb-3">
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl rounded-tl-md px-4 py-2.5 flex items-center gap-1.5 shadow-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3">
            <div className="max-w-3xl mx-auto flex items-end gap-2">
              <div className="flex-1 relative">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={sending}
                  rows={1}
                  placeholder="Message the butler... (Enter to send, Shift+Enter for new line)"
                  className="w-full resize-none rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2.5 pr-10 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600 transition-all disabled:opacity-50"
                  style={{ minHeight: "42px", maxHeight: "160px", overflowY: "auto" }}
                  onInput={(e) => {
                    const t = e.target as HTMLTextAreaElement;
                    t.style.height = "auto";
                    t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
                  }}
                />
              </div>
              <button
                onClick={handleSend}
                disabled={!input.trim() || sending}
                className="shrink-0 p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
                title="Send message"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              </button>
            </div>
            <p className="max-w-3xl mx-auto mt-1 text-[10px] text-gray-400 dark:text-gray-500">
              {sending ? (
                <span className="flex items-center gap-1">
                  <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Butler is thinking...
                </span>
              ) : (
                "Persistent warm butler · runs in your project repo · Enter to send"
              )}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
