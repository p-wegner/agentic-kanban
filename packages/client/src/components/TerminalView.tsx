import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { ClaudeOutputParser, type DisplayEvent } from "../lib/claude-output-parser.js";

interface TerminalViewProps {
  messages: AgentOutputMessage[];
  connectionState: "connecting" | "open" | "closed" | "error";
  parseOutput?: "true" | "false" | "minimal";
  prompt?: string;
  title?: string;
  footer?: ReactNode;
  multiTurn?: boolean;
}

interface RenderContext {
  multiTurn?: boolean;
  expandedSections: Set<number>;
  toggleExpand: (idx: number) => void;
  parseOutput: "true" | "false" | "minimal";
}

const SCROLL_THRESHOLD = 50;

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return `Reading ${basename((input.file_path as string) || "file")}`;
    case "Edit":
      return `Editing ${basename((input.file_path as string) || "file")}`;
    case "Write":
      return `Writing ${basename((input.file_path as string) || "file")}`;
    case "Bash": {
      const cmd = ((input.command as string) || "").slice(0, 80);
      return `Running: ${cmd || "command"}`;
    }
    case "Grep":
      return `Searching for "${input.pattern || "pattern"}"`;
    case "Glob":
      return `Finding ${input.pattern || "files"}`;
    case "Agent":
      return "Delegating to agent";
    case "WebSearch":
      return "Searching web";
    case "WebFetch":
    case "mcp__web_reader__webReader":
      return "Fetching URL";
    default:
      return name;
  }
}

export function TerminalView({ messages, connectionState, parseOutput = "true", prompt, title, footer, multiTurn }: TerminalViewProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const [displayEvents, setDisplayEvents] = useState<DisplayEvent[]>([]);
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [markers, setMarkers] = useState<Array<{ idx: number; color: string; pct: number }>>([]);

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

    const parser = new ClaudeOutputParser();
    const events: DisplayEvent[] = [];

    for (const msg of messages) {
      if (msg.type === "exit") {
        events.push({ kind: "raw", text: `Process exited with code ${msg.exitCode ?? "unknown"}` });
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
  }, [messages, parseOutput]);

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

  useEffect(() => {
    if (!isMaximized) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setIsMaximized(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
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

  const isParsed = parseOutput !== "false" && displayEvents.some((e) => e.kind !== "raw");

  const toggleMaximize = () => setIsMaximized((v) => !v);

  const ctx: RenderContext = {
    multiTurn,
    expandedSections,
    toggleExpand,
    parseOutput,
  };

  const content = (
    <>
      {prompt && (
        <div className="mb-2 pb-2 border-b border-gray-700">
          <span className="text-blue-400">&gt; </span>
          <span className="text-gray-200">{prompt}</span>
        </div>
      )}
      {isParsed
        ? displayEvents.map((event, i) => renderParsedEvent(event, i, ctx))
        : displayEvents.map((event, i) => (
            <div key={i} className={event.kind === "raw" && messages[i]?.type === "stderr" ? "text-red-400" : ""}>
              {event.kind === "raw" ? event.text : ""}
            </div>
          ))}
      {displayEvents.length === 0 && connectionState === "connecting" && (
        <span className="text-gray-500 animate-pulse">Starting agent...</span>
      )}
      {displayEvents.length === 0 && connectionState === "open" && (
        <span className="text-gray-500">Waiting for output...</span>
      )}
    </>
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
      const event = displayEvents[idx];
      if (!event || event.kind === "raw") return;

      let color: string;
      switch (event.kind) {
        case "assistant": color = "bg-green-500"; break;
        case "thinking": color = "bg-gray-500"; break;
        case "tool_use": color = "bg-yellow-500"; break;
        case "tool_result": color = event.isError ? "bg-red-500" : "bg-purple-500"; break;
        case "result": color = event.success ? "bg-emerald-400" : "bg-red-400"; break;
        case "init": color = "bg-cyan-400"; break;
        default: color = "bg-gray-600";
      }

      const pct = (el instanceof HTMLElement ? el.offsetTop : 0) / container.scrollHeight * 100;
      newMarkers.push({ idx, color, pct });
    });

    setMarkers(newMarkers);
  }, [displayEvents, isParsed, expandedSections]);

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
          {isParsed && <span className="text-xs text-blue-400">{parseOutput === "minimal" ? "minimal" : "stream-json"}</span>}
          <button
            onClick={toggleMaximize}
            className="ml-auto p-1 text-gray-400 hover:text-white rounded hover:bg-gray-700"
            title="Restore (Esc)"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
            </svg>
          </button>
        </div>
        <div className="relative flex-1 min-h-0">
          <pre
            ref={preRef}
            onScroll={handleScroll}
            className="absolute inset-0 overflow-auto p-4 text-xs text-green-400 font-mono whitespace-pre-wrap"
          >
            {content}
          </pre>
          {scrollIndicator}
          {scrollButton}
        </div>
        {footer && <div className="border-t border-gray-700 p-2">{footer}</div>}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-64 border border-gray-300 rounded bg-gray-900">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border-b border-gray-700">
          <span className={`w-2 h-2 rounded-full ${statusColors[connectionState]}`} />
          <span className="text-xs text-gray-300">{statusLabels[connectionState]}</span>
          {isParsed && (
            <span className="text-xs text-blue-400 ml-auto">{parseOutput === "minimal" ? "minimal" : "stream-json"}</span>
          )}
          <button
            onClick={toggleMaximize}
            className={`${isParsed ? "" : "ml-auto"} p-0.5 text-gray-400 hover:text-white rounded hover:bg-gray-700`}
            title="Maximize"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
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

function renderParsedEvent(event: DisplayEvent, key: number, ctx: RenderContext): React.ReactNode {
  const { multiTurn, expandedSections, toggleExpand, parseOutput } = ctx;
  const isExpanded = expandedSections.has(key);
  const isMinimal = parseOutput === "minimal";

  if (event.kind === "raw") {
    return (
      <div key={key} data-event-idx={key} className="text-green-400">
        {event.text}
      </div>
    );
  }

  if (event.kind === "init") {
    if (isMinimal) {
      return (
        <div key={key} data-event-idx={key} className="text-gray-500 text-[11px] mb-1">
          Session started: {event.model}
        </div>
      );
    }
    return (
      <div key={key} data-event-idx={key} className="mb-2 pb-2 border-b border-gray-700">
        <div className="text-cyan-400 font-bold">
          Session initialized
        </div>
        <div className="text-gray-400">
          Model: <span className="text-white">{event.model}</span>
          {" | "}CWD: <span className="text-white">{event.cwd}</span>
        </div>
        {event.mcpServers.length > 0 && (
          <div className="text-gray-400">
            MCP: {event.mcpServers.map((s) => (
              <span key={s.name} className={s.status === "connected" ? "text-green-400" : "text-red-400"}>
                {s.name}{" "}
              </span>
            ))}
          </div>
        )}
        <div className="text-gray-500 text-[10px] mt-1">
          {event.tools.length} tools loaded | {event.permissionMode} mode
        </div>
      </div>
    );
  }

  if (event.kind === "assistant") {
    if (isMinimal) {
      const lines = event.text.split("\n");
      const truncated = lines.length > 3 && !isExpanded;
      return (
        <div key={key} data-event-idx={key} className="mb-1">
          <div className="text-green-300 text-[11px]">
            {truncated ? lines.slice(0, 3).join("\n") + "..." : event.text}
          </div>
          {truncated && (
            <button
              className="text-blue-400 text-[10px] hover:underline"
              onClick={() => toggleExpand(key)}
            >
              show more
            </button>
          )}
        </div>
      );
    }
    return (
      <div key={key} data-event-idx={key} className="mb-1">
        {event.model && (
          <span className="text-blue-400 text-[10px]">[{event.model}]</span>
        )}
        <div className="text-green-300">{event.text}</div>
      </div>
    );
  }

  if (event.kind === "thinking") {
    if (isMinimal) return null;
    return (
      <div key={key} data-event-idx={key} className="mb-1 text-gray-500 italic text-[11px]">
        Thinking: {event.text.length > 200 ? event.text.slice(0, 200) + "..." : event.text}
      </div>
    );
  }

  if (event.kind === "tool_use") {
    if (isMinimal) {
      const summary = summarizeToolCall(event.name, event.inputParsed || {});
      return (
        <div key={key} data-event-idx={key} className="mb-0.5 ml-1 text-[11px]">
          <span className="text-yellow-500">{summary}</span>
          {!isExpanded && event.input && (
            <button
              className="text-gray-600 text-[10px] ml-1 hover:text-gray-400"
              onClick={() => toggleExpand(key)}
            >
              details
            </button>
          )}
          {isExpanded && (
            <>
              <button
                className="text-gray-600 text-[10px] ml-1 hover:text-gray-400"
                onClick={() => toggleExpand(key)}
              >
                hide
              </button>
              <pre className="text-gray-500 text-[10px] mt-0.5 ml-2 whitespace-pre-wrap">{event.input}</pre>
            </>
          )}
        </div>
      );
    }
    return (
      <div key={key} data-event-idx={key} className="mb-1 ml-2 pl-2 border-l-2 border-yellow-600">
        <span className="text-yellow-400">Tool: {event.name}</span>
        {event.input && (
          <div
            className={`text-gray-500 text-[10px] mt-0.5 cursor-pointer select-none ${isExpanded ? "" : "max-h-5 overflow-hidden"}`}
            onClick={() => toggleExpand(key)}
            title={isExpanded ? "Click to collapse" : "Click to expand"}
          >
            <pre className="whitespace-pre-wrap">{event.input}</pre>
          </div>
        )}
      </div>
    );
  }

  if (event.kind === "tool_result") {
    if (isMinimal) {
      return (
        <div key={key} data-event-idx={key} className="mb-0.5 ml-3 text-[11px]">
          <span className={event.isError ? "text-red-400" : "text-green-500"}>
            {event.isError ? "✗" : "✓"}
          </span>
          <span className="text-gray-500 ml-1">{event.toolName}</span>
          {!isExpanded && (
            <button
              className="text-gray-600 text-[10px] ml-1 hover:text-gray-400"
              onClick={() => toggleExpand(key)}
            >
              output
            </button>
          )}
          {isExpanded && (
            <>
              <button
                className="text-gray-600 text-[10px] ml-1 hover:text-gray-400"
                onClick={() => toggleExpand(key)}
              >
                hide
              </button>
              <pre className="text-gray-500 text-[10px] mt-0.5 ml-2 max-h-40 overflow-auto whitespace-pre-wrap">{event.output}</pre>
            </>
          )}
        </div>
      );
    }
    const borderColor = event.isError ? "border-red-600" : "border-purple-600";
    const textColor = event.isError ? "text-red-400" : "text-purple-400";
    return (
      <div key={key} data-event-idx={key} className={`mb-1 ml-2 pl-2 border-l-2 ${borderColor}`}>
        <span className={textColor}>{event.isError ? "Error" : "Result"}: {event.toolName}</span>
        <div
          className={`text-gray-500 text-[10px] mt-0.5 cursor-pointer select-none ${isExpanded ? "" : "max-h-5 overflow-hidden"}`}
          onClick={() => toggleExpand(key)}
          title={isExpanded ? "Click to collapse" : "Click to expand"}
        >
          <pre className="whitespace-pre-wrap">{event.output}</pre>
        </div>
      </div>
    );
  }

  if (event.kind === "result") {
    return (
      <div key={key} data-event-idx={key} className="mt-2 pt-2 border-t border-gray-700">
        <div className={event.success ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
          {event.success ? (multiTurn ? "Turn complete" : "Completed") : "Failed"}
          {multiTurn && event.success && <span className="text-gray-400 font-normal"> — waiting for input</span>}
          {event.model && <span className="text-gray-400 font-normal"> ({event.model})</span>}
        </div>
        {event.result && (
          <div className="text-gray-300 mt-1">{event.result}</div>
        )}
        <div className="text-gray-500 text-[10px] mt-1">
          {(event.durationMs / 1000).toFixed(1)}s
          {" | "}Cost: ${event.totalCostUsd.toFixed(4)}
          {" | "}Tokens: {event.inputTokens.toLocaleString()} in / {event.outputTokens.toLocaleString()} out
        </div>
      </div>
    );
  }

  return null;
}
