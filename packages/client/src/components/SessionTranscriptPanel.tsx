import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentOutputMessage, SessionSummaryResponse, WorkspaceResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import {
  getOutputFormatForAgent,
  getOutputFormatForProvider,
  type AgentOutputFormat,
} from "../lib/agent-output-parser.js";
import { parseSessionTranscript, type TranscriptEvent } from "../lib/parseSessionTranscript.js";
import {
  OPEN_SESSION_TRANSCRIPT_EVENT,
  SESSION_ACTIVITY_WS_EVENT,
  type SessionActivityEventDetail,
  type SessionTranscriptTarget,
} from "../lib/sessionTranscriptEvents.js";
import type { SessionInfo } from "./WorkspaceCard.js";

/** Tool output longer than this (chars) collapses behind an expand toggle. */
const COLLAPSE_THRESHOLD = 400;
/** Auto-scroll stays "stuck" to the bottom only when within this many px of it. */
const SCROLL_STICK_PX = 80;
/** Fallback poll while a session is still running (WS activity is the primary trigger). */
const LIVE_POLL_MS = 4000;

interface ResolvedTarget {
  sessionId: string;
  outputFormat: AgentOutputFormat;
  title: string;
}

async function resolveTarget(target: SessionTranscriptTarget): Promise<ResolvedTarget | null> {
  let { sessionId, outputFormat } = target;

  if ((!sessionId || !outputFormat) && target.workspaceId) {
    // Resolve the latest session and/or the provider-derived format from the workspace.
    if (!sessionId) {
      const sessions = await apiFetch<SessionInfo[]>(`/api/workspaces/${target.workspaceId}/sessions`);
      const latest = [...sessions].sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )[0];
      sessionId = latest?.id;
    }
    if (!outputFormat) {
      try {
        const ws = await apiFetch<WorkspaceResponse>(`/api/workspaces/${target.workspaceId}`);
        outputFormat = ws.provider
          ? getOutputFormatForProvider(ws.provider)
          : getOutputFormatForAgent(ws.agentCommand ?? undefined);
      } catch {
        // fall through to default below
      }
    }
  }

  if (!sessionId) return null;
  return {
    sessionId,
    outputFormat: outputFormat ?? "claude-stream-json",
    title: target.title ?? "Session transcript",
  };
}

const KIND_META: Record<
  TranscriptEvent["kind"],
  { label: string; badge: string; accent: string }
> = {
  user: { label: "User", badge: "bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300", accent: "border-brand-400" },
  assistant: { label: "Assistant", badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300", accent: "border-emerald-400" },
  thinking: { label: "Thinking", badge: "bg-violet-100 text-violet-600 dark:bg-violet-900/40 dark:text-violet-300", accent: "border-violet-300" },
  tool_call: { label: "Tool", badge: "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300", accent: "border-sky-400" },
  tool_result: { label: "Result", badge: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300", accent: "border-gray-300 dark:border-gray-600" },
  tool_error: { label: "Error", badge: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300", accent: "border-red-400" },
  result: { label: "Done", badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300", accent: "border-amber-400" },
  raw: { label: "Log", badge: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400", accent: "border-gray-200 dark:border-gray-700" },
};

function CollapsibleText({ text, mono }: { text: string; mono?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > COLLAPSE_THRESHOLD;
  const shown = long && !expanded ? `${text.slice(0, COLLAPSE_THRESHOLD)}…` : text;
  return (
    <div>
      <pre
        className={`whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-soft dark:text-gray-300 ${mono ? "font-mono" : ""}`}
      >
        {shown}
      </pre>
      {long && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-brand-600 dark:text-brand-400 hover:underline"
        >
          {expanded ? "Show less" : `Show ${text.length - COLLAPSE_THRESHOLD} more chars`}
        </button>
      )}
    </div>
  );
}

function EventRow({ event }: { event: TranscriptEvent }) {
  const meta = KIND_META[event.kind];
  const isTool = event.kind === "tool_call";
  const isToolOutput = event.kind === "tool_result" || event.kind === "tool_error";
  return (
    <div className={`border-l-2 ${meta.accent} pl-3 py-1`}>
      <div className="flex items-center gap-2 mb-0.5">
        <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${meta.badge}`}>
          {meta.label}
        </span>
        {event.toolName && (
          <span className="text-xs font-mono font-medium text-ink dark:text-gray-200">{event.toolName}</span>
        )}
        {event.kind === "result" && (
          <span className={`text-[11px] font-medium ${event.success ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {event.success ? "success" : "failed"}
            {typeof event.durationMs === "number" ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ""}
          </span>
        )}
        {event.model && event.kind === "assistant" && (
          <span className="text-[10px] text-ink-faint dark:text-gray-500 ml-auto font-mono">{event.model}</span>
        )}
      </div>
      {isTool ? (
        <div>
          {event.text && (
            <p className="text-xs font-mono text-ink-soft dark:text-gray-300 truncate" title={event.text}>
              {event.text}
            </p>
          )}
          {event.toolInput && event.toolInput !== "{}" && <CollapsibleText text={event.toolInput} mono />}
        </div>
      ) : event.text ? (
        <CollapsibleText text={event.text} mono={isToolOutput || event.kind === "raw"} />
      ) : (
        <p className="text-xs italic text-ink-faint dark:text-gray-500">(no content)</p>
      )}
    </div>
  );
}

function isRunning(summary: SessionSummaryResponse | null): boolean {
  if (!summary) return false;
  return summary.status === "running" || summary.endedAt == null;
}

export function SessionTranscriptPanel() {
  const [resolved, setResolved] = useState<ResolvedTarget | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [summary, setSummary] = useState<SessionSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const fetchingRef = useRef(false);

  // Open on the window CustomEvent from any launch site.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const target = (e as CustomEvent<SessionTranscriptTarget>).detail;
      setEvents([]);
      setSummary(null);
      setError(null);
      setLoading(true);
      stickToBottomRef.current = true;
      resolveTarget(target)
        .then((r) => {
          if (!r) {
            setError("No session found for this workspace yet.");
            setLoading(false);
            return;
          }
          setResolved(r);
        })
        .catch(() => {
          setError("Could not resolve the session.");
          setLoading(false);
        });
    };
    window.addEventListener(OPEN_SESSION_TRANSCRIPT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SESSION_TRANSCRIPT_EVENT, onOpen);
  }, []);

  const refetch = useCallback(async () => {
    if (!resolved || fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const [messages, nextSummary] = await Promise.all([
        apiFetch<AgentOutputMessage[]>(`/api/sessions/${resolved.sessionId}/output`),
        apiFetch<SessionSummaryResponse>(`/api/sessions/${resolved.sessionId}/summary`).catch(() => null),
      ]);
      setEvents(parseSessionTranscript(messages, resolved.outputFormat));
      if (nextSummary) setSummary(nextSummary);
      setError(null);
    } catch {
      setError("Failed to load session output.");
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, [resolved]);

  // Initial + on-target-change load.
  useEffect(() => {
    if (!resolved) return;
    void refetch();
  }, [resolved, refetch]);

  // Live-append: trigger a refetch on the session_activity WS event for this
  // session, plus a low-frequency poll fallback while the session runs.
  useEffect(() => {
    if (!resolved || !isRunning(summary)) return;
    const onActivity = (e: Event) => {
      const detail = (e as CustomEvent<SessionActivityEventDetail>).detail;
      if (detail.sessionId === resolved.sessionId) void refetch();
    };
    window.addEventListener(SESSION_ACTIVITY_WS_EVENT, onActivity);
    const timer = setInterval(() => void refetch(), LIVE_POLL_MS);
    return () => {
      window.removeEventListener(SESSION_ACTIVITY_WS_EVENT, onActivity);
      clearInterval(timer);
    };
  }, [resolved, summary, refetch]);

  // Auto-scroll to the newest event when the user is already near the bottom.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_STICK_PX;
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      stickToBottomRef.current = true;
    }
  };

  const close = useCallback(() => {
    setResolved(null);
    setEvents([]);
    setSummary(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (!resolved) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resolved, close]);

  if (!resolved) return null;

  const running = isRunning(summary);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-gray-950/95 text-gray-100">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/10 bg-gray-900">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <svg className="w-4 h-4 shrink-0 text-brand-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
          <h2 className="text-sm font-semibold truncate">{resolved.title}</h2>
          {running && (
            <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> live
            </span>
          )}
        </div>
        {summary && (
          <div className="hidden sm:flex items-center gap-3 text-[11px] text-gray-400 shrink-0">
            {summary.model && <span className="font-mono">{summary.model}</span>}
            {summary.duration && <span>{summary.duration}</span>}
            {summary.filesEdited.length + summary.filesWritten.length > 0 && (
              <span title="Files edited/written">✎ {summary.filesEdited.length + summary.filesWritten.length}</span>
            )}
            {summary.commandsRun.length > 0 && <span title="Commands run">$ {summary.commandsRun.length}</span>}
          </div>
        )}
        <button
          onClick={jumpToLatest}
          className="shrink-0 text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
          title="Jump to latest"
        >
          ↓ Latest
        </button>
        <button
          onClick={close}
          className="shrink-0 flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
          aria-label="Close transcript"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto bg-gray-950">
        {error ? (
          <div className="px-6 py-16 text-center text-sm text-red-400">{error}</div>
        ) : loading && events.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-gray-500">Loading transcript…</div>
        ) : events.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-gray-500">No transcript events yet.</div>
        ) : (
          <div className="max-w-4xl mx-auto px-4 py-3 space-y-1.5">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
