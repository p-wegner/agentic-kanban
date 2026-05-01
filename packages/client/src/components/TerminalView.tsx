import { useEffect, useRef } from "react";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

interface TerminalViewProps {
  messages: AgentOutputMessage[];
  connectionState: "connecting" | "open" | "closed" | "error";
}

export function TerminalView({ messages, connectionState }: TerminalViewProps) {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [messages]);

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

  return (
    <div className="flex flex-col h-64 border border-gray-300 rounded bg-gray-900">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border-b border-gray-700">
        <span className={`w-2 h-2 rounded-full ${statusColors[connectionState]}`} />
        <span className="text-xs text-gray-300">{statusLabels[connectionState]}</span>
      </div>
      <pre
        ref={preRef}
        className="flex-1 overflow-auto p-3 text-xs text-green-400 font-mono whitespace-pre-wrap"
      >
        {messages.map((msg, i) => {
          if (msg.type === "exit") {
            return (
              <div key={i} className="text-yellow-400">
                Process exited with code {msg.exitCode ?? "unknown"}
              </div>
            );
          }
          if (msg.type === "stderr") {
            return (
              <div key={i} className="text-red-400">{msg.data}</div>
            );
          }
          return <div key={i}>{msg.data}</div>;
        })}
        {messages.length === 0 && connectionState === "open" && (
          <span className="text-gray-500">Waiting for output...</span>
        )}
      </pre>
    </div>
  );
}
