import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { createAgentOutputParser, type DisplayEvent } from "../lib/agent-output-parser.js";

interface TerminalViewProps {
  messages: AgentOutputMessage[];
  connectionState: "connecting" | "open" | "closed" | "error";
  parseOutput?: "true" | "false" | "minimal";
  prompt?: string;
  title?: string;
  footer?: ReactNode;
  multiTurn?: boolean;
}

interface SubagentGroup {
  startIdx: number;
  endIdx: number;
  description: string;
  subagentType: string;
}

interface RenderContext {
  multiTurn?: boolean;
  expandedSections: Set<number>;
  toggleExpand: (idx: number) => void;
  parseOutput: "true" | "false" | "minimal";
  activeSubagentToolUseIds: Set<string>;
  subagentGroups: Map<string, SubagentGroup>;
  eventToSubagent: Map<number, string>;
  isMaximized: boolean;
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
      return `Subagent: ${(input.description as string) || "delegating to agent"}`;
    case "WebSearch":
      return "Searching web";
    case "WebFetch":
    case "mcp__web_reader__webReader":
      return "Fetching URL";
    case "TaskCreate":
      return `Task: ${(input.subject as string) || "new task"}`;
    case "TaskUpdate": {
      const status = input.status as string;
      const subject = input.subject as string;
      if (status === "completed") return `Done: ${subject || "task"}`;
      if (status === "in_progress") return `Starting: ${subject || "task"}`;
      if (status === "deleted") return `Removed: ${subject || "task"}`;
      return `Task update: ${subject || "task"}`;
    }
    case "TaskList":
      return "Listing tasks";
    case "TaskGet":
      return "Getting task details";
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

    const parser = createAgentOutputParser("claude-stream-json");
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

  const isParsed = parseOutput !== "false" && displayEvents.some((e) => e.kind !== "raw");

  const toggleMaximize = () => setIsMaximized((v) => !v);

  // Compute which subagent tool_use_ids are still active (started but no result yet)
  // Uses proper ID matching: task_started.toolUseId → Agent tool_use.id → tool_result.toolUseId
  const activeSubagentToolUseIds = (() => {
    const startedIds = new Set<string>();
    const completedIds = new Set<string>();
    for (const ev of displayEvents) {
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

    for (let i = 0; i < displayEvents.length; i++) {
      const ev = displayEvents[i];
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
        endIdx: displayEvents.length - 1,
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
        case "tool_use": color = (event.kind === "tool_use" && event.name === "Agent") ? "bg-purple-500" : "bg-yellow-500"; break;
        case "tool_result": color = event.isError ? "bg-red-500" : "bg-purple-500"; break;
        case "result": color = event.success ? "bg-emerald-400" : "bg-red-400"; break;
        case "init": color = "bg-cyan-400"; break;
        case "task_started": color = "bg-blue-500"; break;
        case "notification": color = "bg-orange-500"; break;
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
  const { multiTurn, expandedSections, toggleExpand, parseOutput, activeSubagentToolUseIds, subagentGroups, eventToSubagent, isMaximized } = ctx;
  const isExpanded = expandedSections.has(key);
  const isMinimal = parseOutput === "minimal";

  // Determine if this event is inside a subagent section (between Agent tool_use and its result)
  const parentSubagentId = eventToSubagent.get(key);
  const isInsideSubagent = parentSubagentId !== undefined;
  const parentGroup = parentSubagentId ? subagentGroups.get(parentSubagentId) : undefined;
  // Is this the opening Agent tool_use event of a subagent group?
  const isSubagentStart = parentGroup?.startIdx === key;
  // Is this the closing tool_result of a subagent group?
  const isSubagentEnd = parentGroup?.endIdx === key && event.kind === "tool_result";

  if (event.kind === "raw") {
    // Indent raw text inside subagent sections
    const indent = isInsideSubagent && !isSubagentStart ? "ml-6" : "";
    return (
      <div key={key} data-event-idx={key} className={`text-green-400 ${indent}`}>
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
    // Assistant text inside a subagent is rendered more subtly
    const inSubagent = isInsideSubagent && !isSubagentStart;
    if (isMinimal) {
      const lines = event.text.split("\n");
      const truncated = lines.length > 3 && !isExpanded;
      return (
        <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : ""}`}>
          <div className={`text-[11px] ${inSubagent ? "text-gray-400" : "text-green-300"}`}>
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
      <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : ""}`}>
        {event.model && !inSubagent && (
          <span className="text-blue-400 text-[10px]">[{event.model}]</span>
        )}
        <div className={inSubagent ? "text-gray-400 text-[11px]" : "text-green-300"}>{event.text}</div>
      </div>
    );
  }

  if (event.kind === "thinking") {
    if (isMinimal) return null;
    const inSubagent = isInsideSubagent && !isSubagentStart;
    return (
      <div key={key} data-event-idx={key} className={`mb-1 text-gray-500 italic text-[11px] ${inSubagent ? "ml-6" : ""}`}>
        Thinking: {event.text.length > 200 ? event.text.slice(0, 200) + "..." : event.text}
      </div>
    );
  }

  if (event.kind === "tool_use" && event.name === "Agent") {
    const description = (event.inputParsed?.description as string) || (event.inputParsed?.prompt as string) || "";
    const subagentType = (event.inputParsed?.subagent_type as string) || "";
    const isRunning = event.id ? activeSubagentToolUseIds.has(event.id) : false;

    if (isMinimal) {
      return (
        <div key={key} data-event-idx={key} className="mb-0.5 text-[11px]">
          <div className="flex items-center gap-1 bg-purple-900/20 rounded px-1.5 py-0.5">
            {isRunning
              ? <span className="text-purple-400 animate-pulse">⟳</span>
              : <span className="text-purple-400">⇢</span>}
            <span className="text-purple-300 font-medium">Subagent</span>
            <span className="text-gray-300">{description.slice(0, 80) || "delegating to agent"}</span>
            {subagentType && <span className="text-gray-500 ml-1">({subagentType})</span>}
            {isRunning && <span className="text-purple-500 text-[10px] animate-pulse">running</span>}
          </div>
        </div>
      );
    }
    return (
      <div key={key} data-event-idx={key} className="mb-1">
        <div className={`flex items-center gap-1.5 rounded px-2 py-1 ${isRunning ? "bg-purple-900/30 border border-purple-700" : "bg-purple-900/15 border border-purple-800"}`}>
          {isRunning
            ? <span className="text-purple-400 animate-pulse">⟳</span>
            : <span className="text-purple-400">⇢</span>}
          <span className="text-purple-300 font-semibold text-xs">
            {isRunning ? "Subagent running" : "Subagent"}
          </span>
          {subagentType && <span className="text-purple-400 text-[10px] bg-purple-800/40 px-1 rounded">{subagentType}</span>}
          <span className="text-gray-300 text-[11px] ml-1">{description}</span>
        </div>
      </div>
    );
  }

  if (event.kind === "tool_use") {
    const isTaskTool = ["TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop"].includes(event.name);
    const inSubagent = isInsideSubagent && !isSubagentStart;

    if (isTaskTool && isMinimal) {
      const summary = summarizeToolCall(event.name, event.inputParsed || {});
      const input = event.inputParsed || {};
      let icon = "";
      let color = "text-gray-400";
      if (event.name === "TaskCreate") { icon = "○"; color = "text-blue-400"; }
      else if (event.name === "TaskUpdate") {
        const s = input.status as string;
        if (s === "completed") { icon = "✓"; color = "text-green-400"; }
        else if (s === "in_progress") { icon = "●"; color = "text-yellow-400"; }
        else if (s === "deleted") { icon = "✗"; color = "text-red-400"; }
        else { icon = "○"; color = "text-gray-400"; }
      }
      else if (event.name === "TaskList") { icon = "☰"; color = "text-gray-400"; }
      else { icon = "·"; color = "text-gray-400"; }

      return (
        <div key={key} data-event-idx={key} className={`mb-0.5 text-[11px] ${inSubagent ? "ml-6" : "ml-1"}`}>
          <span className={color}>{icon} </span>
          <span className="text-gray-300">{summary}</span>
        </div>
      );
    }

    if (isTaskTool && !isMinimal) {
      const input = event.inputParsed || {};
      if (event.name === "TaskCreate") {
        const subject = (input.subject as string) || "";
        return (
          <div key={key} data-event-idx={key} className={`mb-0.5 ${inSubagent ? "ml-6" : "ml-2"} pl-2`}>
            <span className="text-gray-500 text-[11px]">○ </span>
            <span className="text-gray-300 text-[11px]">{subject}</span>
            {input.activeForm ? <span className="text-blue-400 text-[10px] ml-1">— {String(input.activeForm)}</span> : null}
          </div>
        );
      }
      if (event.name === "TaskUpdate") {
        const s = input.status as string;
        const subject = (input.subject as string) || "task";
        let statusIcon = "○";
        let statusColor = "text-gray-400";
        if (s === "completed") { statusIcon = "✓"; statusColor = "text-green-400"; }
        else if (s === "in_progress") { statusIcon = "●"; statusColor = "text-yellow-400"; }
        else if (s === "pending") { statusIcon = "○"; statusColor = "text-gray-400"; }
        else if (s === "deleted") { statusIcon = "✗"; statusColor = "text-red-400"; }
        return (
          <div key={key} data-event-idx={key} className={`mb-0.5 ${inSubagent ? "ml-6" : "ml-2"} pl-2`}>
            <span className={statusColor}>{statusIcon} </span>
            <span className={`text-[11px] ${s === "completed" ? "text-gray-500 line-through" : "text-gray-300"}`}>{subject}</span>
          </div>
        );
      }
      // TaskList, TaskGet, TaskStop — fall through to generic tool_use
    }

    if (isMinimal) {
      const summary = summarizeToolCall(event.name, event.inputParsed || {});
      return (
        <div key={key} data-event-idx={key} className={`mb-0.5 text-[11px] ${inSubagent ? "ml-6" : "ml-1"}`}>
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
      <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : "ml-2"} pl-2 border-l-2 ${inSubagent ? "border-gray-700" : "border-yellow-600"}`}>
        <span className={inSubagent ? "text-gray-500 text-[11px]" : "text-yellow-400"}>Tool: {event.name}</span>
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
    const isAgentResult = event.toolName === "Agent";
    const inSubagent = isInsideSubagent && !isSubagentStart && !isSubagentEnd;

    // Agent tool_result: show as subagent completion, not raw output
    if (isAgentResult) {
      // Summarize the output — try to extract meaningful text
      let summary = "";
      try {
        const parsed = JSON.parse(event.output);
        // Claude subagent results often have a "result" field
        if (typeof parsed === "string") {
          summary = parsed;
        } else if (parsed?.result) {
          summary = String(parsed.result);
        } else if (parsed?.message) {
          summary = String(parsed.message);
        } else if (Array.isArray(parsed)) {
          // Might be content blocks
          const textParts = parsed
            .filter((b: Record<string, unknown>) => b.type === "text")
            .map((b: Record<string, unknown>) => b.text as string);
          if (textParts.length > 0) summary = textParts.join("\n");
        }
      } catch {
        summary = event.output;
      }

      // Truncate long summaries
      const truncated = summary.length > 300 && !isExpanded;

      if (isMinimal) {
        return (
          <div key={key} data-event-idx={key} className="mb-0.5 text-[11px]">
            <span className={event.isError ? "text-red-400" : "text-green-500"}>
              {event.isError ? "✗" : "✓"}
            </span>
            <span className="text-gray-400 ml-1">Subagent {event.isError ? "failed" : "completed"}</span>
            {!event.isError && summary && (
              <span className="text-gray-500 ml-1">— {truncated ? summary.slice(0, 100) + "..." : summary.slice(0, 200)}</span>
            )}
          </div>
        );
      }
      return (
        <div key={key} data-event-idx={key} className="mb-1">
          <div className={`flex items-center gap-1.5 rounded px-2 py-1 ${event.isError ? "bg-red-900/20 border border-red-800" : "bg-green-900/15 border border-green-800"}`}>
            <span className={event.isError ? "text-red-400" : "text-green-400"}>
              {event.isError ? "✗" : "✓"}
            </span>
            <span className={`font-medium text-xs ${event.isError ? "text-red-300" : "text-green-300"}`}>
              Subagent {event.isError ? "failed" : "completed"}
            </span>
          </div>
          {summary && (
            <div
              className="text-gray-400 text-[11px] mt-0.5 ml-2 cursor-pointer select-none"
              onClick={() => toggleExpand(key)}
            >
              {truncated ? summary.slice(0, 300) + "..." : summary}
              {truncated && <span className="text-gray-600 text-[10px] ml-1">click for full output</span>}
              {isExpanded && !truncated && (
                <pre className={`text-gray-500 text-[10px] mt-0.5 whitespace-pre-wrap ${isMaximized ? "" : "max-h-60 overflow-auto"}`}>{event.output}</pre>
              )}
            </div>
          )}
        </div>
      );
    }

    // Non-Agent tool_result
    if (isMinimal) {
      return (
        <div key={key} data-event-idx={key} className={`mb-0.5 text-[11px] ${inSubagent ? "ml-6" : "ml-3"}`}>
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
              <pre className={`text-gray-500 text-[10px] mt-0.5 ml-2 whitespace-pre-wrap ${isMaximized ? "" : "max-h-40 overflow-auto"}`}>{event.output}</pre>
            </>
          )}
        </div>
      );
    }
    const borderColor = event.isError ? "border-red-600" : inSubagent ? "border-gray-700" : "border-purple-600";
    const textColor = event.isError ? "text-red-400" : inSubagent ? "text-gray-500" : "text-purple-400";
    return (
      <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : "ml-2"} pl-2 border-l-2 ${borderColor}`}>
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

  if (event.kind === "task_started") {
    const isRunning = event.toolUseId ? activeSubagentToolUseIds.has(event.toolUseId) : false;
    if (isMinimal) {
      return (
        <div key={key} data-event-idx={key} className="mb-0.5 ml-1 text-[11px] flex items-center gap-1">
          {isRunning
            ? <span className="text-blue-400 animate-pulse">⟳</span>
            : <span className="text-green-500">✓</span>}
          <span className={isRunning ? "text-blue-300" : "text-gray-400"}>{event.description}</span>
          {isRunning && <span className="text-blue-500 text-[10px]">running</span>}
        </div>
      );
    }
    return (
      <div key={key} data-event-idx={key} className={`mb-0.5 ml-2 pl-2 flex items-center gap-1 ${isRunning ? "border-l-2 border-blue-500" : ""}`}>
        {isRunning
          ? <span className="text-blue-400 animate-pulse text-[11px]">⟳</span>
          : <span className="text-green-500 text-[11px]">✓</span>}
        <span className={`text-[11px] ${isRunning ? "text-blue-300" : "text-gray-500"}`}>
          {event.description}
        </span>
        {isRunning && <span className="text-blue-500 text-[10px] animate-pulse">running</span>}
        {event.taskType && !isRunning && <span className="text-gray-600 text-[10px] ml-1">{event.taskType}</span>}
      </div>
    );
  }

  if (event.kind === "notification") {
    const inSubagent = isInsideSubagent && !isSubagentStart;
    if (isMinimal) {
      return (
        <div key={key} data-event-idx={key} className={`mb-0.5 text-[11px] ${inSubagent ? "ml-6" : "ml-1"}`}>
          <span className="text-orange-400">Note: </span>
          <span className="text-gray-400">{event.text}</span>
        </div>
      );
    }
    return (
      <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : "ml-2"} pl-2 border-l-2 border-orange-600`}>
        <span className="text-orange-400">Notification: {event.text}</span>
        <div className="text-gray-600 text-[10px]">{event.key} | {event.priority}</div>
      </div>
    );
  }

  return null;
}
