import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch } from "../lib/api.js";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS } from "@agentic-kanban/shared";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import { AgentQuestionsPanel } from "./AgentQuestionsPanel.js";
import { ButlerVoiceButton, type ButlerVoiceButtonHandle } from "./ButlerVoiceButton.js";

interface ButlerState {
  backend?: "claude" | "codex" | "mock";
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
  | { type: "tool"; name: string; toolId?: string; input?: Record<string, unknown> }
  | { type: "tool-result"; toolId?: string; output?: string; isError?: boolean }
  | { type: "result"; text?: string; isError?: boolean }
  | { type: "usage"; contextTokens: number }
  | { type: "meta"; model?: string; contextWindow?: number; mcpConnected?: boolean }
  | { type: "error"; message: string };

/** Format a context-window size: 1000000 -> "1M", 200000 -> "200k". */
function formatWindow(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`;
}

interface ToolCall {
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  status: "pending" | "done" | "error";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "activity" | "tool";
  text: string;
  ts: number;
  tool?: ToolCall;
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
  /**
   * A message to pre-fill into the active butler tab's input once it's ready
   * (e.g. the "Chat about this ticket" entry point from a ticket — #838). Each
   * distinct value is applied once; the butler is started first if it's cold so
   * the prompt can be sent. Consumed via {@link ButlerViewProps.onInitialPromptConsumed}.
   */
  initialPrompt?: string;
  /** Called after `initialPrompt` has been prefilled, so the parent can clear it. */
  onInitialPromptConsumed?: () => void;
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
  return name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
}

function toolHint(name: string, input?: Record<string, unknown>): string {
  if (!input) return "";
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  const base = (p: string) => p.replace(/\\/g, "/").split("/").pop() || p;
  if (name === "Read" || name === "Write" || name === "Edit") return base(str(input.file_path));
  if (name === "Bash") return str(input.command);
  if (name === "Glob" || name === "Grep") return str(input.pattern);
  if (name === "WebSearch") return str(input.query);
  if (name === "WebFetch") return str(input.url);
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length <= 80) return v;
  }
  return "";
}

const toolIcon = (status: ToolCall["status"]) => {
  if (status === "pending") {
    return (
      <svg className="w-3 h-3 animate-spin shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg className="w-3 h-3 shrink-0 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
    );
  }
  return (
    <svg className="w-3 h-3 shrink-0 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
  );
};

function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const hint = toolHint(tool.name, tool.input);
  const hasDetail = (tool.input && Object.keys(tool.input).length > 0) || tool.output != null;
  const inputJson = tool.input && Object.keys(tool.input).length > 0
    ? JSON.stringify(tool.input, null, 2)
    : "";

  return (
    <div className="flex justify-center mb-1.5">
      <div className="w-full max-w-[80%]">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          disabled={!hasDetail}
          className={`group flex items-center gap-1.5 w-full text-left px-2.5 py-1 rounded-md border border-gray-200 dark:border-gray-700/70 bg-gray-50 dark:bg-gray-800/50 text-[11px] text-gray-500 dark:text-gray-400 ${hasDetail ? "hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer" : "cursor-default"}`}
        >
          {toolIcon(tool.status)}
          <span className="font-medium text-gray-600 dark:text-gray-300 shrink-0">{formatToolLabel(tool.name)}</span>
          {hint && <span className="truncate font-mono text-gray-400 dark:text-gray-500">{hint}</span>}
          {hasDetail && (
            <svg className={`w-3 h-3 ml-auto shrink-0 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
          )}
        </button>
        {open && (
          <div className="mt-1 space-y-1.5 rounded-md border border-gray-200 dark:border-gray-700/70 bg-white dark:bg-gray-900/60 p-2">
            {inputJson && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-0.5">Input</div>
                <pre className="text-[11px] font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{inputJson}</pre>
              </div>
            )}
            {tool.output != null && (
              <div>
                <div className={`text-[10px] uppercase tracking-wide mb-0.5 ${tool.status === "error" ? "text-red-500" : "text-gray-400 dark:text-gray-500"}`}>{tool.status === "error" ? "Error" : "Output"}</div>
                <pre className={`text-[11px] font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto ${tool.status === "error" ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>{tool.output || "(empty)"}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
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

  if (msg.role === "tool" && msg.tool) {
    return <ToolCallCard tool={msg.tool} />;
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
  backend?: "claude" | "codex" | "mock";
}

function backendLabel(backend?: string): string {
  if (backend === "codex") return "Codex";
  if (backend === "mock") return "Mock";
  return "Claude";
}

function modelOptionsForBackend(backend?: "claude" | "codex" | "mock") {
  return backend === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
}

function modelLabel(value: string, backend?: "claude" | "codex" | "mock"): string {
  return modelOptionsForBackend(backend).find((m) => m.value === value)?.label ?? value;
}

interface ButlerDef { id: string; name: string; model: string; provider?: "claude" | "codex" | null; }

const PROVIDER_OPTIONS: { value: "claude" | "codex"; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

/** Modal for managing the global set of butlers: add, rename, set model, remove. Capped server-side. */
function ButlerManageModal({ globalBackend, onClose, onChanged }: { globalBackend: "claude" | "codex"; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<ButlerDef[]>([]);
  const [max, setMax] = useState(4);
  const [newName, setNewName] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newProvider, setNewProvider] = useState<"claude" | "codex">(globalBackend);
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
          {items.map((b) => {
            const itemProvider: "claude" | "codex" = b.provider ?? globalBackend;
            const itemModelOptions = modelOptionsForBackend(itemProvider);
            return (
              <div key={b.id} className="flex items-center gap-2">
                <input
                  defaultValue={b.name}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== b.name) void run(() => callDef(`/${b.id}`, { method: "PUT", body: { name: v } })); }}
                  disabled={busy}
                  className="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-2 py-1 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <select
                  value={itemProvider}
                  onChange={(e) => void run(() => callDef(`/${b.id}`, { method: "PUT", body: { provider: e.target.value, model: "" } }))}
                  disabled={busy}
                  title="Provider for this butler"
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {PROVIDER_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <select
                  value={b.model}
                  onChange={(e) => void run(() => callDef(`/${b.id}`, { method: "PUT", body: { model: e.target.value } }))}
                  disabled={busy}
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {itemModelOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
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
            );
          })}
          {items.length < max && (
            <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-800 mt-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New butler name (e.g. Quick)"
                disabled={busy}
                className="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-2 py-1 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <select
                value={newProvider}
                onChange={(e) => { setNewProvider(e.target.value as "claude" | "codex"); setNewModel(""); }}
                disabled={busy}
                title="Provider for the new butler"
                className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {PROVIDER_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              <select value={newModel} onChange={(e) => setNewModel(e.target.value)} disabled={busy} className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500">
                {modelOptionsForBackend(newProvider).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <button
                onClick={() => { if (newName.trim()) void run(async () => { await callDef("", { method: "POST", body: { name: newName.trim(), model: newModel, provider: newProvider } }); setNewName(""); setNewModel(""); setNewProvider(globalBackend); }); }}
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

// ─── Per-tab state ──────────────────────────────────────────────────────────

interface TabState {
  butlerId: string;
  butlerName: string;
  chatMessages: ChatMessage[];
  butlerState: ButlerState | null;
  backend: "claude" | "codex" | "mock";
  contextTokens: number;
  model: string | undefined;
  contextWindow: number | undefined;
  mcpConnected: boolean | undefined;
  selectedModel: string;
  sending: boolean;
  input: string;
  profiles: string[];
  selectedProfile: string;
  globalProfile: string;
  commands: ButlerCommand[];
  historyOpen: boolean;
  historySessions: ButlerSessionSummary[];
  historyLoading: boolean;
  historyTranscript: { session: ButlerSessionSummary; messages: ButlerSessionMessage[] } | null;
  customizeOpen: boolean;
  customizePrompt: string;
  customizeBusy: boolean;
}

function makeTabState(butlerId: string, butlerName: string): TabState {
  return {
    butlerId,
    butlerName,
    chatMessages: [],
    butlerState: null,
    backend: "claude",
    contextTokens: 0,
    model: undefined,
    contextWindow: undefined,
    mcpConnected: undefined,
    selectedModel: "",
    sending: false,
    input: "",
    profiles: [],
    selectedProfile: "",
    globalProfile: "",
    commands: [],
    historyOpen: false,
    historySessions: [],
    historyLoading: false,
    historyTranscript: null,
    customizeOpen: false,
    customizePrompt: "",
    customizeBusy: false,
  };
}

// ─── Inline tab rename ───────────────────────────────────────────────────────

function TabRenameInput({ name, onSave, onCancel }: { name: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { ref.current?.select(); }, []);

  function commit() {
    const v = value.trim();
    if (v && v !== name) onSave(v);
    else onCancel();
  }

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      }}
      className="w-20 rounded border border-brand-400 bg-white dark:bg-gray-800 px-1 text-xs text-gray-800 dark:text-gray-100 focus:outline-none"
      autoFocus
    />
  );
}

// ─── Main ButlerView ─────────────────────────────────────────────────────────

export function ButlerView({ projectId, columns, liveActivity, liveStats, onIssueClick, onExit, initialPrompt, onInitialPromptConsumed }: ButlerViewProps) {
  const [loadingState, setLoadingState] = useState(true);
  const [butlers, setButlers] = useState<ButlerListItem[]>([]);
  const [butlerMax, setButlerMax] = useState(4);
  const [manageOpen, setManageOpen] = useState(false);

  // Tabs: list of open tab ids (ordered) + the active one.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  // Per-tab mutable state keyed by butlerId.
  const [tabStates, setTabStates] = useState<Record<string, TabState>>({});
  // Rename: which tab is being edited inline.
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);

  // Per-tab SSE streams: kept outside React state to avoid re-render churn.
  const eventSourcesRef = useRef<Record<string, EventSource>>({});
  // Per-tab streaming buffer state (outside React state for the same reason).
  const assistantBufsRef = useRef<Record<string, { buf: string; msgId: string | null; textSeen: boolean }>>({});
  // Per-tab input value refs (mirrors tab.input for closure access).
  const inputValuesRef = useRef<Record<string, string>>({});

  // Voice/dictation state — shared, applies to the active tab.
  const [interimVoiceText, setInterimVoiceText] = useState("");
  const [isDictating, setIsDictating] = useState(false);
  const voiceButtonRef = useRef<ButlerVoiceButtonHandle>(null);
  const hasDictatedRef = useRef(false);
  const voiceInterimRef = useRef("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const profileSelectRef = useRef<HTMLSelectElement>(null);
  const commandIndexRef = useRef(0);
  const [commandIndex, setCommandIndex] = useState(0);

  // Derived active tab state.
  const tab = tabStates[activeTabId];
  const activeModelOptions = modelOptionsForBackend(tab?.backend);

  // ── Helpers ──

  function butlerUrl(butlerId: string, path: string): string {
    const base = `/api/projects/${projectId}/butler${path}`;
    if (!butlerId || butlerId === "default") return base;
    return `${base}${path.includes("?") ? "&" : "?"}butler=${encodeURIComponent(butlerId)}`;
  }

  function getOrInitBuf(butlerId: string) {
    if (!assistantBufsRef.current[butlerId]) {
      assistantBufsRef.current[butlerId] = { buf: "", msgId: null, textSeen: false };
    }
    return assistantBufsRef.current[butlerId];
  }

  const updateTab = useCallback((butlerId: string, patch: Partial<TabState>) => {
    setTabStates((prev) => {
      const cur = prev[butlerId];
      if (!cur) return prev;
      return { ...prev, [butlerId]: { ...cur, ...patch } };
    });
  }, []);

  function appendAssistantText(butlerId: string, delta: string) {
    if (!delta) return;
    const buf = getOrInitBuf(butlerId);
    buf.textSeen = true;
    buf.buf += delta;
    const text = buf.buf;
    if (!buf.msgId) {
      buf.msgId = `asst-${Date.now()}-${Math.random()}`;
    }
    const id = buf.msgId;
    setTabStates((prev) => {
      const cur = prev[butlerId];
      if (!cur) return prev;
      const msgs = cur.chatMessages;
      const last = msgs[msgs.length - 1];
      const newMsgs = last && last.id === id
        ? [...msgs.slice(0, -1), { ...last, text }]
        : [...msgs, { id, role: "assistant" as const, text, ts: Date.now() }];
      return { ...prev, [butlerId]: { ...cur, chatMessages: newMsgs } };
    });
  }

  function settlePendingTools(butlerId: string) {
    setTabStates((prev) => {
      const cur = prev[butlerId];
      if (!cur) return prev;
      if (!cur.chatMessages.some((m) => m.role === "tool" && m.tool?.status === "pending")) return prev;
      return {
        ...prev,
        [butlerId]: {
          ...cur,
          chatMessages: cur.chatMessages.map((m) =>
            m.role === "tool" && m.tool?.status === "pending"
              ? { ...m, tool: { ...m.tool, status: "done" } }
              : m,
          ),
        },
      };
    });
  }

  function handleButlerEvent(butlerId: string, e: ButlerEvent) {
    const buf = getOrInitBuf(butlerId);
    switch (e.type) {
      case "session":
        updateTab(butlerId, { butlerState: { active: true, sessionId: e.sessionId } });
        break;
      case "usage":
        updateTab(butlerId, { contextTokens: e.contextTokens });
        break;
      case "meta":
        setTabStates((prev) => {
          const cur = prev[butlerId];
          if (!cur) return prev;
          return {
            ...prev,
            [butlerId]: {
              ...cur,
              ...(e.model ? { model: e.model } : {}),
              ...(e.contextWindow ? { contextWindow: e.contextWindow } : {}),
              ...(e.mcpConnected !== undefined ? { mcpConnected: e.mcpConnected } : {}),
            },
          };
        });
        break;
      case "turn-start":
        buf.buf = "";
        buf.msgId = null;
        buf.textSeen = false;
        updateTab(butlerId, { sending: true });
        break;
      case "user":
        setTabStates((prev) => {
          const cur = prev[butlerId];
          if (!cur) return prev;
          const recentDup = cur.chatMessages.slice(-4).some((m) => m.role === "user" && m.text === e.text);
          if (recentDup) return prev;
          return {
            ...prev,
            [butlerId]: {
              ...cur,
              chatMessages: [...cur.chatMessages, { id: `user-ext-${Date.now()}`, role: "user", text: e.text, ts: Date.now() }],
            },
          };
        });
        break;
      case "text":
        appendAssistantText(butlerId, e.text);
        break;
      case "tool": {
        buf.buf = "";
        buf.msgId = null;
        const id = e.toolId ? `tool-${e.toolId}` : `tool-${Date.now()}-${Math.random()}`;
        setTabStates((prev) => {
          const cur = prev[butlerId];
          if (!cur) return prev;
          return {
            ...prev,
            [butlerId]: {
              ...cur,
              chatMessages: [...cur.chatMessages, {
                id,
                role: "tool",
                text: formatToolLabel(e.name),
                ts: Date.now(),
                tool: { name: e.name, input: e.input, status: "pending" },
              }],
            },
          };
        });
        break;
      }
      case "tool-result": {
        const targetId = e.toolId ? `tool-${e.toolId}` : undefined;
        setTabStates((prev) => {
          const cur = prev[butlerId];
          if (!cur) return prev;
          let idx = -1;
          if (targetId) {
            idx = cur.chatMessages.findIndex((m) => m.id === targetId);
          } else {
            for (let i = cur.chatMessages.length - 1; i >= 0; i--) {
              if (cur.chatMessages[i].role === "tool" && cur.chatMessages[i].tool?.status === "pending") { idx = i; break; }
            }
          }
          if (idx === -1) return prev;
          const msg = cur.chatMessages[idx];
          const next = [...cur.chatMessages];
          next[idx] = { ...msg, tool: { ...msg.tool!, output: e.output, status: e.isError ? "error" : "done" } };
          return { ...prev, [butlerId]: { ...cur, chatMessages: next } };
        });
        break;
      }
      case "result":
        if (e.text && !buf.textSeen) {
          if (e.isError) {
            setTabStates((prev) => {
              const cur = prev[butlerId];
              if (!cur) return prev;
              return {
                ...prev,
                [butlerId]: {
                  ...cur,
                  chatMessages: [...cur.chatMessages, { id: `err-${Date.now()}`, role: "activity", text: `Error: ${e.text}`, ts: Date.now() }],
                },
              };
            });
          } else {
            appendAssistantText(butlerId, e.text);
          }
        }
        buf.buf = "";
        buf.msgId = null;
        buf.textSeen = false;
        settlePendingTools(butlerId);
        updateTab(butlerId, { sending: false });
        break;
      case "error":
        setTabStates((prev) => {
          const cur = prev[butlerId];
          if (!cur) return prev;
          return {
            ...prev,
            [butlerId]: {
              ...cur,
              chatMessages: [...cur.chatMessages, { id: `err-${Date.now()}`, role: "activity", text: `Error: ${e.message}`, ts: Date.now() }],
              sending: false,
            },
          };
        });
        settlePendingTools(butlerId);
        break;
      case "ready":
      default:
        break;
    }
  }

  function openStream(butlerId: string) {
    eventSourcesRef.current[butlerId]?.close();
    const es = new EventSource(butlerUrl(butlerId, "/stream"));
    es.onmessage = (ev) => {
      try {
        handleButlerEvent(butlerId, JSON.parse(ev.data) as ButlerEvent);
      } catch { /* ignore non-JSON heartbeats */ }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    eventSourcesRef.current[butlerId] = es;
  }

  function closeStream(butlerId: string) {
    eventSourcesRef.current[butlerId]?.close();
    delete eventSourcesRef.current[butlerId];
  }

  async function fetchButlers() {
    try {
      const [r, defs] = await Promise.all([
        apiFetch<{ butlers: ButlerListItem[] }>(`/api/projects/${projectId}/butlers`),
        apiFetch<{ butlers: ButlerDef[]; max: number }>("/api/butler-definitions"),
      ]);
      setButlers(r.butlers);
      setButlerMax(defs.max);
      // Sync butlerName for open tabs from fresh list
      setTabStates((prev) => {
        const next = { ...prev };
        for (const b of r.butlers) {
          if (next[b.id]) {
            next[b.id] = { ...next[b.id], butlerName: b.name };
          }
        }
        return next;
      });
      return r.butlers;
    } catch {
      return [] as ButlerListItem[];
    }
  }

  async function loadCapabilities(butlerId: string) {
    try {
      const [cmdData, profData] = await Promise.all([
        apiFetch<{ commands: ButlerCommand[] }>(butlerUrl(butlerId, "/commands")),
        // Must scope to THIS butler — an unscoped /profiles returns the default butler's
        // provider and would clobber a codex tab's backend back to claude (#829).
        apiFetch<{ provider?: "claude" | "codex"; profiles: string[]; selected: string; globalDefault: string }>(butlerUrl(butlerId, "/profiles")),
      ]);
      updateTab(butlerId, {
        commands: cmdData.commands,
        backend: profData.provider ?? "claude",
        profiles: profData.profiles,
        selectedProfile: profData.selected,
        globalProfile: profData.globalDefault,
      });
    } catch { /* capabilities are best-effort */ }
  }

  async function loadTabButler(butlerId: string) {
    const buf = getOrInitBuf(butlerId);
    buf.buf = "";
    buf.msgId = null;
    buf.textSeen = false;
    closeStream(butlerId);
    setTabStates((prev) => {
      const cur = prev[butlerId];
      if (!cur) return prev;
      return {
        ...prev,
        [butlerId]: {
          ...cur,
          chatMessages: [],
          butlerState: null,
          contextTokens: 0,
          model: undefined,
          contextWindow: undefined,
          mcpConnected: undefined,
          sending: false,
        },
      };
    });
    try {
      const state = await apiFetch<ButlerState>(butlerUrl(butlerId, ""));
      updateTab(butlerId, {
        butlerState: state,
        backend: state.backend ?? "claude",
        contextTokens: state.contextTokens ?? 0,
        model: state.model,
        contextWindow: state.contextWindow,
        mcpConnected: state.mcpConnected,
        selectedModel: state.selectedModel ?? "",
      });
      if (state.active) {
        try {
          const { messages } = await apiFetch<{ messages: { role: "user" | "assistant"; text: string; ts: number }[] }>(butlerUrl(butlerId, "/messages"));
          if (messages.length) {
            setTabStates((prev) => {
              const cur = prev[butlerId];
              if (!cur) return prev;
              return {
                ...prev,
                [butlerId]: {
                  ...cur,
                  chatMessages: messages.map((m, i) => ({ id: `hist-${i}-${m.ts}`, role: m.role, text: m.text, ts: m.ts })),
                },
              };
            });
          }
        } catch { /* no history */ }
        openStream(butlerId);
      }
      // Always load provider-aware capabilities (backend, profiles, slash commands) so a
      // focused tab shows the correct provider's label/model/profile options even when the
      // butler is cold. Previously gated on state.active, which left a codex butler tab
      // stuck on the Claude label + Claude dropdowns until it was started (#829).
      void loadCapabilities(butlerId);
    } catch {
      updateTab(butlerId, { butlerState: { active: false, sessionId: null } });
    }
  }

  // ── Tab management ──

  function openTab(butlerId: string, butlerName: string) {
    setTabStates((prev) => {
      if (prev[butlerId]) return prev;
      return { ...prev, [butlerId]: makeTabState(butlerId, butlerName) };
    });
    setOpenTabs((prev) => {
      if (prev.includes(butlerId)) return prev;
      return [...prev, butlerId];
    });
    setActiveTabId(butlerId);
  }

  function closeTab(butlerId: string) {
    closeStream(butlerId);
    setOpenTabs((prev) => {
      const next = prev.filter((id) => id !== butlerId);
      // Move active tab to nearest neighbour
      setActiveTabId((cur) => {
        if (cur !== butlerId) return cur;
        const idx = prev.indexOf(butlerId);
        return next[Math.max(0, idx - 1)] ?? next[0] ?? "";
      });
      return next;
    });
    setTabStates((prev) => {
      const next = { ...prev };
      delete next[butlerId];
      return next;
    });
    delete assistantBufsRef.current[butlerId];
    delete inputValuesRef.current[butlerId];
  }

  async function renameButler(butlerId: string, newName: string) {
    try {
      await apiFetch(`/api/butler-definitions/${butlerId}`, {
        method: "PUT",
        body: JSON.stringify({ name: newName }),
      });
      updateTab(butlerId, { butlerName: newName });
      setButlers((prev) => prev.map((b) => b.id === butlerId ? { ...b, name: newName } : b));
    } catch (err) {
      console.error("Failed to rename butler", err);
    }
  }

  // ── Mount / project change ──

  useEffect(() => {
    setLoadingState(true);
    // Close all existing streams
    for (const id of Object.keys(eventSourcesRef.current)) {
      closeStream(id);
    }
    setOpenTabs([]);
    setActiveTabId("");
    setTabStates({});
    assistantBufsRef.current = {};
    inputValuesRef.current = {};
    setRenamingTabId(null);
    setManageOpen(false);

    void (async () => {
      const list = await fetchButlers();
      // Restore saved open tabs from localStorage, falling back to the first butler.
      let savedTabs: string[] = [];
      try {
        const raw = localStorage.getItem(`butler:tabs:${projectId}`);
        if (raw) savedTabs = JSON.parse(raw) as string[];
      } catch { /* ignore */ }
      const validIds = list.map((b) => b.id);
      const restoredTabs = savedTabs.filter((id) => validIds.includes(id));
      const initialTabs = restoredTabs.length > 0 ? restoredTabs : [list[0]?.id ?? "default"].filter(Boolean);

      // Build initial tab states
      const initialStates: Record<string, TabState> = {};
      for (const id of initialTabs) {
        const butler = list.find((b) => b.id === id);
        initialStates[id] = makeTabState(id, butler?.name ?? id);
      }
      setTabStates(initialStates);
      setOpenTabs(initialTabs);

      let savedActive = "";
      try { savedActive = localStorage.getItem(`butler:active:${projectId}`) || ""; } catch { /* ignore */ }
      const activeId = initialTabs.includes(savedActive) ? savedActive : initialTabs[0] ?? "";
      setActiveTabId(activeId);

      // Load each tab's butler state (prioritise active tab first)
      const toLoad = activeId ? [activeId, ...initialTabs.filter((id) => id !== activeId)] : initialTabs;
      for (const id of toLoad) {
        await loadTabButler(id);
      }
      setLoadingState(false);
    })();

    return () => {
      for (const id of Object.keys(eventSourcesRef.current)) {
        closeStream(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Persist open tabs when they change.
  useEffect(() => {
    if (openTabs.length === 0) return;
    try { localStorage.setItem(`butler:tabs:${projectId}`, JSON.stringify(openTabs)); } catch { /* ignore */ }
  }, [openTabs, projectId]);

  // Persist active tab.
  useEffect(() => {
    if (!activeTabId) return;
    try { localStorage.setItem(`butler:active:${projectId}`, activeTabId); } catch { /* ignore */ }
    // Load tab data if it hasn't been loaded yet.
    if (activeTabId && tabStates[activeTabId] && tabStates[activeTabId].butlerState === null && !loadingState) {
      void loadTabButler(activeTabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // Auto-scroll active tab on new messages.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [tab?.chatMessages]);

  // Prefill the active tab with an external prompt (e.g. "Chat about this ticket",
  // #838). Apply each distinct prompt once: start the butler if it's cold, drop the
  // text into the input for review, focus + size the textarea, and notify the parent
  // so it can clear the prompt. We deliberately do NOT auto-send — the user gets to
  // see the ticket context that was injected and tweak it before the first turn.
  const appliedInitialPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadingState || !initialPrompt || !activeTabId) return;
    if (appliedInitialPromptRef.current === initialPrompt) return;
    const cur = tabStates[activeTabId];
    if (!cur) return;
    appliedInitialPromptRef.current = initialPrompt;
    void (async () => {
      if (!cur.butlerState?.active) {
        await handleStart();
      }
      setTabInput(activeTabId, initialPrompt);
      requestAnimationFrame(() => {
        const t = inputRef.current;
        if (t) {
          t.focus();
          t.style.height = "auto";
          t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
        }
      });
      onInitialPromptConsumed?.();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, loadingState, activeTabId]);

  // ── Per-tab actions ──

  async function handleStart() {
    if (!tab) return;
    updateTab(activeTabId, { sending: true });
    try {
      const result = await apiFetch<ButlerState>(butlerUrl(activeTabId, "/ensure"), { method: "POST", body: "{}" });
      updateTab(activeTabId, { butlerState: { active: true, sessionId: result.sessionId }, sending: false });
      openStream(activeTabId);
      void loadCapabilities(activeTabId);
      void fetchButlers();
    } catch (err) {
      console.error("Failed to start butler", err);
      updateTab(activeTabId, { sending: false });
    }
  }

  async function handleClearContext() {
    if (!tab || tab.sending) return;
    closeStream(activeTabId);
    const buf = getOrInitBuf(activeTabId);
    buf.buf = "";
    buf.msgId = null;
    buf.textSeen = false;
    try {
      await apiFetch(butlerUrl(activeTabId, ""), { method: "DELETE" });
    } catch { /* ignore */ }
    updateTab(activeTabId, {
      chatMessages: [],
      contextTokens: 0,
      butlerState: { active: true, sessionId: null },
    });
    openStream(activeTabId);
    void fetchButlers();
  }

  async function handleNewSession() {
    await handleClearContext();
    inputRef.current?.focus();
  }

  async function handleModelChange(value: string) {
    if (!tab) return;
    updateTab(activeTabId, { selectedModel: value });
    try {
      await apiFetch(butlerUrl(activeTabId, "/model"), { method: "POST", body: JSON.stringify({ model: value }) });
      void fetchButlers();
    } catch (err) {
      console.error("Failed to switch butler model", err);
    }
  }

  function cycleModel() {
    if (!tab || tab.sending || activeModelOptions.length === 0) return;
    const current = tab.selectedModel || tab.model || activeModelOptions[0]?.value;
    const currentIndex = activeModelOptions.findIndex((item) => item.value === current);
    const next = activeModelOptions[(currentIndex + 1 + activeModelOptions.length) % activeModelOptions.length];
    if (next) {
      void handleModelChange(next.value);
      modelSelectRef.current?.focus();
    }
  }

  async function handleProfileChange(value: string) {
    if (!tab || tab.sending) return;
    updateTab(activeTabId, { selectedProfile: value, sending: true });
    closeStream(activeTabId);
    try {
      await apiFetch(butlerUrl(activeTabId, "/profile"), { method: "POST", body: JSON.stringify({ profile: value }) });
      const buf = getOrInitBuf(activeTabId);
      buf.buf = "";
      buf.msgId = null;
      buf.textSeen = false;
      updateTab(activeTabId, {
        chatMessages: [],
        contextTokens: 0,
        model: undefined,
        butlerState: { active: true, sessionId: null },
        sending: false,
      });
      openStream(activeTabId);
      void loadCapabilities(activeTabId);
    } catch (err) {
      console.error("Failed to switch butler profile", err);
      updateTab(activeTabId, { sending: false });
    }
  }

  function cycleProfile() {
    if (!tab) return;
    const options = ["", ...tab.profiles];
    if (tab.sending || options.length === 0) return;
    if (options.length === 1) { profileSelectRef.current?.focus(); return; }
    const currentIndex = options.indexOf(tab.selectedProfile);
    const next = options[(currentIndex + 1 + options.length) % options.length];
    void handleProfileChange(next);
  }

  const sanitizeSpeechText = (value: string) => (
    value
      .replace(/[ --]/g, "")
      .replace(/[​‌‍⁠᠎‎‏﻿]/g, "")
      .trim()
  );

  function setTabInput(butlerId: string, value: string) {
    inputValuesRef.current[butlerId] = value;
    updateTab(butlerId, { input: value });
  }

  function appendVoiceTranscript(chunk: string) {
    const safeChunk = sanitizeSpeechText(chunk);
    if (!safeChunk) return;
    hasDictatedRef.current = true;
    const prev = inputValuesRef.current[activeTabId] ?? "";
    const sep = prev.length > 0 && !/\s$/.test(prev) ? " " : "";
    setTabInput(activeTabId, prev + sep + safeChunk);
    requestAnimationFrame(() => {
      const t = inputRef.current;
      if (t) {
        t.style.height = "auto";
        t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
      }
    });
  }

  async function handleSend(explicitContent?: string) {
    if (!tab) return;
    const content = (explicitContent ?? inputValuesRef.current[activeTabId] ?? "").trim();
    if (!content || tab.sending || !tab.butlerState?.active) return;

    const userMsg: ChatMessage = { id: `user-${Date.now()}`, role: "user", text: content, ts: Date.now() };
    setTabStates((prev) => {
      const cur = prev[activeTabId];
      if (!cur) return prev;
      return { ...prev, [activeTabId]: { ...cur, chatMessages: [...cur.chatMessages, userMsg], input: "", sending: true } };
    });
    inputValuesRef.current[activeTabId] = "";
    hasDictatedRef.current = false;
    const buf = getOrInitBuf(activeTabId);
    buf.buf = "";
    buf.msgId = null;
    buf.textSeen = false;

    try {
      await apiFetch<{ ok: boolean }>(butlerUrl(activeTabId, "/message"), { method: "POST", body: JSON.stringify({ content }) });
    } catch (err) {
      setTabStates((prev) => {
        const cur = prev[activeTabId];
        if (!cur) return prev;
        return {
          ...prev,
          [activeTabId]: {
            ...cur,
            chatMessages: [...cur.chatMessages, {
              id: `err-${Date.now()}`,
              role: "activity",
              text: `Error: ${err instanceof Error ? err.message : "Failed to send message"}`,
              ts: Date.now(),
            }],
            sending: false,
          },
        };
      });
    }
  }

  async function handleStop() {
    if (!tab || !tab.sending) return;
    try {
      await apiFetch(butlerUrl(activeTabId, "/interrupt"), { method: "POST", body: "{}" });
    } catch (err) {
      console.error("Failed to stop butler", err);
    }
    updateTab(activeTabId, { sending: false });
  }

  // ── History + Customize ──

  async function openHistory() {
    if (!tab) return;
    const next = !tab.historyOpen;
    updateTab(activeTabId, { historyOpen: next, historyTranscript: null });
    if (next) {
      updateTab(activeTabId, { historyLoading: true });
      try {
        const r = await apiFetch<{ sessions: ButlerSessionSummary[] }>(butlerUrl(activeTabId, "/sessions?limit=5"));
        updateTab(activeTabId, { historySessions: r.sessions, historyLoading: false });
      } catch {
        updateTab(activeTabId, { historySessions: [], historyLoading: false });
      }
    }
  }

  async function openHistoryTranscript(session: ButlerSessionSummary) {
    if (!tab) return;
    updateTab(activeTabId, { historyTranscript: { session, messages: [] } });
    try {
      const r = await apiFetch<{ messages: ButlerSessionMessage[] }>(butlerUrl(activeTabId, `/sessions/${session.sessionId}/messages`));
      updateTab(activeTabId, { historyTranscript: { session, messages: r.messages } });
    } catch { /* keep empty */ }
  }

  async function openCustomize() {
    if (!tab) return;
    updateTab(activeTabId, { customizeOpen: true, customizeBusy: true });
    try {
      const r = await apiFetch<{ prompt: string; isOverride: boolean }>(`/api/projects/${projectId}/butler/skill`);
      updateTab(activeTabId, { customizePrompt: r.prompt, customizeBusy: false });
    } catch {
      updateTab(activeTabId, { customizePrompt: "", customizeBusy: false });
    }
  }

  async function saveCustomize() {
    if (!tab) return;
    updateTab(activeTabId, { customizeBusy: true });
    try {
      await apiFetch(`/api/projects/${projectId}/butler/skill`, {
        method: "PUT",
        body: JSON.stringify({ prompt: tab.customizePrompt }),
      });
      updateTab(activeTabId, { customizeOpen: false, customizeBusy: false });
      await handleClearContext();
    } catch (err) {
      console.error("Failed to save butler customization", err);
      updateTab(activeTabId, { customizeBusy: false });
    }
  }

  // ── Slash-command autocomplete ──

  const slashMatch = tab ? /(?:^|\s)\/([\w:-]*)$/.exec(tab.input) : null;
  const commandQuery = slashMatch?.[1] ?? "";
  const filteredCommands = slashMatch && tab && tab.commands.length > 0
    ? tab.commands.filter((cmd) => cmd.name.toLowerCase().includes(commandQuery.toLowerCase())).slice(0, 8)
    : [];
  const commandMenuOpen = filteredCommands.length > 0;

  useEffect(() => {
    setCommandIndex(0);
    commandIndexRef.current = 0;
  }, [commandQuery, commandMenuOpen]);

  function applyCommand(name: string) {
    if (!tab) return;
    const m = /(?:^|\s)\/([\w:-]*)$/.exec(tab.input);
    if (!m) return;
    const slashStart = m.index + m[0].length - (m[1].length + 1);
    const next = `${tab.input.slice(0, slashStart)}/${name} `;
    setTabInput(activeTabId, next);
    setCommandIndex(0);
    commandIndexRef.current = 0;
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function closeOpenPanel(): boolean {
    if (!tab) return false;
    if (manageOpen) { setManageOpen(false); return true; }
    if (tab.historyTranscript) { updateTab(activeTabId, { historyTranscript: null }); return true; }
    if (tab.historyOpen) { updateTab(activeTabId, { historyOpen: false }); return true; }
    if (tab.customizeOpen) { updateTab(activeTabId, { customizeOpen: false }); return true; }
    return false;
  }

  function shouldExitButler() {
    const inputVal = inputValuesRef.current[activeTabId] ?? "";
    return !inputVal.trim() && !commandMenuOpen && !tab?.customizeOpen && !tab?.historyOpen && !manageOpen;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!tab) return;
    if (commandMenuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); const next = (commandIndex + 1) % filteredCommands.length; setCommandIndex(next); commandIndexRef.current = next; return; }
      if (e.key === "ArrowUp") { e.preventDefault(); const next = (commandIndex - 1 + filteredCommands.length) % filteredCommands.length; setCommandIndex(next); commandIndexRef.current = next; return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyCommand(filteredCommands[commandIndex].name); return; }
      if (e.key === "Escape") { e.preventDefault(); setTabInput(activeTabId, `${tab.input} `); return; }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void handleSend(); return; }
    if (e.key === "Escape") {
      if (closeOpenPanel()) { e.preventDefault(); return; }
      if (shouldExitButler()) { e.preventDefault(); onExit?.(); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); }
  }

  const hasButler = tab?.butlerState?.active === true;

  useEffect(() => {
    if (!hasButler) return;

    const isSpaceEvent = (e: KeyboardEvent) => (
      e.code === "Space" || e.key === " " || e.key === "Spacebar" || (e.keyCode ?? 0) === 32
    );

    const onKeyDown = (e: KeyboardEvent) => {
      const hasCommandModifier = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if ((e.key === "Enter" && hasCommandModifier) || (key === "l" && hasCommandModifier) || (key === "p" && hasCommandModifier) || (key === "m" && hasCommandModifier) || (key === "x" && hasCommandModifier && e.shiftKey) || (key === "n" && hasCommandModifier && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter") { void handleSend(); }
        else if (key === "l" || key === "x") { void handleClearContext(); }
        else if (key === "p") { cycleProfile(); }
        else if (key === "m") { cycleModel(); }
        else if (key === "n") { void handleNewSession(); }
        return;
      }

      if (e.key === "Escape") {
        if (closeOpenPanel()) { e.preventDefault(); e.stopPropagation(); return; }
        if (shouldExitButler()) { e.preventDefault(); e.stopPropagation(); onExit?.(); return; }
      }

      const hasCtrl = e.ctrlKey || e.getModifierState?.("Control");
      if (!isSpaceEvent(e) || !hasCtrl || e.altKey || e.metaKey || e.shiftKey || e.repeat) return;

      e.preventDefault();
      if (voiceButtonRef.current && !voiceButtonRef.current.isRecording()) {
        hasDictatedRef.current = false;
        setIsDictating(true);
        voiceButtonRef.current.start();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isSpaceEvent(e)) return;
      if (!voiceButtonRef.current || !voiceButtonRef.current.isRecording()) { setIsDictating(false); return; }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasButler, tab, activeTabId, commandMenuOpen, commandIndex, filteredCommands, manageOpen, onExit]);

  // ── Render ──

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

  // Butlers available to add as new tabs (not already open, limited by max).
  const availableToOpen = butlers.filter((b) => !openTabs.includes(b.id));
  const canOpenMore = openTabs.length < butlerMax && availableToOpen.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ActivityStrip columns={columns} liveActivity={liveActivity} liveStats={liveStats} onIssueClick={onIssueClick} />

      {/* ── Tab bar ── */}
      <div className="shrink-0 flex items-stretch border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 overflow-x-auto">
        {openTabs.map((tabId) => {
          const ts = tabStates[tabId];
          const isActive = tabId === activeTabId;
          const isWarm = ts?.butlerState?.active === true;
          const isSending = ts?.sending === true;
          const isRenaming = renamingTabId === tabId;
          const tabName = ts?.butlerName ?? tabId;

          return (
            <div
              key={tabId}
              className={`group flex items-center gap-1.5 px-3 py-2 border-r border-gray-200 dark:border-gray-800 cursor-pointer select-none shrink-0 ${
                isActive
                  ? "bg-white dark:bg-gray-900 border-b-2 border-b-brand-500 -mb-px text-gray-800 dark:text-gray-100"
                  : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"
              }`}
              onClick={() => { if (!isRenaming) setActiveTabId(tabId); }}
              data-testid={`butler-tab-${tabId}`}
            >
              {/* Warm session indicator */}
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isSending ? "bg-green-500 animate-pulse" : isWarm ? "bg-green-400" : "bg-gray-300 dark:bg-gray-600"
                }`}
                title={isSending ? "Butler is thinking" : isWarm ? "Warm session" : "No session"}
              />
              {isRenaming ? (
                <TabRenameInput
                  name={tabName}
                  onSave={(v) => { setRenamingTabId(null); void renameButler(tabId, v); }}
                  onCancel={() => setRenamingTabId(null)}
                />
              ) : (
                <span
                  className="text-xs font-medium max-w-[120px] truncate"
                  onDoubleClick={(e) => { e.stopPropagation(); setRenamingTabId(tabId); }}
                  title={`${tabName} — double-click to rename`}
                >
                  {tabName}
                </span>
              )}
              {/* Close tab */}
              {openTabs.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(tabId); }}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-opacity"
                  title="Close tab"
                >
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              )}
            </div>
          );
        })}

        {/* Add tab dropdown */}
        {canOpenMore && (
          <div className="relative group/add shrink-0 flex items-center">
            <button
              className="flex items-center gap-1 px-2.5 py-2 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 text-xs transition-colors"
              title="Open another butler in a new tab"
              data-testid="butler-add-tab"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            {/* Hover dropdown to pick which butler to open */}
            <div className="absolute top-full left-0 mt-0.5 hidden group-hover/add:block z-30 rounded-md shadow-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-1 min-w-[140px]">
              {availableToOpen.map((b) => (
                <button
                  key={b.id}
                  onClick={() => { openTab(b.id, b.name); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${b.active ? "bg-green-400" : "bg-gray-300 dark:bg-gray-600"}`} />
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Manage butlers gear */}
        <button
          onClick={() => setManageOpen(true)}
          className="ml-auto shrink-0 px-2.5 py-2 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Manage butlers (add, rename, set model, remove)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
          </svg>
        </button>
      </div>

      {/* ── Tab content ── */}
      {!tab ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
          No butler tab open.
        </div>
      ) : !hasButler ? (
        <>
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center max-w-sm">
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-brand-600 flex items-center justify-center shadow-lg">
                <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-ink dark:text-stone-100 mb-2 heading-serif">
                {tab.butlerName}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                A persistent {backendLabel(tab.backend)} agent that lives in your repository. Ask questions, get summaries, or run quick tasks — all without creating a new workspace.
              </p>
              <button
                onClick={handleStart}
                disabled={tab.sending}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 shadow-sm"
              >
                {tab.sending ? (
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
          {/* Butler toolbar: context pill + model/profile/clear (scoped to this tab) */}
          <div className="shrink-0 flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 px-4 py-2 text-xs">
            <div className="flex items-center gap-2 shrink-0 min-w-0">
              <div className="flex items-center shrink-0 min-w-0 rounded-full border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark overflow-hidden">
                <div
                  className="flex items-center gap-1.5 px-3 py-1 text-gray-600 dark:text-gray-300 min-w-0"
                  title={[
                    `Backend: ${backendLabel(tab.backend)}`,
                    tab.model ? `Model: ${tab.model}` : null,
                    tab.contextWindow ? `Context window: ${(tab.contextWindow / 1000).toFixed(0)}k tokens` : null,
                    tab.contextTokens ? `Context used: ${tab.contextTokens.toLocaleString('en-US')} tokens` : null,
                    tab.mcpConnected !== undefined ? `Board MCP: ${tab.mcpConnected ? "connected" : "not connected"}` : null,
                  ].filter(Boolean).join("\n")}
                >
                  {tab.mcpConnected !== undefined && (
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.mcpConnected ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} title={tab.mcpConnected ? "Board MCP connected" : "Board MCP not connected"} />
                  )}
                  <span className="shrink-0 font-medium">
                    {tab.contextTokens > 0
                      ? tab.contextWindow
                        ? `${(tab.contextTokens / 1000).toFixed(1)}k / ${formatWindow(tab.contextWindow)} (${Math.round((tab.contextTokens / tab.contextWindow) * 100)}%)`
                        : `${(tab.contextTokens / 1000).toFixed(1)}k context`
                      : `${backendLabel(tab.backend)} session`}
                  </span>
                </div>
                <button
                  onClick={handleClearContext}
                  disabled={tab.sending}
                  className="inline-flex items-center gap-1 border-l border-gray-200 dark:border-gray-700 px-2.5 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                  title="Clear this butler's conversation context and start fresh (Ctrl+L)"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
                  </svg>
                  <span>Clear</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <ButlerVoiceButton
                ref={voiceButtonRef}
                variant="prominent"
                disabled={tab.sending}
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
                  if (safeInterim) voiceInterimRef.current = safeInterim;
                }}
                onStop={() => {
                  setIsDictating(false);
                  const safeInterim = sanitizeSpeechText(voiceInterimRef.current);
                  if (!hasDictatedRef.current && safeInterim) {
                    const prev = inputValuesRef.current[activeTabId] ?? "";
                    const sep = prev.length > 0 && !/\s$/.test(prev) ? " " : "";
                    setTabInput(activeTabId, safeInterim ? `${prev + sep}${safeInterim} ` : prev);
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
              <label className="flex items-center gap-1 text-gray-500 dark:text-gray-400" title="Model for this butler tab. Switches without losing context.">
                <span className="hidden sm:inline text-[11px]">Model</span>
                <select
                  ref={modelSelectRef}
                  value={tab.selectedModel}
                  onChange={(e) => void handleModelChange(e.target.value)}
                  title="Model for this butler. Ctrl+M cycles models without losing context."
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {activeModelOptions.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 text-gray-500 dark:text-gray-400" title={`${backendLabel(tab.backend)} profile. Switching restarts this butler tab with a fresh context.`}>
                <span className="hidden sm:inline text-[11px]">Profile</span>
                <select
                  ref={profileSelectRef}
                  value={tab.selectedProfile}
                  onChange={(e) => void handleProfileChange(e.target.value)}
                  disabled={tab.sending}
                  title={`${backendLabel(tab.backend)} profile. Ctrl+P cycles profiles and restarts the butler fresh.`}
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
                >
                  <option value="">{tab.globalProfile ? `Default (${tab.globalProfile})` : "Default"}</option>
                  {tab.profiles.map((p) => (
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
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors shadow-sm ${tab.historyOpen ? "bg-gray-100 dark:bg-gray-700" : ""}`}
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

          {tab.customizeOpen && (
            <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-4 py-3">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Butler behavior (project override)</span>
                  <span className="text-[10px] text-gray-400 dark:text-gray-500">Placeholders: {"{{projectName}}"}, {"{{repoPath}}"}, {"{{serverPort}}"}</span>
                </div>
                <textarea
                  value={tab.customizePrompt}
                  onChange={(e) => updateTab(activeTabId, { customizePrompt: e.target.value })}
                  disabled={tab.customizeBusy}
                  rows={8}
                  className="w-full resize-y rounded-lg border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-3 py-2 text-xs font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
                  placeholder="Leave empty to revert to the default butler behavior."
                />
                <div className="flex items-center justify-end gap-2 mt-2">
                  <button onClick={() => updateTab(activeTabId, { customizeOpen: false })} disabled={tab.customizeBusy} className="px-3 py-1.5 text-xs rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">Cancel</button>
                  <button onClick={saveCustomize} disabled={tab.customizeBusy} className="px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50">
                    {tab.customizeBusy ? "Saving..." : "Save & apply"}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">Saving clears the current context so the new behavior takes effect immediately.</p>
              </div>
            </div>
          )}

          {tab.historyOpen && (
            <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60">
              {tab.historyTranscript ? (
                <div className="flex flex-col max-h-[60vh]">
                  <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        onClick={() => updateTab(activeTabId, { historyTranscript: null })}
                        className="shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
                        title="Back to session list"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
                      </button>
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{tab.historyTranscript.session.title}</span>
                      <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                        {tab.historyTranscript.session.turnCount} turns · {formatRelativeTs(new Date(tab.historyTranscript.session.startedAt).getTime())}
                      </span>
                    </div>
                    <button onClick={() => updateTab(activeTabId, { historyOpen: false })} className="shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500" title="Close history">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  </div>
                  <div className="overflow-y-auto px-4 py-3 flex-1">
                    {tab.historyTranscript.messages.length === 0 ? (
                      <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No messages found in this session.</p>
                    ) : (
                      <div className="max-w-3xl mx-auto">
                        {tab.historyTranscript.messages.map((msg, i) => (
                          <ChatBubble key={i} msg={{ id: `hist-${i}`, role: msg.role, text: msg.text, ts: msg.ts }} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Recent sessions</span>
                    <button onClick={() => updateTab(activeTabId, { historyOpen: false })} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500" title="Close">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  </div>
                  {tab.historyLoading ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-2">Loading...</p>
                  ) : tab.historySessions.length === 0 ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-2">No past butler sessions found.</p>
                  ) : (
                    <div className="space-y-1">
                      {tab.historySessions.map((s) => (
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
            {tab.chatMessages.length === 0 && (
              <div className="flex items-center justify-center h-full text-center">
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Butler is ready.</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Ask anything about your project or the board.</p>
                </div>
              </div>
            )}
            <div className="max-w-3xl mx-auto">
              {tab.chatMessages.map((msg) => (
                <ChatBubble key={msg.id} msg={msg} />
              ))}
              {tab.sending && (
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
                        onMouseEnter={() => { setCommandIndex(i); commandIndexRef.current = i; }}
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
                  value={tab.input}
                  onChange={(e) => setTabInput(activeTabId, e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={tab.sending}
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
              {tab.sending ? (
                <button
                  onClick={handleStop}
                  className="shrink-0 p-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors shadow-sm"
                  title="Stop the butler"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={!tab.input.trim()}
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
              {tab.sending ? (
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

          <AgentQuestionsPanel projectId={projectId} />
        </>
      )}
      {manageOpen && (
        <ButlerManageModal
          globalBackend={tab?.backend ?? "claude"}
          onClose={() => setManageOpen(false)}
          onChanged={() => { void fetchButlers(); }}
        />
      )}
    </div>
  );
}
