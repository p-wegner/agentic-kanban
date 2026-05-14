import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { ClaudeOutputParser, type DisplayEvent } from "../lib/claude-output-parser.js";

interface TerminalViewProps {
  messages: AgentOutputMessage[];
  connectionState: "connecting" | "open" | "closed" | "error";
  parseOutput?: boolean;
  prompt?: string;
  title?: string;
  footer?: ReactNode;
}

export function TerminalView({ messages, connectionState, parseOutput = true, prompt, title, footer }: TerminalViewProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const parserRef = useRef(new ClaudeOutputParser());
  const [displayEvents, setDisplayEvents] = useState<DisplayEvent[]>([]);

  // Re-parse all messages when they change or parseOutput toggles
  useEffect(() => {
    if (!parseOutput) {
      // Raw mode: just use raw text
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

    // Parse mode: accumulate and parse stream-json
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

    // Flush remaining buffer
    events.push(...parser.flush());
    setDisplayEvents(events);
  }, [messages, parseOutput]);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [displayEvents]);

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

  const isParsed = parseOutput && displayEvents.some((e) => e.kind !== "raw");

  const toggleMaximize = () => setIsMaximized((v) => !v);

  const content = (
    <>
      {prompt && (
        <div className="mb-2 pb-2 border-b border-gray-700">
          <span className="text-blue-400">&gt; </span>
          <span className="text-gray-200">{prompt}</span>
        </div>
      )}
      {isParsed
        ? displayEvents.map((event, i) => renderParsedEvent(event, i))
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

  if (isMaximized) {
    return (
      <div className="fixed inset-0 z-[55] bg-gray-950 flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-700">
          <span className={`w-2 h-2 rounded-full ${statusColors[connectionState]}`} />
          <span className="text-sm text-gray-300">{title ?? "Agent Output"}</span>
          {isParsed && <span className="text-xs text-blue-400">stream-json</span>}
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
        <pre
          ref={preRef}
          className="flex-1 overflow-auto p-4 text-xs text-green-400 font-mono whitespace-pre-wrap"
        >
          {content}
        </pre>
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
            <span className="text-xs text-blue-400 ml-auto">stream-json</span>
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
        <pre
          ref={preRef}
          className="flex-1 overflow-auto p-3 text-xs text-green-400 font-mono whitespace-pre-wrap"
        >
          {content}
        </pre>
      </div>
      {footer}
    </>
  );
}

function renderParsedEvent(event: DisplayEvent, key: number): React.ReactNode {
  if (event.kind === "raw") {
    return (
      <div key={key} className="text-green-400">
        {event.text}
      </div>
    );
  }

  if (event.kind === "init") {
    return (
      <div key={key} className="mb-2 pb-2 border-b border-gray-700">
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
    return (
      <div key={key} className="mb-1">
        {event.model && (
          <span className="text-blue-400 text-[10px]">[{event.model}]</span>
        )}
        <div className="text-green-300">{event.text}</div>
      </div>
    );
  }

  if (event.kind === "thinking") {
    return (
      <div key={key} className="mb-1 text-gray-500 italic text-[11px]">
        Thinking: {event.text.length > 200 ? event.text.slice(0, 200) + "..." : event.text}
      </div>
    );
  }

  if (event.kind === "tool_use") {
    return (
      <div key={key} className="mb-1 ml-2 pl-2 border-l-2 border-yellow-600">
        <span className="text-yellow-400">Tool: {event.name}</span>
        {event.input && (
          <pre className="text-gray-500 text-[10px] mt-0.5 max-h-20 overflow-hidden">{event.input}</pre>
        )}
      </div>
    );
  }

  if (event.kind === "tool_result") {
    const borderColor = event.isError ? "border-red-600" : "border-purple-600";
    const textColor = event.isError ? "text-red-400" : "text-purple-400";
    return (
      <div key={key} className={`mb-1 ml-2 pl-2 border-l-2 ${borderColor}`}>
        <span className={textColor}>{event.isError ? "Error" : "Result"}: {event.toolName}</span>
        <pre className="text-gray-500 text-[10px] mt-0.5 max-h-20 overflow-hidden">{event.output}</pre>
      </div>
    );
  }

  if (event.kind === "result") {
    return (
      <div key={key} className="mt-2 pt-2 border-t border-gray-700">
        <div className={event.success ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
          {event.success ? "Completed" : "Failed"}
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
