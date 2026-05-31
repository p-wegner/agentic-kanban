import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch } from "../lib/api.js";
import { CLAUDE_MODEL_OPTIONS } from "@agentic-kanban/shared";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import { AgentQuestionsPanel } from "./AgentQuestionsPanel.js";
import { ButlerVoiceButton, type ButlerVoiceButtonHandle } from "./ButlerVoiceButton.js";

interface ButlerState {
  backend?: "claude" | "codex";
  active: boolean;
  sessionId: string | null;
  contextTokens?: number;
  model?: string;
  contextWindow?: number;
  mcpConnected?: boolean;
  selectedModel?: string;
  selectedProfile?: string;
}

interface ButlerCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** Event shape emitted by the server butler SSE stream (butler-sdk.service.ts). */
type ButlerEvent =
  | { type: "ready" }
  | { type: "session"; sessionId: string }
  | { type: "turn-start" }
  | { type: "user"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "result"; text?: string; isError?: boolean }
  | { type: "usage"; contextTokens: number }
  | { type: "meta"; model?: string; contextWindow?: number; mcpConnected?: boolean }
  | { type: "error"; message: string };

/** Format a context-window size: 1000000 -> "1M", 200000 -> "200k". */
function formatWindow(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "activity";
  text: string;
  ts: number;
}

interface ButlerSessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  title: string;
  turnCount: number;
  model?: string;
}

interface ButlerSessionMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

interface ButlerViewProps {
  projectId: string;
  columns: StatusWithIssues[];
  liveActivity: Record<string, string>;
  liveStats: Record<string, LiveSessionStats>;
  onIssueClick: (issue: IssueWithStatus) => void;
  onExit?: () => void;
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
  if (name === "Read") return "Reading a file";
  if (name === "Write" || name === "Edit") return "Editing a file";
  if (name === "Bash") return "Running a command";
  if (name === "Glob" || name === "Grep") return "Searching the project";
  if (name === "WebSearch" || name === "WebFetch") return "Searching the web";
  if (name.includes("list_issues")) return "Listing board issues";
  if (name.includes("get_board_status")) return "Checking board status";
  return `[tool] ${name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ")}`;
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
          : "bg-accent-500";
        return (
          <button
            key={issue.id}
            onClick={() => onIssueClick(issue)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 hover:border-brand-300 dark:hover:border-brand-600 text-xs text-gray-700 dark:text-gray-300 transition-colors max-w-[260px]"
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
        <div className="max-w-[80%] bg-brand-600 text-white rounded-2xl rounded-tr-md px-4 py-2.5 shadow-sm">
          <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
          <p className="text-[10px] text-brand-200 mt-1 text-right">{formatRelativeTs(msg.ts)}</p>
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
      <div className="max-w-[80%] bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded-2xl rounded-tl-md px-4 py-2.5 shadow-sm">
        <div className="text-sm text-gray-800 dark:text-gray-200 prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-1 prose-table:my-1 prose-headings:mt-2 prose-headings:mb-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{formatRelativeTs(msg.ts)}</p>
      </div>
    </div>
  );
}
/** A defined butler plus this project's runtime state for it (GET /:id/butlers). */
interface ButlerListItem {
  id: string;
  name: string;
  model: string;
  active: boolean;
  busy: boolean;
  contextTokens: number;
  contextWindow?: number;
  sessionId: string | null;
  mcpConnected?: boolean;
  backend?: "claude" | "codex";
}

function backendLabel(backend?: string): string {
  return backend === "codex" ? "Codex" : "Claude";
}

function modelLabel(value: string): string {
  return CLAUDE_MODEL_OPTIONS.find((m) => m.value === value)?.label ?? value;
}

/** Compact butler switcher — a labelled select of the defined butlers plus a gear
 *  to open the manage dialog. A filled dot marks butlers with a warm session. */
function ButlerSwitcher({ butlers, activeId, onSelect, onManage, disabled }: {
  butlers: ButlerListItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onManage: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0" title="Switch butlers — each keeps its own warm context and model">
      <svg className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
      </svg>
      <select
        value={activeId}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled}
        data-testid="butler-switcher"
        className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50 max-w-[180px]"
      >
        {butlers.map((b) => (
          <option key={b.id} value={b.id}>
            {b.active ? "● " : "○ "}{b.name}{b.model ? ` · ${modelLabel(b.model)}` : ""}
          </option>
        ))}
      </select>
      <button
        onClick={onManage}
        disabled={disabled}
        title="Manage butlers (add, rename, set model, remove)"
        className="inline-flex items-center justify-center w-7 h-7 rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-100 transition-colors disabled:opacity-50"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
        </svg>
      </button>
    </div>
  );
}

interface ButlerDef { id: string; name: string; model: string; }

/** Modal for managing the global set of butlers: add, rename, set model, remove. Capped server-side. */
function ButlerManageModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<ButlerDef[]>([]);
  const [max, setMax] = useState(4);
  const [newName, setNewName] = useState("");
  const [newModel, setNewModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const r = await apiFetch<{ butlers: ButlerDef[]; max: number }>("/api/butler-definitions");
      setItems(r.butlers);
      setMax(r.max);
      onChanged();
    } catch { /* ignore */ }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }

  async function callDef(path: string, init: { method: string; body?: unknown }) {
    const res = await fetch(`/api/butler-definitions${path}`, {
      method: init.method,
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-surface dark:bg-surface-dark border border-gray-200 dark:border-gray-700 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-ink dark:text-stone-100">Manage butlers</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none">×</button>
        </div>
        <div className="px-5 py-4 space-y-2 max-h-[60vh] overflow-y-auto">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Butlers are shared across all projects; each keeps its own warm conversation per project. Up to {max}.
          </p>
          {items.map((b) => (
            <div key={b.id} className="flex items-center gap-2">
              <input
                defaultValue={b.name}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== b.name) void run(() => callDef(`/${b.id}`, { method: "PUT", body: { name: v } })); }}
                disabled={busy}
                className="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-2 py-1 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <select
                value={b.model}
                onChange={(e) => void run(() => callDef(`/${b.id}`, { method: "PUT", body: { model: e.target.value } }))}
                disabled={busy}
                className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {CLAUDE_MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <button
                onClick={() => void run(() => callDef(`/${b.id}`, { method: "DELETE" }))}
                disabled={busy || b.id === "default"}
                title={b.id === "default" ? "The default butler can't be removed" : "Remove this butler"}
                className="text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-gray-400 px-1"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" /></svg>
              </button>
            </div>
          ))}
          {items.length < max && (
            <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-800 mt-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New butler name (e.g. Quick)"
                disabled={busy}
                className="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-2 py-1 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <select value={newModel} onChange={(e) => setNewModel(e.target.value)} disabled={busy} className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500">
                {CLAUDE_MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <button
                onClick={() => { if (newName.trim()) void run(async () => { await callDef("", { method: "POST", body: { name: newName.trim(), model: newModel } }); setNewName(""); setNewModel(""); }); }}
                disabled={busy || !newName.trim()}
                className="px-3 py-1 rounded bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium disabled:opacity-50"
              >
                Add
              </button>
            </div>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}

export function ButlerView({ projectId, columns, liveActivity, liveStats, onIssueClick, onExit }: ButlerViewProps) {
  const [butlerState, setButlerState] = useState<ButlerState | null>(null);
  const [backend, setBackend] = useState<"claude" | "codex">("claude");
  const [loadingState, setLoadingState] = useState(true);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");
  // Live preview of the in-progress voice phrase (not yet appended to `input`).
  const [interimVoiceText, setInterimVoiceText] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [contextTokens, setContextTokens] = useState(0);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [contextWindow, setContextWindow] = useState<number | undefined>(undefined);
  const [mcpConnected, setMcpConnected] = useState<boolean | undefined>(undefined);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [customizePrompt, setCustomizePrompt] = useState("");
  const [customizeBusy, setCustomizeBusy] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  // History panel (past butler sessions from disk JSONL).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<ButlerSessionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTranscript, setHistoryTranscript] = useState<{ session: ButlerSessionSummary; messages: ButlerSessionMessage[] } | null>(null);
  // Model picker (switches in-place, no context loss) + profile picker (restarts fresh).
  const [selectedModel, setSelectedModel] = useState("");
  const [profiles, setProfiles] = useState<string[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [globalProfile, setGlobalProfile] = useState("");
  const [switchingProfile, setSwitchingProfile] = useState(false);
  // Slash-command autocomplete.
  const [commands, setCommands] = useState<ButlerCommand[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  // Multiple butlers: the defined set (+ this project's warm state) and the one in view.
  const [butlers, setButlers] = useState<ButlerListItem[]>([]);
  const [activeButlerId, setActiveButlerId] = useState("default");
  const activeButlerIdRef = useRef("default");
  const [manageOpen, setManageOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const assistantBufRef = useRef("");
  const assistantMsgIdRef = useRef<string | null>(null);
  const assistantTextSeenRef = useRef(false);
  const inputValueRef = useRef("");
  const voiceButtonRef = useRef<ButlerVoiceButtonHandle>(null);
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const profileSelectRef = useRef<HTMLSelectElement>(null);
  const hasDictatedRef = useRef(false);
  const voiceInterimRef = useRef("");

  const sanitizeSpeechText = (value: string) => (
    value
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
      .replace(/[\u200B\u200C\u200D\u2060\u180E\u200E\u200F\uFEFF]/g, "")
      .trim()
  );

  const setInputValue = (valueOrUpdater: string | ((prev: string) => string)) => {
    const nextValue = typeof valueOrUpdater === "function" ? valueOrUpdater(inputValueRef.current) : valueOrUpdater;
    inputValueRef.current = nextValue;
    setInput(nextValue);
  };

  // Append/replace the streaming assistant bubble as text deltas arrive.
  function appendAssistantText(delta: string) {
    if (!delta) return;
    assistantTextSeenRef.current = true;
    assistantBufRef.current += delta;
    const text = assistantBufRef.current;
    // Decide the bubble id OUTSIDE the state updater. Mutating the ref inside the
    // updater makes it impure, so React StrictMode's double-invocation runs it twice
    // and spawns a duplicate (orphan) bubble. Setting the id here keeps the updater pure.
    if (!assistantMsgIdRef.current) {
      assistantMsgIdRef.current = `asst-${Date.now()}-${Math.random()}`;
    }
    const id = assistantMsgIdRef.current;
    setChatMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.id === id) {
        return [...prev.slice(0, -1), { ...last, text }];
      }
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
      case "meta":
        if (e.model) setModel(e.model);
        if (e.contextWindow) setContextWindow(e.contextWindow);
        if (e.mcpConnected !== undefined) setMcpConnected(e.mcpConnected);
        break;
      case "turn-start":
        setSending(true);
        assistantBufRef.current = "";
        assistantMsgIdRef.current = null;
        assistantTextSeenRef.current = false;
        break;
      case "user":
        // A prompt sent from outside this UI (CLI/MCP `ask`). Render it so the
        // butler isn't seen acting on an invisible request. Deduped against the
        // optimistic bubble this view adds for prompts it sent itself.
        setChatMessages((prev) => {
          const recentDup = prev.slice(-4).some((m) => m.role === "user" && m.text === e.text);
          if (recentDup) return prev;
          return [...prev, { id: `user-ext-${Date.now()}`, role: "user", text: e.text, ts: Date.now() }];
        });
        break;
      case "text":
        appendAssistantText(e.text);
        break;
      case "tool":
        // A tool call ends the current text run. Reset the streaming buffer + bubble
        // id so any text that streams AFTER the tool starts a fresh bubble with an
        // empty buffer. Without this, the next text run keeps appending to the prior
        // run's accumulated text and â€” because `last` is now this activity bubble, not
        // the assistant bubble â€” spawns a NEW bubble that repeats the earlier text.
        assistantBufRef.current = "";
        assistantMsgIdRef.current = null;
        setChatMessages((prev) => [...prev, { id: `act-${Date.now()}-${Math.random()}`, role: "activity", text: formatToolLabel(e.name), ts: Date.now() }]);
        break;
      case "result":
        if (e.text && !assistantTextSeenRef.current) {
          if (e.isError) {
            setChatMessages((prev) => [...prev, { id: `err-${Date.now()}`, role: "activity", text: `Error: ${e.text}`, ts: Date.now() }]);
          } else {
            appendAssistantText(e.text);
          }
        }
        assistantBufRef.current = "";
        assistantMsgIdRef.current = null;
        assistantTextSeenRef.current = false;
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

  // Build a butler endpoint URL for the butler currently in view (read from the ref so
  // it's correct inside callbacks/closures even right after a switch). The default
  // butler omits the query param so it hits the legacy (unsuffixed) server keys.
  function butlerUrl(path: string): string {
    const id = activeButlerIdRef.current;
    const base = `/api/projects/${projectId}/butler${path}`;
    if (!id || id === "default") return base;
    return `${base}${path.includes("?") ? "&" : "?"}butler=${encodeURIComponent(id)}`;
  }

  async function fetchButlers() {
    try {
      const r = await apiFetch<{ butlers: ButlerListItem[] }>(`/api/projects/${projectId}/butlers`);
      setButlers(r.butlers);
      return r.butlers;
    } catch {
      return [] as ButlerListItem[];
    }
  }

  // Load the in-view butler's state, restore its transcript, and open its stream.
  // Used on mount and whenever the user switches butlers (reads the ref, not state).
  async function loadActiveButler() {
    setChatMessages([]);
    setSending(false);
    setContextTokens(0);
    setModel(undefined);
    setContextWindow(undefined);
    setMcpConnected(undefined);
    assistantBufRef.current = "";
    assistantMsgIdRef.current = null;
    assistantTextSeenRef.current = false;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    try {
      const state = await apiFetch<ButlerState>(butlerUrl(""));
      setButlerState(state);
      setBackend(state.backend ?? "claude");
      setContextTokens(state.contextTokens ?? 0);
      setModel(state.model);
      setContextWindow(state.contextWindow);
      setMcpConnected(state.mcpConnected);
      setSelectedModel(state.selectedModel ?? "");
      if (state.active) {
        try {
          const { messages } = await apiFetch<{ messages: { role: "user" | "assistant"; text: string; ts: number }[] }>(butlerUrl("/messages"));
          if (messages.length) {
            setChatMessages(messages.map((m, i) => ({ id: `hist-${i}-${m.ts}`, role: m.role, text: m.text, ts: m.ts })));
          }
        } catch { /* no history available */ }
        openStream();
        void loadCapabilities();
      }
    } catch {
      setButlerState({ active: false, sessionId: null });
    }
  }

  // Switch the butler in view: persist the choice, then reload its state + stream.
  function selectButler(id: string) {
    if (id === activeButlerIdRef.current) return;
    activeButlerIdRef.current = id;
    setActiveButlerId(id);
    try { localStorage.setItem(`butler:active:${projectId}`, id); } catch { /* ignore */ }
    void loadActiveButler();
    void fetchButlers();
  }

  function openStream() {
    eventSourceRef.current?.close();
    const es = new EventSource(butlerUrl("/stream"));
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

  // Fetch the command + profile lists. Commands come from the live SDK session
  // (merged with the repo's .claude/skills server-side), so retry once if the
  // session hasn't finished discovery yet. The model list is static (the basic
  // Claude Code tiers, CLAUDE_MODEL_OPTIONS) â€” only the selection is server state.
  async function loadCapabilities(attempt = 0) {
    try {
      const [cmdData, profData] = await Promise.all([
        apiFetch<{ commands: ButlerCommand[] }>(butlerUrl("/commands")),
        apiFetch<{ provider?: "claude" | "codex"; profiles: string[]; selected: string; globalDefault: string }>(`/api/projects/${projectId}/butler/profiles`),
      ]);
      setCommands(cmdData.commands);
      setBackend(profData.provider ?? "claude");
      setProfiles(profData.profiles);
      setSelectedProfile(profData.selected);
      setGlobalProfile(profData.globalDefault);
      if (cmdData.commands.length === 0 && attempt < 2) {
        setTimeout(() => void loadCapabilities(attempt + 1), 2000);
      }
    } catch { /* capabilities are best-effort */ }
  }

  // Load butler state on mount / project change, and open the stream if active.
  useEffect(() => {
    setLoadingState(true);
    setButlerState(null);
    setBackend("claude");
    setChatMessages([]);
    setSending(false);
    setContextTokens(0);
    setModel(undefined);
    setContextWindow(undefined);
    setMcpConnected(undefined);
    setCustomizeOpen(false);
    setHistoryOpen(false);
    setHistoryTranscript(null);
    setHistorySessions([]);
    setSelectedModel("");
    setProfiles([]);
    setSelectedProfile("");
    setGlobalProfile("");
    setCommands([]);
    setCommandIndex(0);
    setButlers([]);
    assistantBufRef.current = "";
    assistantMsgIdRef.current = null;
    assistantTextSeenRef.current = false;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    // Resolve which butler to show: the last one used for this project (if it still
    // exists), else the default. Then load that butler's state + stream.
    let stored = "default";
    try { stored = localStorage.getItem(`butler:active:${projectId}`) || "default"; } catch { /* ignore */ }
    void (async () => {
      const list = await fetchButlers();
      const initial = list.some((b) => b.id === stored) ? stored : "default";
      activeButlerIdRef.current = initial;
      setActiveButlerId(initial);
      await loadActiveButler();
      setLoadingState(false);
    })();

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
        butlerUrl("/ensure"),
        { method: "POST", body: "{}" },
      );
      setButlerState({ active: true, sessionId: result.sessionId });
      openStream();
      void loadCapabilities();
      void fetchButlers();
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
      await apiFetch(butlerUrl(""), { method: "DELETE" });
    } catch { /* ignore */ }
    setChatMessages([]);
    setContextTokens(0);
    assistantBufRef.current = "";
    assistantMsgIdRef.current = null;
    assistantTextSeenRef.current = false;
    setButlerState({ active: true, sessionId: null });
    openStream();
    void fetchButlers();
  }

  async function handleNewSession() {
    await handleClearContext();
    inputRef.current?.focus();
  }

  // Switch model without restarting â€” the server uses the SDK setModel control
  // request, so the conversation context is preserved.
  async function handleModelChange(value: string) {
    setSelectedModel(value);
    try {
      await apiFetch(butlerUrl("/model"), {
        method: "POST",
        body: JSON.stringify({ model: value }),
      });
      void fetchButlers(); // reflect the new model label in the switcher
    } catch (err) {
      console.error("Failed to switch butler model", err);
    }
  }

  function cycleModel() {
    if (sending || CLAUDE_MODEL_OPTIONS.length === 0) return;
    const current = selectedModel || model || CLAUDE_MODEL_OPTIONS[0]?.value;
    const currentIndex = CLAUDE_MODEL_OPTIONS.findIndex((item) => item.value === current);
    const next = CLAUDE_MODEL_OPTIONS[(currentIndex + 1 + CLAUDE_MODEL_OPTIONS.length) % CLAUDE_MODEL_OPTIONS.length];
    if (next) {
      void handleModelChange(next.value);
      modelSelectRef.current?.focus();
    }
  }

  // Switch Claude profile â€” this changes auth/endpoint, so the butler is restarted
  // fresh (new instance, new context). We mirror that by wiping the local chat.
  async function handleProfileChange(value: string) {
    if (sending || switchingProfile) return;
    setSelectedProfile(value);
    setSwitchingProfile(true);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    try {
      await apiFetch(butlerUrl("/profile"), {
        method: "POST",
        body: JSON.stringify({ profile: value }),
      });
      setChatMessages([]);
      setContextTokens(0);
      setModel(undefined);
      assistantBufRef.current = "";
      assistantMsgIdRef.current = null;
      assistantTextSeenRef.current = false;
      setButlerState({ active: true, sessionId: null });
      openStream();
      void loadCapabilities();
    } catch (err) {
      console.error("Failed to switch butler profile", err);
    } finally {
      setSwitchingProfile(false);
    }
  }

  function cycleProfile() {
    const options = ["", ...profiles];
    if (sending || switchingProfile || options.length === 0) return;
    if (options.length === 1) {
      profileSelectRef.current?.focus();
      return;
    }
    const currentIndex = options.indexOf(selectedProfile);
    const next = options[(currentIndex + 1 + options.length) % options.length];
    void handleProfileChange(next);
  }

  function closeOpenPanel(): boolean {
    if (manageOpen) {
      setManageOpen(false);
      return true;
    }
    if (historyTranscript) {
      setHistoryTranscript(null);
      return true;
    }
    if (historyOpen) {
      setHistoryOpen(false);
      return true;
    }
    if (customizeOpen) {
      setCustomizeOpen(false);
      return true;
    }
    return false;
  }

  function shouldExitButler() {
    return !inputValueRef.current.trim() && !commandMenuOpen && !customizeOpen && !historyOpen && !manageOpen;
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

  async function openHistory() {
    setHistoryOpen((prev) => !prev);
    if (historyOpen) return;
    setHistoryTranscript(null);
    setHistoryLoading(true);
    try {
      const r = await apiFetch<{ sessions: ButlerSessionSummary[] }>(butlerUrl("/sessions?limit=5"));
      setHistorySessions(r.sessions);
    } catch {
      setHistorySessions([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function openHistoryTranscript(session: ButlerSessionSummary) {
    setHistoryTranscript({ session, messages: [] });
    try {
      const r = await apiFetch<{ messages: ButlerSessionMessage[] }>(butlerUrl(`/sessions/${session.sessionId}/messages`));
      setHistoryTranscript({ session, messages: r.messages });
    } catch {
      // keep empty messages
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

  // Append a finalized dictation chunk to the input, inserting a space when
  // continuing an existing message. Keeps the textarea auto-grow in sync.
  function appendVoiceTranscript(chunk: string) {
    const safeChunk = sanitizeSpeechText(chunk);
    if (!safeChunk) return;

    hasDictatedRef.current = true;
    setInputValue((prev) => {
      const sep = prev.length > 0 && !/\s$/.test(prev) ? " " : "";
      return prev + sep + safeChunk;
    });
    requestAnimationFrame(() => {
      const t = inputRef.current;
      if (t) {
        t.style.height = "auto";
        t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
      }
    });
  }

  async function handleSend(explicitContent?: string) {
    const content = (explicitContent ?? inputValueRef.current).trim();
    if (!content || sending || !butlerState?.active) return;

    const userMsg: ChatMessage = { id: `user-${Date.now()}`, role: "user", text: content, ts: Date.now() };
    setChatMessages((prev) => [...prev, userMsg]);
    setInputValue("");
    hasDictatedRef.current = false;
    setSending(true);
    assistantBufRef.current = "";
    assistantMsgIdRef.current = null;
    assistantTextSeenRef.current = false;

    try {
      await apiFetch<{ ok: boolean }>(
        butlerUrl("/message"),
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

  // Slash-command autocomplete: active when the token at the cursor (start of input
  // or after whitespace) begins with "/". Matches the leading "/<partial>".
  const slashMatch = /(?:^|\s)\/([\w:-]*)$/.exec(input);
  const commandQuery = slashMatch?.[1] ?? "";
  const filteredCommands = slashMatch && commands.length > 0
    ? commands.filter((cmd) => cmd.name.toLowerCase().includes(commandQuery.toLowerCase())).slice(0, 8)
    : [];
  const commandMenuOpen = filteredCommands.length > 0;

  // Keep the highlighted suggestion in range as the query narrows.
  useEffect(() => {
    setCommandIndex(0);
  }, [commandQuery, commandMenuOpen]);

  // Replace the trailing "/<partial>" with the chosen "/name " token.
  function applyCommand(name: string) {
    const m = /(?:^|\s)\/([\w:-]*)$/.exec(input);
    if (!m) return;
    const slashStart = m.index + m[0].length - (m[1].length + 1); // position of the "/"
    const next = `${input.slice(0, slashStart)}/${name} `;
    setInputValue(next);
    setCommandIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Stop the butler's in-flight turn (interrupt) without clearing the conversation.
  async function handleStop() {
    if (!sending) return;
    try {
      await apiFetch(butlerUrl("/interrupt"), { method: "POST", body: "{}" });
    } catch (err) {
      console.error("Failed to stop butler", err);
    }
    // The interrupt broadcasts a result which flips `sending` off; reset locally too.
    setSending(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (commandMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyCommand(filteredCommands[commandIndex].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Collapse the menu without clearing the input by appending a space.
        setInputValue((v) => `${v} `);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSend();
      return;
    }
    if (e.key === "Escape") {
      if (closeOpenPanel()) {
        e.preventDefault();
        return;
      }
      if (shouldExitButler()) {
        e.preventDefault();
        onExit?.();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const hasButler = butlerState?.active === true;

  useEffect(() => {
    if (!hasButler) return;

    const isSpaceEvent = (e: KeyboardEvent) => (
      e.code === "Space"
      || e.key === " "
      || e.key === "Spacebar"
      || (e.keyCode ?? 0) === 32
    );

    const onKeyDown = (e: KeyboardEvent) => {
      const hasCommandModifier = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if ((e.key === "Enter" && hasCommandModifier) || (key === "l" && hasCommandModifier) || (key === "p" && hasCommandModifier) || (key === "m" && hasCommandModifier) || (key === "x" && hasCommandModifier && e.shiftKey) || (key === "n" && hasCommandModifier && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter") {
          void handleSend();
        } else if (key === "l" || key === "x") {
          void handleClearContext();
        } else if (key === "p") {
          cycleProfile();
        } else if (key === "m") {
          cycleModel();
        } else if (key === "n") {
          void handleNewSession();
        }
        return;
      }

      if (e.key === "Escape") {
        if (closeOpenPanel()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (shouldExitButler()) {
          e.preventDefault();
          e.stopPropagation();
          onExit?.();
          return;
        }
      }

      const hasCtrl = e.ctrlKey || e.getModifierState?.("Control");
      if (!isSpaceEvent(e) || !hasCtrl || e.altKey || e.metaKey || e.shiftKey || e.repeat) {
        return;
      }

      e.preventDefault();
      if (voiceButtonRef.current && !voiceButtonRef.current.isRecording()) {
        hasDictatedRef.current = false;
        setIsDictating(true);
        voiceButtonRef.current.start();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isSpaceEvent(e)) return;
      if (!voiceButtonRef.current || !voiceButtonRef.current.isRecording()) {
        setIsDictating(false);
        return;
      }
      e.preventDefault();
      setIsDictating(false);
      voiceButtonRef.current.stop();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      setIsDictating(false);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [hasButler, sending, selectedModel, model, profiles, selectedProfile, switchingProfile, butlers, customizeOpen, historyOpen, historyTranscript, manageOpen, commandMenuOpen, onExit]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

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
        <>
        <div className="shrink-0 flex items-center gap-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 px-4 py-2">
          <ButlerSwitcher butlers={butlers} activeId={activeButlerId} onSelect={selectButler} onManage={() => setManageOpen(true)} disabled={starting} />
          <span className="text-[11px] text-gray-400 dark:text-gray-500">Pick a butler, then start it — or add another via the gear.</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-sm">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-brand-600 flex items-center justify-center shadow-lg">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 mb-2 heading-serif">Project Butler</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              A persistent {backendLabel(backend)} agent that lives in your repository. Ask questions, get summaries, or run quick tasks â€” all without creating a new workspace.
            </p>
            <button
              onClick={handleStart}
              disabled={starting}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 shadow-sm"
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
        <AgentQuestionsPanel projectId={projectId} />
        </>
      ) : (
        <>
          {/* Butler toolbar: context pill + clear (left, grouped) Â· config selects + Customize (right) */}
          <div className="shrink-0 flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 px-4 py-2 text-xs">
            {/* Left group â€” context status pill with an attached "clear" icon button.
                Grouping them makes it obvious that the button resets the value shown in the pill. */}
            <div className="flex items-center gap-2 shrink-0 min-w-0">
            <ButlerSwitcher butlers={butlers} activeId={activeButlerId} onSelect={selectButler} onManage={() => setManageOpen(true)} disabled={sending} />
            <div className="flex items-center shrink-0 min-w-0 rounded-full border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark overflow-hidden">
              <div
                className="flex items-center gap-1.5 px-3 py-1 text-gray-600 dark:text-gray-300 min-w-0"
                title={[
                  `Backend: ${backendLabel(backend)}`,
                  model ? `Model: ${model}` : null,
                  contextWindow ? `Context window: ${(contextWindow / 1000).toFixed(0)}k tokens` : null,
                  contextTokens ? `Context used: ${contextTokens.toLocaleString('en-US')} tokens` : null,
                  mcpConnected !== undefined ? `Board MCP: ${mcpConnected ? "connected" : "not connected"}` : null,
                ].filter(Boolean).join("\n")}
              >
                {mcpConnected !== undefined && (
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${mcpConnected ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} title={mcpConnected ? "Board MCP connected" : "Board MCP not connected"} />
                )}
                <span className="shrink-0 font-medium">
                  {contextTokens > 0
                    ? contextWindow
                      ? `${(contextTokens / 1000).toFixed(1)}k / ${formatWindow(contextWindow)} (${Math.round((contextTokens / contextWindow) * 100)}%)`
                      : `${(contextTokens / 1000).toFixed(1)}k context`
                    : `${backendLabel(backend)} session`}
                </span>
              </div>
              <button
                onClick={handleClearContext}
                disabled={sending}
                className="inline-flex items-center gap-1 border-l border-gray-200 dark:border-gray-700 px-2.5 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                title="Clear the butler's conversation context and start fresh (Ctrl+L or Ctrl+Shift+X)"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
                </svg>
                <span>Clear</span>
              </button>
            </div>
            </div>

            {/* Right group â€” prominent voice dictation, config selects, then a clearly-styled Customize button. */}
            <div className="flex items-center gap-2 shrink-0">
              {/* Voice dictation â€” top-row primary action so it's easy to discover.
                  Feeds the message input below via the same handlers as the footer used to. */}
              <ButlerVoiceButton
                ref={voiceButtonRef}
                variant="prominent"
                disabled={sending}
                onStart={() => {
                  hasDictatedRef.current = false;
                  voiceInterimRef.current = "";
                  setInterimVoiceText("");
                  setIsDictating(true);
                }}
                onTranscript={appendVoiceTranscript}
                onInterim={(value) => {
                  const safeInterim = sanitizeSpeechText(value);
                  setInterimVoiceText(safeInterim);
                  if (safeInterim) {
                    voiceInterimRef.current = safeInterim;
                  }
                }}
                onStop={() => {
                  setIsDictating(false);
                  const safeInterim = sanitizeSpeechText(voiceInterimRef.current);
                  if (!hasDictatedRef.current && safeInterim) {
                    const prev = inputValueRef.current;
                    const sep = prev.length > 0 && !/\s$/.test(prev) ? " " : "";
                    const next = safeInterim ? `${prev + sep}${safeInterim} ` : prev;
                    setInputValue(next);
                    hasDictatedRef.current = true;
                  }
                  voiceInterimRef.current = "";
                  setInterimVoiceText("");
                  requestAnimationFrame(() => {
                    if (!inputRef.current) return;
                    inputRef.current.focus();
                    const len = inputRef.current.value.length;
                    inputRef.current.setSelectionRange(len, len);
                  });
                }}
              />
              <span className="h-5 w-px bg-gray-300 dark:bg-gray-700" aria-hidden />
              {/* Model picker â€” switches in place, no context loss. */}
              <label className="flex items-center gap-1 text-gray-500 dark:text-gray-400" title="Model for the butler. Switches without losing context.">
                <span className="hidden sm:inline text-[11px]">Model</span>
                <select
                  ref={modelSelectRef}
                  value={selectedModel}
                  onChange={(e) => void handleModelChange(e.target.value)}
                  title="Model for the butler. Ctrl+M cycles models without losing context."
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {CLAUDE_MODEL_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </label>
              {/* Profile picker â€” changes auth/endpoint, so it restarts the butler fresh. */}
              <label className="flex items-center gap-1 text-gray-500 dark:text-gray-400" title={`${backendLabel(backend)} profile. Switching restarts the butler with a fresh context.`}>
                <span className="hidden sm:inline text-[11px]">Profile</span>
                <select
                  ref={profileSelectRef}
                  value={selectedProfile}
                  onChange={(e) => void handleProfileChange(e.target.value)}
                  disabled={switchingProfile || sending}
                  title={`${backendLabel(backend)} profile. Ctrl+P cycles profiles and restarts the butler fresh.`}
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
                >
                  <option value="">{globalProfile ? `Default (${globalProfile})` : "Default"}</option>
                  {profiles.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
              <span className="h-5 w-px bg-gray-300 dark:bg-gray-700" aria-hidden />
              <button
                onClick={openCustomize}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors shadow-sm"
                title="Customize the butler's behavior (edits the project's butler skill)"
              >
                <span aria-hidden>Config</span>
                <span>Customize</span>
              </button>
              <button
                onClick={() => void openHistory()}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors shadow-sm ${historyOpen ? "bg-gray-100 dark:bg-gray-700" : ""}`}
                title="View recent butler sessions"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>History</span>
              </button>
            </div>
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
                  className="w-full resize-y rounded-lg border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-3 py-2 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
                  placeholder="Leave empty to revert to the default butler behavior."
                />
                <div className="flex items-center justify-end gap-2 mt-2">
                  <button onClick={() => setCustomizeOpen(false)} disabled={customizeBusy} className="px-3 py-1.5 text-xs rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">Cancel</button>
                  <button onClick={saveCustomize} disabled={customizeBusy} className="px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50">
                    {customizeBusy ? "Savingâ€¦" : "Save & apply"}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">Saving clears the current context so the new behavior takes effect immediately.</p>
              </div>
            </div>
          )}

          {historyOpen && (
            <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60">
              {historyTranscript ? (
                /* Read-only transcript overlay */
                <div className="flex flex-col max-h-[60vh]">
                  <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        onClick={() => setHistoryTranscript(null)}
                        className="shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
                        title="Back to session list"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M19 12H5M12 5l-7 7 7 7" />
                        </svg>
                      </button>
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{historyTranscript.session.title}</span>
                      <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                        {historyTranscript.session.turnCount} turns Â· {formatRelativeTs(new Date(historyTranscript.session.startedAt).getTime())}
                      </span>
                    </div>
                    <button
                      onClick={() => setHistoryOpen(false)}
                      className="shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500"
                      title="Close history"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="overflow-y-auto px-4 py-3 flex-1">
                    {historyTranscript.messages.length === 0 ? (
                      <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No messages found in this session.</p>
                    ) : (
                      <div className="max-w-3xl mx-auto">
                        {historyTranscript.messages.map((msg, i) => (
                          <ChatBubble key={i} msg={{ id: `hist-${i}`, role: msg.role, text: msg.text, ts: msg.ts }} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Session list dropdown */
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Recent sessions</span>
                    <button
                      onClick={() => setHistoryOpen(false)}
                      className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500"
                      title="Close"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  {historyLoading ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-2">Loadingâ€¦</p>
                  ) : historySessions.length === 0 ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-2">No past butler sessions found.</p>
                  ) : (
                    <div className="space-y-1">
                      {historySessions.map((s) => (
                        <button
                          key={s.sessionId}
                          onClick={() => void openHistoryTranscript(s)}
                          className="w-full text-left flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                        >
                          <span className="text-xs text-gray-800 dark:text-gray-200 truncate">{s.title}</span>
                          <div className="shrink-0 flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
                            <span>{s.turnCount}t</span>
                            <span>{formatRelativeTs(new Date(s.startedAt).getTime())}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
                  <div className="bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded-2xl rounded-tl-md px-4 py-2.5 flex items-center gap-1.5 shadow-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark px-4 py-3">
            <div className="max-w-3xl mx-auto flex items-end gap-2">
              <div className="flex-1 relative">
                {commandMenuOpen && (
                  <div className="absolute bottom-full mb-2 left-0 right-0 max-h-60 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark shadow-lg z-10 py-1">
                    <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">Commands</div>
                    {filteredCommands.map((cmd, i) => (
                      <button
                        key={cmd.name}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); applyCommand(cmd.name); }}
                        onMouseEnter={() => setCommandIndex(i)}
                        className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 ${i === commandIndex ? "bg-brand-50 dark:bg-brand-900/30" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"}`}
                      >
                        <span className="text-sm font-mono text-brand-600 dark:text-brand-400 shrink-0">/{cmd.name}</span>
                        {cmd.argumentHint && <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">{cmd.argumentHint}</span>}
                        {cmd.description && <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{cmd.description}</span>}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={sending}
                  rows={1}
                  placeholder="Message the butler... (Enter or Ctrl+Enter to send, Shift+Enter for new line, / for commands)"
                  className="block w-full resize-none rounded-xl border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-4 py-2.5 pr-10 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-brand-600 transition-all disabled:opacity-50"
                  style={{ minHeight: "42px", maxHeight: "160px", overflowY: "auto" }}
                  onInput={(e) => {
                    const t = e.target as HTMLTextAreaElement;
                    t.style.height = "auto";
                    t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
                  }}
                />
                {interimVoiceText && (
                  <div className="absolute bottom-full mb-1 left-0 right-0 z-10 rounded-md bg-gray-900/90 dark:bg-gray-100/90 px-2.5 py-1 text-xs italic text-white dark:text-gray-900 pointer-events-none">
                    [voice] {interimVoiceText}
                  </div>
                )}
              </div>
              {sending ? (
                <button
                  onClick={handleStop}
                  className="shrink-0 p-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors shadow-sm"
                  title="Stop the butler"
                >
                  {/* stop (filled square) */}
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={!input.trim()}
                  className="shrink-0 p-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
                  title="Send message"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                </button>
              )}
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
                <span className={`flex items-center gap-1.5 ${isDictating ? "text-red-500 dark:text-red-400" : ""}`}>
                  <span>
                    {isDictating
                      ? "Dictating in progress"
                      : "Persistent warm butler runs in your project repo. Enter or Ctrl + Enter sends. Ctrl + L clears context. Hold Ctrl + Space to dictate."}
                  </span>
                  {isDictating && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
                </span>
              )}
            </p>
          </div>

          {/* Pending agent questions â€” secondary inbox, anchored below the chat. */}
          <AgentQuestionsPanel projectId={projectId} />
        </>
      )}
      {manageOpen && <ButlerManageModal onClose={() => setManageOpen(false)} onChanged={() => { void fetchButlers(); }} />}
    </div>
  );
}
