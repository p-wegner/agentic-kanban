import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch } from "../lib/api.js";
import { CLAUDE_MODEL_OPTIONS } from "@agentic-kanban/shared";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import { AgentQuestionsPanel } from "./AgentQuestionsPanel.js";
import { ButlerVoiceButton } from "./ButlerVoiceButton.js";

interface ButlerState {
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

export function ButlerView({ projectId, columns, liveActivity, liveStats, onIssueClick }: ButlerViewProps) {
  const [butlerState, setButlerState] = useState<ButlerState | null>(null);
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const assistantBufRef = useRef("");
  const assistantMsgIdRef = useRef<string | null>(null);

  // Append/replace the streaming assistant bubble as text deltas arrive.
  function appendAssistantText(delta: string) {
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

  // Fetch the command + profile lists. Commands come from the live SDK session
  // (merged with the repo's .claude/skills server-side), so retry once if the
  // session hasn't finished discovery yet. The model list is static (the basic
  // Claude Code tiers, CLAUDE_MODEL_OPTIONS) — only the selection is server state.
  async function loadCapabilities(attempt = 0) {
    try {
      const [cmdData, profData] = await Promise.all([
        apiFetch<{ commands: ButlerCommand[] }>(`/api/projects/${projectId}/butler/commands`),
        apiFetch<{ profiles: string[]; selected: string; globalDefault: string }>(`/api/projects/${projectId}/butler/profiles`),
      ]);
      setCommands(cmdData.commands);
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
    assistantBufRef.current = "";
    assistantMsgIdRef.current = null;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    apiFetch<ButlerState>(`/api/projects/${projectId}/butler`)
      .then(async (state) => {
        setButlerState(state);
        setContextTokens(state.contextTokens ?? 0);
        setModel(state.model);
        setContextWindow(state.contextWindow);
        setMcpConnected(state.mcpConnected);
        setSelectedModel(state.selectedModel ?? "");
        if (state.active) {
          // Restore prior conversation (the SSE stream only carries new events).
          try {
            const { messages } = await apiFetch<{ messages: { role: "user" | "assistant"; text: string; ts: number }[] }>(
              `/api/projects/${projectId}/butler/messages`,
            );
            if (messages.length) {
              setChatMessages(messages.map((m, i) => ({
                id: `hist-${i}-${m.ts}`,
                role: m.role,
                text: m.text,
                ts: m.ts,
              })));
            }
          } catch { /* no history available */ }
          openStream();
          void loadCapabilities();
        }
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
      void loadCapabilities();
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

  // Switch model without restarting — the server uses the SDK setModel control
  // request, so the conversation context is preserved.
  async function handleModelChange(value: string) {
    setSelectedModel(value);
    try {
      await apiFetch(`/api/projects/${projectId}/butler/model`, {
        method: "POST",
        body: JSON.stringify({ model: value }),
      });
    } catch (err) {
      console.error("Failed to switch butler model", err);
    }
  }

  // Switch Claude profile — this changes auth/endpoint, so the butler is restarted
  // fresh (new instance, new context). We mirror that by wiping the local chat.
  async function handleProfileChange(value: string) {
    if (sending || switchingProfile) return;
    setSelectedProfile(value);
    setSwitchingProfile(true);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    try {
      await apiFetch(`/api/projects/${projectId}/butler/profile`, {
        method: "POST",
        body: JSON.stringify({ profile: value }),
      });
      setChatMessages([]);
      setContextTokens(0);
      setModel(undefined);
      assistantBufRef.current = "";
      assistantMsgIdRef.current = null;
      setButlerState({ active: true, sessionId: null });
      openStream();
      void loadCapabilities();
    } catch (err) {
      console.error("Failed to switch butler profile", err);
    } finally {
      setSwitchingProfile(false);
    }
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
      const r = await apiFetch<{ sessions: ButlerSessionSummary[] }>(`/api/projects/${projectId}/butler/sessions?limit=5`);
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
      const r = await apiFetch<{ messages: ButlerSessionMessage[] }>(`/api/projects/${projectId}/butler/sessions/${session.sessionId}/messages`);
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
    setInput((prev) => {
      const sep = prev.length > 0 && !/\s$/.test(prev) ? " " : "";
      return prev + sep + chunk;
    });
    requestAnimationFrame(() => {
      const t = inputRef.current;
      if (t) {
        t.style.height = "auto";
        t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
      }
    });
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
    setInput(next);
    setCommandIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Stop the butler's in-flight turn (interrupt) without clearing the conversation.
  async function handleStop() {
    if (!sending) return;
    try {
      await apiFetch(`/api/projects/${projectId}/butler/interrupt`, { method: "POST", body: "{}" });
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
        setInput((v) => `${v} `);
        return;
      }
    }
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
        <>
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-sm">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-brand-600 flex items-center justify-center shadow-lg">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 mb-2 heading-serif">Project Butler</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              A warm, persistent Claude agent that lives in your repository. Ask questions, get summaries, or run quick tasks — all without creating a new workspace.
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
          {/* Butler toolbar: context pill + clear (left, grouped) · config selects + Customize (right) */}
          <div className="shrink-0 flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 px-4 py-2 text-xs">
            {/* Left group — context status pill with an attached "clear" icon button.
                Grouping them makes it obvious that the button resets the value shown in the pill. */}
            <div className="flex items-center shrink-0 min-w-0 rounded-full border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark overflow-hidden">
              <div
                className="flex items-center gap-1.5 px-3 py-1 text-gray-600 dark:text-gray-300 min-w-0"
                title={[
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
                    : "warm session"}
                </span>
              </div>
              <button
                onClick={handleClearContext}
                disabled={sending}
                className="inline-flex items-center gap-1 border-l border-gray-200 dark:border-gray-700 px-2.5 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                title="Clear the butler's conversation context and start fresh"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
                </svg>
                <span>Clear</span>
              </button>
            </div>

            {/* Right group — config selects, then a clearly-styled Customize button. */}
            <div className="flex items-center gap-2 shrink-0">
              {/* Model picker — switches in place, no context loss. */}
              <label className="flex items-center gap-1 text-gray-500 dark:text-gray-400" title="Model for the butler. Switches without losing context.">
                <span className="hidden sm:inline text-[11px]">Model</span>
                <select
                  value={selectedModel}
                  onChange={(e) => void handleModelChange(e.target.value)}
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {CLAUDE_MODEL_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </label>
              {/* Profile picker — changes auth/endpoint, so it restarts the butler fresh. */}
              <label className="flex items-center gap-1 text-gray-500 dark:text-gray-400" title="Claude profile (auth/endpoint, e.g. zai). Switching restarts the butler with a fresh context.">
                <span className="hidden sm:inline text-[11px]">Profile</span>
                <select
                  value={selectedProfile}
                  onChange={(e) => void handleProfileChange(e.target.value)}
                  disabled={switchingProfile || sending}
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
                <span aria-hidden>⚙</span>
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
                    {customizeBusy ? "Saving…" : "Save & apply"}
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
                        {historyTranscript.session.turnCount} turns · {formatRelativeTs(new Date(historyTranscript.session.startedAt).getTime())}
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
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-2">Loading…</p>
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
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={sending}
                  rows={1}
                  placeholder="Message the butler... (Enter to send, Shift+Enter for new line, / for commands)"
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
                    🎙️ {interimVoiceText}
                  </div>
                )}
              </div>
              <ButlerVoiceButton
                disabled={sending}
                onTranscript={appendVoiceTranscript}
                onInterim={setInterimVoiceText}
              />
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
                  onClick={handleSend}
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
                "Persistent warm butler · runs in your project repo · Enter to send · 🎙️ to dictate"
              )}
            </p>
          </div>

          {/* Pending agent questions — secondary inbox, anchored below the chat. */}
          <AgentQuestionsPanel projectId={projectId} />
        </>
      )}
    </div>
  );
}
