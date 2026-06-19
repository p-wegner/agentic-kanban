import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { extractMeaningfulOutput } from "@agentic-kanban/shared";
import { createAgentOutputParser, type AgentOutputFormat, type DisplayEvent } from "../lib/agent-output-parser.js";
import {
  MAX_DISPLAY_EVENTS,
  truncateEventsForDisplay,
  SEARCH_FILTERS,
  buildTranscriptSearchEntries,
  type SearchFilter,
} from "../lib/terminal-transcript.js";
import { renderParsedEvent, highlightText, type RenderContext } from "./TerminalEventRenderer.js";

interface TerminalViewProps {
  messages: AgentOutputMessage[];
  connectionState: "connecting" | "open" | "closed" | "error";
  parseOutput?: "minimal" | "false";
  outputFormat?: AgentOutputFormat;
  prompt?: string;
  title?: string;
  footer?: ReactNode;
  multiTurn?: boolean;
  sessionId?: string;
}

const SCROLL_THRESHOLD = 50;


export function TerminalView({ messages, connectionState, parseOutput = "minimal", outputFormat = "claude-stream-json", prompt, title, footer, multiTurn, sessionId }: TerminalViewProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const [displayEvents, setDisplayEvents] = useState<DisplayEvent[]>([]);
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [markers, setMarkers] = useState<Array<{ idx: number; color: string; pct: number }>>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIdx, setActiveSearchIdx] = useState(0);
  const [searchFilters, setSearchFilters] = useState<Set<SearchFilter>>(new Set());

  const handleDownload = useCallback(() => {
    const lines = extractMeaningfulOutput(messages.map(m => ({ ...m, data: m.data ?? null })), 10000);
    const text = lines.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sessionId ? `session-${sessionId}.txt` : "session-output.txt";
    a.click();
    URL.revokeObjectURL(url);
  }, [messages, sessionId]);

  const toggleExpand = useCallback((idx: number) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  // Re-parse all messages when they change or parseOutput toggles
  useEffect(() => {
    if (parseOutput === "false") {
      setDisplayEvents(
        messages.map((msg) => {
          if (msg.type === "exit") {
            return { kind: "raw" as const, text: `Process exited with code ${msg.exitCode ?? "unknown"}` };
          }
          return { kind: "raw" as const, text: msg.data || "" };
        }).filter((e) => e.text.length > 0),
      );
      return;
    }

    const parser = createAgentOutputParser(outputFormat);
    const events: DisplayEvent[] = [];

    for (const msg of messages) {
      if (msg.type === "exit") {
        events.push({ kind: "raw", text: `Process exited with code ${msg.exitCode ?? "unknown"}` });
        continue;
      }
      if (msg.type === "bisect") {
        try {
          const parsed = JSON.parse(msg.data || "{}") as { breakingCommitSha?: string; message?: string; failingTestName?: string; status?: string };
          events.push({
            kind: "raw",
            text: parsed.breakingCommitSha
              ? `Auto-bisect result: ${parsed.breakingCommitSha} ${parsed.message ?? ""}${parsed.failingTestName ? `\nFailing test: ${parsed.failingTestName}` : ""}`
              : `Auto-bisect result: ${parsed.status ?? "finished"}`,
          });
        } catch {
          events.push({ kind: "raw", text: msg.data || "Auto-bisect result" });
        }
        continue;
      }
      if (msg.type === "stderr") {
        events.push({ kind: "raw", text: msg.data || "" });
        continue;
      }
      if (msg.data) {
        events.push(...parser.feed(msg.data + "\n"));
      }
    }

    events.push(...parser.flush());
    setDisplayEvents(events);
    setExpandedSections(new Set());
  }, [messages, parseOutput, outputFormat]);

  // Smart autoscroll: only scroll when user is at bottom
  useEffect(() => {
    if (preRef.current && isAtBottom) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [displayEvents, isAtBottom]);

  const handleScroll = () => {
    if (!preRef.current) return;
    const el = preRef.current;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    setIsAtBottom((prev) => prev === nearBottom ? prev : nearBottom);
    setShowScrollButton((prev) => prev === !nearBottom ? prev : !nearBottom);
  };

  const scrollToBottom = () => {
    if (!preRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
    setIsAtBottom(true);
    setShowScrollButton(false);
  };

  const { events: visibleEvents, truncated: isTranscriptTruncated } = useMemo(
    () => truncateEventsForDisplay(displayEvents),
    [displayEvents],
  );

  const hasSearch = searchQuery.trim().length > 0 || searchFilters.size > 0;
  const searchEntries = useMemo(
    () => buildTranscriptSearchEntries(visibleEvents, searchQuery, searchFilters),
    [visibleEvents, searchQuery, searchFilters],
  );
  const activeSearchEventIdx = hasSearch && searchEntries.length > 0 ? searchEntries[activeSearchIdx]?.idx : undefined;

  useEffect(() => {
    setActiveSearchIdx((idx) => {
      if (searchEntries.length === 0) return 0;
      return Math.min(idx, searchEntries.length - 1);
    });
  }, [searchEntries.length]);

  useEffect(() => {
    if (activeSearchEventIdx === undefined || !preRef.current) return;
    const el = preRef.current.querySelector(`[data-event-idx="${activeSearchEventIdx}"]`) as HTMLElement | null;
    if (!el) return;
    preRef.current.scrollTop = Math.max(0, el.offsetTop - 24);
    setIsAtBottom(false);
    setShowScrollButton(true);
  }, [activeSearchEventIdx]);

  const toggleSearchFilter = (filter: SearchFilter) => {
    setSearchFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchFilters(new Set());
    setActiveSearchIdx(0);
  };

  const goToSearchMatch = (delta: number) => {
    if (searchEntries.length === 0) return;
    setActiveSearchIdx((idx) => (idx + delta + searchEntries.length) % searchEntries.length);
  };

  useEffect(() => {
    if (!isMaximized) return;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setIsMaximized(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isMaximized]);

  const statusColors: Record<string, string> = {
    connecting: "bg-yellow-400",
    open: "bg-green-400",
    closed: "bg-gray-400",
    error: "bg-red-400",
  };

  const statusLabels: Record<string, string> = {
    connecting: "Connecting...",
    open: "Connected",
    closed: "Disconnected",
    error: "Connection Error",
  };

  const isParsed = parseOutput !== "false" && visibleEvents.some((e) => e.kind !== "raw");

  const toggleMaximize = () => setIsMaximized((v) => !v);

  // Compute which subagent tool_use_ids are still active (started but no result yet)
  // Uses proper ID matching: task_started.toolUseId → Agent tool_use.id → tool_result.toolUseId
  const activeSubagentToolUseIds = (() => {
    const startedIds = new Set<string>();
    const completedIds = new Set<string>();
    for (const ev of visibleEvents) {
      if (ev.kind === "task_started" && ev.toolUseId) {
        startedIds.add(ev.toolUseId);
      }
      if (ev.kind === "tool_result" && ev.toolName === "Agent" && ev.toolUseId) {
        completedIds.add(ev.toolUseId);
      }
    }
    const activeSet = new Set<string>();
    for (const id of startedIds) {
      if (!completedIds.has(id)) {
        activeSet.add(id);
      }
    }
    return activeSet;
  })();

  // Build grouping info: for each event, determine if it belongs to a subagent section
  // A subagent section spans from an Agent tool_use event through its task_started,
  // any nested events, to the corresponding tool_result.
  // Events between an Agent tool_use and its tool_result that aren't part of another
  // subagent are grouped under that subagent.
  const subagentGroups = (() => {
    // Map: toolUseId → { startIdx, endIdx, description, subagentType }
    const groups = new Map<string, { startIdx: number; endIdx: number; description: string; subagentType: string }>();
    const openAgents = new Map<string, { idx: number; description: string; subagentType: string }>();

    for (let i = 0; i < visibleEvents.length; i++) {
      const ev = visibleEvents[i];
      if (ev.kind === "tool_use" && ev.name === "Agent" && ev.id) {
        openAgents.set(ev.id, {
          idx: i,
          description: (ev.inputParsed?.description as string) || (ev.inputParsed?.prompt as string) || "",
          subagentType: (ev.inputParsed?.subagent_type as string) || "",
        });
      }
      if (ev.kind === "tool_result" && ev.toolName === "Agent" && ev.toolUseId && openAgents.has(ev.toolUseId)) {
        const opener = openAgents.get(ev.toolUseId)!;
        groups.set(ev.toolUseId, {
          startIdx: opener.idx,
          endIdx: i,
          description: opener.description,
          subagentType: opener.subagentType,
        });
        openAgents.delete(ev.toolUseId);
      }
    }
    // Still-open agents (running)
    for (const [id, opener] of openAgents) {
      groups.set(id, {
        startIdx: opener.idx,
        endIdx: visibleEvents.length - 1,
        description: opener.description,
        subagentType: opener.subagentType,
      });
    }
    return groups;
  })();

  // Map: event index → toolUseId of the containing subagent group
  const eventToSubagent = (() => {
    const map = new Map<number, string>();
    for (const [toolUseId, group] of subagentGroups) {
      for (let i = group.startIdx; i <= group.endIdx; i++) {
        map.set(i, toolUseId);
      }
    }
    return map;
  })();

  const ctx: RenderContext = {
    multiTurn,
    expandedSections,
    toggleExpand,
    parseOutput,
    activeSubagentToolUseIds,
    subagentGroups,
    eventToSubagent,
    isMaximized,
    searchQuery,
  };

  const renderedEvents = hasSearch ? searchEntries.map((entry) => entry.event) : visibleEvents;
  const renderedIndexes = hasSearch ? searchEntries.map((entry) => entry.idx) : visibleEvents.map((_, idx) => idx);

  const content = (
    <>
      {prompt && (
        <div className="mb-2 pb-2 border-b border-gray-700">
          <span className="text-blue-400">&gt; </span>
          <span className="text-gray-200">{prompt}</span>
        </div>
      )}
      {isParsed
        ? renderedEvents.map((event, i) => renderParsedEvent(event, renderedIndexes[i], ctx))
        : renderedEvents.map((event, i) => (
            <div key={renderedIndexes[i]} data-event-idx={renderedIndexes[i]} className={event.kind === "raw" && messages[renderedIndexes[i]]?.type === "stderr" ? "text-red-400" : ""}>
              {event.kind === "raw" ? highlightText(event.text, searchQuery) : ""}
            </div>
          ))}
      {hasSearch && searchEntries.length === 0 && (
        <div className="text-gray-500 text-xs py-2">
          No transcript matches found.
        </div>
      )}
      {isTranscriptTruncated && (
        <div className="text-yellow-500 text-xs py-2 border-t border-gray-700 mt-2">
          Transcript too large — showing first {MAX_DISPLAY_EVENTS} events. Download the full session for complete output.
        </div>
      )}
      {visibleEvents.length === 0 && connectionState === "connecting" && (
        <span className="text-gray-500 animate-pulse">Starting agent...</span>
      )}
      {visibleEvents.length === 0 && connectionState === "open" && (
        <span className="text-gray-500">Waiting for output...</span>
      )}
    </>
  );

  const searchControls = (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-700 bg-gray-900 px-3 py-1.5">
      <div className="relative min-w-[180px] flex-1">
        <input
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setActiveSearchIdx(0);
          }}
          placeholder="Search transcript"
          aria-label="Search transcript"
          className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 pr-7 text-[11px] text-gray-100 placeholder:text-gray-500 focus:border-brand-500 focus:outline-none"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => {
              setSearchQuery("");
              setActiveSearchIdx(0);
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-gray-500 hover:bg-gray-800 hover:text-gray-200"
            title="Clear search text"
            aria-label="Clear search text"
          >
            x
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 text-[11px] text-gray-400">
        <button
          type="button"
          onClick={() => goToSearchMatch(-1)}
          disabled={searchEntries.length === 0}
          className="rounded border border-gray-700 px-1.5 py-1 text-gray-300 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          title="Previous match"
          aria-label="Previous match"
        >
          ^
        </button>
        <button
          type="button"
          onClick={() => goToSearchMatch(1)}
          disabled={searchEntries.length === 0}
          className="rounded border border-gray-700 px-1.5 py-1 text-gray-300 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          title="Next match"
          aria-label="Next match"
        >
          v
        </button>
        <span className="min-w-[52px] text-center" title={isTranscriptTruncated ? `Showing first ${MAX_DISPLAY_EVENTS} of ${displayEvents.length} events` : undefined}>
          {hasSearch ? (searchEntries.length > 0 ? `${activeSearchIdx + 1}/${searchEntries.length}` : "0/0") : `${visibleEvents.length}${isTranscriptTruncated ? "+" : ""}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {SEARCH_FILTERS.map((filter) => {
          const selected = searchFilters.has(filter.id);
          return (
            <button
              key={filter.id}
              type="button"
              onClick={() => {
                toggleSearchFilter(filter.id);
                setActiveSearchIdx(0);
              }}
              className={`rounded border px-1.5 py-1 text-[11px] ${
                selected
                  ? "border-brand-500 bg-brand-900/50 text-brand-100"
                  : "border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
              aria-pressed={selected}
            >
              {filter.label}
            </button>
          );
        })}
      </div>
      {hasSearch && (
        <button
          type="button"
          onClick={clearSearch}
          className="rounded px-1.5 py-1 text-[11px] text-gray-400 hover:bg-gray-700 hover:text-gray-100"
          aria-label="Clear transcript search"
        >
          Clear
        </button>
      )}
    </div>
  );

  // Scrollbar markers — position computed here, not during render
  useLayoutEffect(() => {
    if (!preRef.current || !isParsed) {
      setMarkers([]);
      return;
    }
    const container = preRef.current;
    const newMarkers: typeof markers = [];
    const children = container.querySelectorAll("[data-event-idx]");

    children.forEach((el) => {
      const idx = Number((el as HTMLElement).dataset.eventIdx);
      const event = visibleEvents[idx];
      if (!event || event.kind === "raw") return;

      let color: string;
      switch (event.kind) {
        case "assistant": color = "bg-green-500"; break;
        case "thinking": color = "bg-gray-500"; break;
        case "tool_use": color = (event.kind === "tool_use" && event.name === "Agent") ? "bg-brand-500" : "bg-yellow-500"; break;
        case "tool_result": color = event.isError ? "bg-red-500" : "bg-brand-500"; break;
        case "result": color = event.success ? "bg-emerald-400" : "bg-red-400"; break;
        case "init": color = "bg-cyan-400"; break;
        case "task_started": color = "bg-blue-500"; break;
        case "notification": color = (event.kind === "notification" && event.key === "user") ? "bg-blue-500" : "bg-orange-500"; break;
        case "rate_limit": color = "bg-yellow-500"; break;
        default: color = "bg-gray-600";
      }

      const pct = (el instanceof HTMLElement ? el.offsetTop : 0) / container.scrollHeight * 100;
      newMarkers.push({ idx, color, pct });
    });

    setMarkers(newMarkers);
  }, [visibleEvents, isParsed, expandedSections]);

  const scrollIndicator = isParsed && markers.length > 0 && (
    <div className="absolute top-0 right-0 bottom-0 w-3 z-10">
      {markers.map((m) => {
        const el = preRef.current?.querySelector(`[data-event-idx="${m.idx}"]`) as HTMLElement | null;
        return (
          <div
            key={m.idx}
            className={`absolute right-0 w-1.5 h-1 rounded-full ${m.color} cursor-pointer opacity-60 hover:opacity-100 hover:w-2 transition-all`}
            style={{ top: `${m.pct}%` }}
            onClick={() => {
              if (el && preRef.current) {
                preRef.current.scrollTop = el.offsetTop - 20;
              }
            }}
          />
        );
      })}
    </div>
  );

  const scrollButton = showScrollButton && (
    <button
      onClick={scrollToBottom}
      className="absolute bottom-2 right-4 z-10 p-1.5 rounded-full bg-gray-700 hover:bg-gray-600 text-white shadow-lg transition-opacity"
      title="Scroll to bottom"
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 5v14M5 12l7 7 7-7" />
      </svg>
    </button>
  );

  if (isMaximized) {
    return (
      <div className="fixed inset-0 z-[55] bg-gray-950 flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-700">
          <span className={`w-2 h-2 rounded-full ${statusColors[connectionState]}`} />
          <span className="text-sm text-gray-300">{title ?? "Agent Output"}</span>
          {isParsed && <span className="text-xs text-blue-400">parsed</span>}
          <button
            onClick={handleDownload}
            className="ml-auto p-1 text-gray-400 hover:text-white rounded hover:bg-gray-700"
            title="Download session output"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 15V3m0 12l-4-4m4 4l4-4M2 17l.621 2.485A2 2 0 0 0 4.561 21h14.878a2 2 0 0 0 1.94-1.515L22 17" />
            </svg>
          </button>
          <button
            onClick={toggleMaximize}
            className="p-1 text-gray-400 hover:text-white rounded hover:bg-gray-700"
            title="Restore (Esc)"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
            </svg>
          </button>
        </div>
        {searchControls}
        <div className="relative flex-1 min-h-0">
          <pre
            ref={preRef}
            onScroll={handleScroll}
            className="absolute inset-0 overflow-y-auto overflow-x-hidden p-4 text-xs text-green-400 font-mono whitespace-pre-wrap"
          >
            {content}
          </pre>
          {scrollButton}
        </div>
        {footer && <div className="border-t border-gray-700 p-2">{footer}</div>}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-64 border border-gray-300 dark:border-gray-600 rounded bg-gray-900">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border-b border-gray-700">
          <span className={`w-2 h-2 rounded-full ${statusColors[connectionState]}`} />
          <span className="text-xs text-gray-300">{statusLabels[connectionState]}</span>
          {isParsed && (
            <span className="text-xs text-blue-400 ml-auto">parsed</span>
          )}
          <button
            onClick={handleDownload}
            className={`${isParsed ? "" : "ml-auto"} p-0.5 text-gray-400 hover:text-white rounded hover:bg-gray-700`}
            title="Download session output"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 15V3m0 12l-4-4m4 4l4-4M2 17l.621 2.485A2 2 0 0 0 4.561 21h14.878a2 2 0 0 0 1.94-1.515L22 17" />
            </svg>
          </button>
          <button
            onClick={toggleMaximize}
            className="p-0.5 text-gray-400 hover:text-white rounded hover:bg-gray-700"
            title="Maximize"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
        {searchControls}
        <div className="relative flex-1 min-h-0">
          <pre
            ref={preRef}
            onScroll={handleScroll}
            className="absolute inset-0 overflow-auto p-3 text-xs text-green-400 font-mono whitespace-pre-wrap"
          >
            {content}
          </pre>
          {scrollIndicator}
          {scrollButton}
        </div>
      </div>
      {footer}
    </>
  );
}

