// Per-event renderer for TerminalView — extracted so the 480-line renderParsedEvent
// (and its sole helper highlightText + the RenderContext it consumes) live apart
// from the component shell. Pure rendering: takes an event + a RenderContext and
// returns JSX; holds no component state.

import type { DisplayEvent } from "../lib/agent-output-parser.js";
import { summarizeToolCall, normalizedSearchQuery, eventSearchText, isSkillRead } from "../lib/terminal-transcript.js";
import type { SubagentGroup } from "../lib/terminal-transcript.js";

export type { SubagentGroup };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RenderContext {
  multiTurn?: boolean;
  expandedSections: Set<number>;
  toggleExpand: (idx: number) => void;
  parseOutput: "minimal" | "false";
  activeSubagentToolUseIds: Set<string>;
  subagentGroups: Map<string, SubagentGroup>;
  eventToSubagent: Map<number, string>;
  isMaximized: boolean;
  searchQuery: string;
}

export function highlightText(text: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return text;

  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let matchIdx = lowerText.indexOf(lowerNeedle);

  while (matchIdx !== -1) {
    if (matchIdx > cursor) parts.push(text.slice(cursor, matchIdx));
    const end = matchIdx + needle.length;
    parts.push(
      <mark key={`${matchIdx}-${end}`} className="rounded bg-yellow-300 px-0.5 text-gray-950">
        {text.slice(matchIdx, end)}
      </mark>,
    );
    cursor = end;
    matchIdx = lowerText.indexOf(lowerNeedle, cursor);
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

// ── Per-kind renderer registry ────────────────────────────────────────────────
// renderParsedEvent was a single 142-CC if-cascade over event.kind. It is now a
// thin dispatch: deriveRenderState() computes the shared view flags once, then a
// typed registry (RENDERERS) routes to one small renderer per DisplayEvent kind.
// The mapped RendererRegistry type makes the table exhaustive: adding a new kind
// to DisplayEvent fails to compile until a renderer is registered here.

type EventOf<K extends DisplayEvent["kind"]> = Extract<DisplayEvent, { kind: K }>;

/** Shared, event-agnostic view flags computed once per event before dispatch. */
export interface DerivedRenderState {
  isExpanded: boolean;
  isMinimal: boolean;
  isInsideSubagent: boolean;
  isSubagentStart: boolean;
  isSubagentEnd: boolean;
}

function deriveRenderState(event: DisplayEvent, key: number, ctx: RenderContext): DerivedRenderState {
  const { expandedSections, parseOutput, subagentGroups, eventToSubagent, searchQuery } = ctx;
  const searchNeedle = normalizedSearchQuery(searchQuery);
  const isSearchMatch = searchNeedle.length > 0 && eventSearchText(event).toLowerCase().includes(searchNeedle);
  const isExpanded = expandedSections.has(key) || isSearchMatch;
  const isMinimal = parseOutput === "minimal";

  // Determine if this event is inside a subagent section (between Agent tool_use and its result)
  const parentSubagentId = eventToSubagent.get(key);
  const isInsideSubagent = parentSubagentId !== undefined;
  const parentGroup = parentSubagentId ? subagentGroups.get(parentSubagentId) : undefined;
  // Is this the opening Agent tool_use event of a subagent group?
  const isSubagentStart = parentGroup?.startIdx === key;
  // Is this the closing tool_result of a subagent group?
  const isSubagentEnd = parentGroup?.endIdx === key && event.kind === "tool_result";
  return { isExpanded, isMinimal, isInsideSubagent, isSubagentStart, isSubagentEnd };
}

function renderRaw(event: EventOf<"raw">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isInsideSubagent, isSubagentStart } = d;
  const { searchQuery } = ctx;
  // Indent raw text inside subagent sections
  const indent = isInsideSubagent && !isSubagentStart ? "ml-6" : "";
  return (
    <div key={key} data-event-idx={key} className={`text-green-400 ${indent}`}>
      {highlightText(event.text, searchQuery)}
    </div>
  );
}

function renderInit(event: EventOf<"init">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isMinimal } = d;
  const { searchQuery } = ctx;
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
        Model: <span className="text-white">{highlightText(event.model, searchQuery)}</span>
        {" | "}CWD: <span className="text-white">{highlightText(event.cwd, searchQuery)}</span>
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

function renderAssistant(event: EventOf<"assistant">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isInsideSubagent, isSubagentStart, isMinimal, isExpanded } = d;
  const { toggleExpand, searchQuery } = ctx;
  // Assistant text inside a subagent is rendered more subtly
  const inSubagent = isInsideSubagent && !isSubagentStart;
  if (isMinimal) {
    const lines = event.text.split("\n");
    const truncated = lines.length > 3 && !isExpanded;
    return (
      <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : ""}`}>
        <div className={`text-[11px] ${inSubagent ? "text-gray-400" : "text-green-300"}`}>
          {highlightText(truncated ? lines.slice(0, 3).join("\n") + "..." : event.text, searchQuery)}
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
      <div className={inSubagent ? "text-gray-400 text-[11px]" : "text-green-300"}>{highlightText(event.text, searchQuery)}</div>
    </div>
  );
}

function renderThinking(event: EventOf<"thinking">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isMinimal, isInsideSubagent, isSubagentStart } = d;
  const { searchQuery } = ctx;
  if (isMinimal) return null;
  const inSubagent = isInsideSubagent && !isSubagentStart;
  return (
    <div key={key} data-event-idx={key} className={`mb-1 text-gray-500 italic text-[11px] ${inSubagent ? "ml-6" : ""}`}>
      Thinking: {highlightText(event.text.length > 200 ? event.text.slice(0, 200) + "..." : event.text, searchQuery)}
    </div>
  );
}

function renderToolUse(event: EventOf<"tool_use">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isMinimal, isExpanded, isInsideSubagent, isSubagentStart } = d;
  const { activeSubagentToolUseIds, toggleExpand, searchQuery } = ctx;
  if (event.name === "Agent") {
    const description = (event.inputParsed?.description as string) || (event.inputParsed?.prompt as string) || "";
    const subagentType = (event.inputParsed?.subagent_type as string) || "";
    const isRunning = event.id ? activeSubagentToolUseIds.has(event.id) : false;

    if (isMinimal) {
      return (
        <div key={key} data-event-idx={key} className="mb-0.5 text-[11px]">
          <div className="flex items-center gap-1 bg-brand-50 dark:bg-brand-900/40 rounded px-1.5 py-0.5">
            {isRunning
              ? <span className="text-brand-600 dark:text-brand-400 animate-pulse">⟳</span>
              : <span className="text-brand-600 dark:text-brand-400">⇢</span>}
            <span className="text-brand-700 dark:text-brand-300 font-medium">Subagent</span>
            <span className="text-gray-300">{highlightText(description.slice(0, 80) || "delegating to agent", searchQuery)}</span>
            {subagentType && <span className="text-gray-500 ml-1">({subagentType})</span>}
            {isRunning && <span className="text-brand-600 dark:text-brand-400 text-[10px] animate-pulse">running</span>}
          </div>
        </div>
      );
    }
    return (
      <div key={key} data-event-idx={key} className="mb-1">
        <div className={`flex items-center gap-1.5 rounded px-2 py-1 ${isRunning ? "bg-brand-50 dark:bg-brand-900/40 border border-brand-200 dark:border-brand-700" : "bg-brand-50 dark:bg-brand-900/30 border border-brand-200 dark:border-brand-700"}`}>
          {isRunning
            ? <span className="text-brand-600 dark:text-brand-400 animate-pulse">⟳</span>
            : <span className="text-brand-600 dark:text-brand-400">⇢</span>}
          <span className="text-brand-700 dark:text-brand-300 font-semibold text-xs">
            {isRunning ? "Subagent running" : "Subagent"}
          </span>
          {subagentType && <span className="text-brand-600 dark:text-brand-400 text-[10px] bg-brand-100 dark:bg-brand-800/40 px-1 rounded">{subagentType}</span>}
          <span className="text-gray-300 text-[11px] ml-1">{highlightText(description, searchQuery)}</span>
        </div>
      </div>
    );
  }
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
        <span className="text-gray-300">{highlightText(summary, searchQuery)}</span>
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
          <span className="text-gray-300 text-[11px]">{highlightText(subject, searchQuery)}</span>
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
          <span className={`text-[11px] ${s === "completed" ? "text-gray-500 line-through" : "text-gray-300"}`}>{highlightText(subject, searchQuery)}</span>
        </div>
      );
    }
    // TaskList, TaskGet, TaskStop — fall through to generic tool_use
  }

  if (isMinimal) {
    const skillName = isSkillRead(event.name, event.inputParsed || {});
    if (skillName) {
      return (
        <div key={key} data-event-idx={key} className={`mb-1 text-[11px] ${inSubagent ? "ml-6" : "ml-1"} flex items-center gap-1.5`}>
          <span className="text-brand-600 dark:text-brand-400">⚡</span>
          <span className="text-brand-700 dark:text-brand-300 font-medium">Skill: {highlightText(skillName, searchQuery)}</span>
        </div>
      );
    }
    const summary = summarizeToolCall(event.name, event.inputParsed || {});
    return (
      <div key={key} data-event-idx={key} className={`mb-0.5 text-[11px] ${inSubagent ? "ml-6" : "ml-1"}`}>
        <span className="text-yellow-500">{highlightText(summary, searchQuery)}</span>
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
            <pre className="text-gray-500 text-[10px] mt-0.5 ml-2 whitespace-pre-wrap">{highlightText(event.input, searchQuery)}</pre>
          </>
        )}
      </div>
    );
  }
  return (
    <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : "ml-2"} pl-2 border-l-2 ${inSubagent ? "border-gray-700" : "border-yellow-600"}`}>
      <span className={inSubagent ? "text-gray-500 text-[11px]" : "text-yellow-400"}>Tool: {highlightText(event.name, searchQuery)}</span>
      {event.input && (
        <div
          className={`text-gray-500 text-[10px] mt-0.5 cursor-pointer select-none ${isExpanded ? "" : "max-h-5 overflow-hidden"}`}
          onClick={() => toggleExpand(key)}
          title={isExpanded ? "Click to collapse" : "Click to expand"}
        >
          <pre className="whitespace-pre-wrap">{highlightText(event.input, searchQuery)}</pre>
        </div>
      )}
    </div>
  );
}

function renderAgentToolResult(event: EventOf<"tool_result">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isExpanded, isMinimal } = d;
  const { isMaximized, toggleExpand, searchQuery } = ctx;
  // Summarize the output — try to extract meaningful text
  let summary = "";
  try {
    const parsed: unknown = JSON.parse(event.output);
    // Claude subagent results often have a "result" field
    if (typeof parsed === "string") {
      summary = parsed;
    } else if (isRecord(parsed) && parsed.result) {
      summary = String(parsed.result);
    } else if (isRecord(parsed) && parsed.message) {
      summary = String(parsed.message);
    } else if (Array.isArray(parsed)) {
      // Might be content blocks
      const textParts = parsed
        .filter(isRecord)
        .filter((b) => b.type === "text")
        .map((b) => b.text as string);
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
          {highlightText(truncated ? summary.slice(0, 300) + "..." : summary, searchQuery)}
          {truncated && <span className="text-gray-600 text-[10px] ml-1">click for full output</span>}
          {isExpanded && !truncated && (
            <pre className={`text-gray-500 text-[10px] mt-0.5 whitespace-pre-wrap ${isMaximized ? "" : "max-h-60 overflow-auto"}`}>{highlightText(event.output, searchQuery)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function renderToolResult(event: EventOf<"tool_result">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isExpanded, isMinimal, isInsideSubagent, isSubagentStart, isSubagentEnd } = d;
  const { isMaximized, toggleExpand, searchQuery } = ctx;
  const inSubagent = isInsideSubagent && !isSubagentStart && !isSubagentEnd;

  // Agent tool_result: show as subagent completion, not raw output
  // Agent tool_result: subagent completion summary — its own renderer.
    if (event.toolName === "Agent") return renderAgentToolResult(event, key, ctx, d);

  // Non-Agent tool_result
  if (isMinimal) {
    return (
      <div key={key} data-event-idx={key} className={`mb-0.5 text-[11px] ${inSubagent ? "ml-6" : "ml-3"}`}>
        <span className={event.isError ? "text-red-400" : "text-green-500"}>
          {event.isError ? "✗" : "✓"}
        </span>
        <span className="text-gray-500 ml-1">{highlightText(event.toolName, searchQuery)}</span>
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
            <pre className={`text-gray-500 text-[10px] mt-0.5 ml-2 whitespace-pre-wrap ${isMaximized ? "" : "max-h-40 overflow-auto"}`}>{highlightText(event.output, searchQuery)}</pre>
          </>
        )}
      </div>
    );
  }
  const borderColor = event.isError ? "border-red-600" : inSubagent ? "border-gray-700" : "border-brand-500";
  const textColor = event.isError ? "text-red-400" : inSubagent ? "text-gray-500" : "text-brand-600 dark:text-brand-400";
  return (
    <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : "ml-2"} pl-2 border-l-2 ${borderColor}`}>
      <span className={textColor}>{event.isError ? "Error" : "Result"}: {highlightText(event.toolName, searchQuery)}</span>
      <div
        className={`text-gray-500 text-[10px] mt-0.5 cursor-pointer select-none ${isExpanded ? "" : "max-h-5 overflow-hidden"}`}
        onClick={() => toggleExpand(key)}
        title={isExpanded ? "Click to collapse" : "Click to expand"}
      >
        <pre className="whitespace-pre-wrap">{highlightText(event.output, searchQuery)}</pre>
      </div>
      {event.images && event.images.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {event.images.map((img, i) => (
            <img
              key={i}
              src={`data:${img.mediaType};base64,${img.data}`}
              alt={`Tool result image ${i + 1}`}
              className="max-w-full max-h-96 rounded border border-gray-600 object-contain"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function renderImage(event: EventOf<"image">, key: number, _ctx: RenderContext, _d: DerivedRenderState): React.ReactNode {
  return (
    <div key={key} data-event-idx={key} className="mb-1 ml-2">
      <img
        src={`data:${event.mediaType};base64,${event.data}`}
        alt="Image from agent"
        className="max-w-full max-h-96 rounded border border-gray-600 object-contain"
      />
    </div>
  );
}

function renderResult(event: EventOf<"result">, key: number, ctx: RenderContext, _d: DerivedRenderState): React.ReactNode {
  const { multiTurn, searchQuery } = ctx;
  return (
    <div key={key} data-event-idx={key} className="mt-2 pt-2 border-t border-gray-700">
      <div className={event.success ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
        {event.success ? (multiTurn ? "Turn complete" : "Completed") : "Failed"}
        {multiTurn && event.success && <span className="text-gray-400 font-normal"> — waiting for input</span>}
        {event.model && <span className="text-gray-400 font-normal"> ({event.model})</span>}
      </div>
      {event.result && (
        <div className="text-gray-300 mt-1">{highlightText(event.result, searchQuery)}</div>
      )}
      <div className="text-gray-500 text-[10px] mt-1">
        {(event.durationMs / 1000).toFixed(1)}s
        {" | "}Cost: ${event.totalCostUsd.toFixed(4)}
        {" | "}Tokens: {event.inputTokens.toLocaleString('en-US')} in / {event.outputTokens.toLocaleString('en-US')} out
      </div>
    </div>
  );
}

function renderTaskStarted(event: EventOf<"task_started">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isMinimal } = d;
  const { activeSubagentToolUseIds, searchQuery } = ctx;
  const isRunning = event.toolUseId ? activeSubagentToolUseIds.has(event.toolUseId) : false;
  if (isMinimal) {
    return (
      <div key={key} data-event-idx={key} className="mb-0.5 ml-1 text-[11px] flex items-center gap-1">
        {isRunning
          ? <span className="text-blue-400 animate-pulse">⟳</span>
          : <span className="text-green-500">✓</span>}
        <span className={isRunning ? "text-blue-300" : "text-gray-400"}>{highlightText(event.description, searchQuery)}</span>
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
        {highlightText(event.description, searchQuery)}
      </span>
      {isRunning && <span className="text-blue-500 text-[10px] animate-pulse">running</span>}
      {event.taskType && !isRunning && <span className="text-gray-600 text-[10px] ml-1">{event.taskType}</span>}
    </div>
  );
}

function renderRateLimit(event: EventOf<"rate_limit">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isMinimal, isInsideSubagent, isSubagentStart } = d;
  const { searchQuery } = ctx;
  const inSubagent = isInsideSubagent && !isSubagentStart;
  const resetsAt = event.resetsAt ? new Date(event.resetsAt * 1000).toLocaleTimeString('en-US') : null;
  const overageRejected = event.overageStatus === "rejected";
  if (isMinimal) {
    return (
      <div key={key} data-event-idx={key} className={`mb-0.5 text-[11px] ${inSubagent ? "ml-6" : "ml-1"}`}>
        <span className="text-yellow-500">Rate limit ({highlightText(event.rateLimitType, searchQuery)}): {highlightText(event.status, searchQuery)}</span>
        {overageRejected && <span className="text-orange-400"> — overage rejected</span>}
        {resetsAt && <span className="text-gray-500"> — resets {resetsAt}</span>}
      </div>
    );
  }
  return (
    <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : "ml-2"} pl-2 border-l-2 border-yellow-600`}>
      <span className="text-yellow-400">Rate limit: {highlightText(event.status, searchQuery)}</span>
      <div className="text-gray-500 text-[10px]">
        {event.rateLimitType}{overageRejected ? " | overage rejected" : ""}{resetsAt ? ` | resets ${resetsAt}` : ""}
      </div>
    </div>
  );
}

function renderNotification(event: EventOf<"notification">, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isMinimal, isInsideSubagent, isSubagentStart } = d;
  const { searchQuery } = ctx;
  const inSubagent = isInsideSubagent && !isSubagentStart;
  const isUserMsg = event.key === "user";
  if (isMinimal) {
    return (
      <div key={key} data-event-idx={key} className={`mb-0.5 text-[11px] ${inSubagent ? "ml-6" : "ml-1"}`}>
        {isUserMsg
          ? <><span className="text-blue-400">User: </span><span className="text-gray-300">{highlightText(event.text, searchQuery)}</span></>
          : <><span className="text-orange-400">Note: </span><span className="text-gray-400">{highlightText(event.text, searchQuery)}</span></>}
      </div>
    );
  }
  return (
    <div key={key} data-event-idx={key} className={`mb-1 ${inSubagent ? "ml-6" : "ml-2"} pl-2 ${isUserMsg ? "border-l-2 border-blue-600" : "border-l-2 border-orange-600"}`}>
      {isUserMsg
        ? <span className="text-blue-400">User: <span className="text-gray-300">{highlightText(event.text, searchQuery)}</span></span>
        : <span className="text-orange-400">Notification: {highlightText(event.text, searchQuery)}</span>}
      {!isUserMsg && <div className="text-gray-600 text-[10px]">{event.key} | {event.priority}</div>}
    </div>
  );
}

type KindRenderer<K extends DisplayEvent["kind"]> = (
  event: EventOf<K>,
  key: number,
  ctx: RenderContext,
  d: DerivedRenderState,
) => React.ReactNode;
type RendererRegistry = { [K in DisplayEvent["kind"]]: KindRenderer<K> };

const RENDERERS: RendererRegistry = {
  raw: renderRaw,
  init: renderInit,
  assistant: renderAssistant,
  thinking: renderThinking,
  tool_use: renderToolUse,
  tool_result: renderToolResult,
  image: renderImage,
  result: renderResult,
  task_started: renderTaskStarted,
  rate_limit: renderRateLimit,
  notification: renderNotification,
};

export function renderParsedEvent(event: DisplayEvent, key: number, ctx: RenderContext): React.ReactNode {
  const d = deriveRenderState(event, key, ctx);
  const renderer = RENDERERS[event.kind] as KindRenderer<DisplayEvent["kind"]>;
  return renderer(event, key, ctx, d);
}
