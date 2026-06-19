import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatToolLabel, type ButlerChatMessage as ChatMessage, type ButlerToolCall as ToolCall } from "../lib/butler-event-reducer.js";
import { toolHint, formatRelativeTs } from "../lib/butler-format.js";

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

/** Renders one chat message (user / assistant-markdown / tool-call / activity line). */
export function ChatBubble({ msg }: { msg: ChatMessage }) {
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
