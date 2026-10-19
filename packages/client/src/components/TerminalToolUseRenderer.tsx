// tool_use rendering for TerminalEventRenderer, split out to keep each file's
// declaration count and renderToolUse's branch count under the code-health soft caps.

import type { DisplayEvent } from "../lib/agent-output-parser.js";
import { summarizeToolCall, isSkillRead } from "../lib/terminal-transcript.js";
import { highlightText } from "./TerminalRenderShared.js";
import type { RenderContext, DerivedRenderState } from "./TerminalRenderShared.js";

type ToolUseEvent = Extract<DisplayEvent, { kind: "tool_use" }>;

const TASK_TOOL_NAMES = ["TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop"];

const TASK_STATUS_STYLE: Record<string, { icon: string; color: string }> = {
  completed: { icon: "✓", color: "text-green-400" },
  in_progress: { icon: "●", color: "text-yellow-400" },
  pending: { icon: "○", color: "text-gray-400" },
  deleted: { icon: "✗", color: "text-red-400" },
};
const TASK_STATUS_DEFAULT = { icon: "○", color: "text-gray-400" };

function renderAgentToolUse(event: ToolUseEvent, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isMinimal } = d;
  const { activeSubagentToolUseIds, searchQuery } = ctx;
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

function minimalTaskIcon(event: ToolUseEvent): { icon: string; color: string } {
  if (event.name === "TaskCreate") return { icon: "○", color: "text-blue-400" };
  if (event.name === "TaskList") return { icon: "☰", color: "text-gray-400" };
  if (event.name !== "TaskUpdate") return { icon: "·", color: "text-gray-400" };
  return TASK_STATUS_STYLE[(event.inputParsed || {}).status as string] ?? TASK_STATUS_DEFAULT;
}

function renderMinimalTaskToolUse(event: ToolUseEvent, key: number, ctx: RenderContext, inSubagent: boolean): React.ReactNode {
  const summary = summarizeToolCall(event.name, event.inputParsed || {});
  const { icon, color } = minimalTaskIcon(event);
  return (
    <div key={key} data-event-idx={key} className={`mb-0.5 text-[11px] ${inSubagent ? "ml-6" : "ml-1"}`}>
      <span className={color}>{icon} </span>
      <span className="text-gray-300">{highlightText(summary, ctx.searchQuery)}</span>
    </div>
  );
}

function renderFullTaskToolUse(event: ToolUseEvent, key: number, ctx: RenderContext, inSubagent: boolean): React.ReactNode {
  const input = event.inputParsed || {};
  const { searchQuery } = ctx;
  if (event.name === "TaskCreate") {
    const subject = (input.subject as string) || "";
    const activeForm = input.activeForm as string | undefined;
    return (
      <div key={key} data-event-idx={key} className={`mb-0.5 ${inSubagent ? "ml-6" : "ml-2"} pl-2`}>
        <span className="text-gray-500 text-[11px]">○ </span>
        <span className="text-gray-300 text-[11px]">{highlightText(subject, searchQuery)}</span>
        {activeForm ? <span className="text-blue-400 text-[10px] ml-1">— {activeForm}</span> : null}
      </div>
    );
  }
  if (event.name === "TaskUpdate") {
    const s = input.status as string;
    const subject = (input.subject as string) || "task";
    const { icon: statusIcon, color: statusColor } = TASK_STATUS_STYLE[s] ?? TASK_STATUS_DEFAULT;
    return (
      <div key={key} data-event-idx={key} className={`mb-0.5 ${inSubagent ? "ml-6" : "ml-2"} pl-2`}>
        <span className={statusColor}>{statusIcon} </span>
        <span className={`text-[11px] ${s === "completed" ? "text-gray-500 line-through" : "text-gray-300"}`}>{highlightText(subject, searchQuery)}</span>
      </div>
    );
  }
  // TaskList, TaskGet, TaskStop — fall through to generic tool_use
  return null;
}

function renderMinimalToolUse(event: ToolUseEvent, key: number, ctx: RenderContext, d: DerivedRenderState, inSubagent: boolean): React.ReactNode {
  const { isExpanded } = d;
  const { toggleExpand, searchQuery } = ctx;
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

export function renderToolUse(event: ToolUseEvent, key: number, ctx: RenderContext, d: DerivedRenderState): React.ReactNode {
  const { isMinimal, isExpanded, isInsideSubagent, isSubagentStart } = d;
  const { toggleExpand, searchQuery } = ctx;
  if (event.name === "Agent") return renderAgentToolUse(event, key, ctx, d);
  const inSubagent = isInsideSubagent && !isSubagentStart;

  if (TASK_TOOL_NAMES.includes(event.name)) {
    const taskNode = isMinimal
      ? renderMinimalTaskToolUse(event, key, ctx, inSubagent)
      : renderFullTaskToolUse(event, key, ctx, inSubagent);
    if (taskNode) return taskNode;
  }

  if (isMinimal) return renderMinimalToolUse(event, key, ctx, d, inSubagent);
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
