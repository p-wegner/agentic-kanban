import { apiFetch } from "../lib/api.js";

interface PermissionPromptProps {
  permissionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  workspaceId: string;
  onResponded: () => void;
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Write":
    case "Edit":
      return (input.file_path as string) || "";
    case "Bash":
      return ((input.command as string) || "").slice(0, 80);
    case "Read":
    case "Glob":
    case "Grep":
      return (input.pattern as string) || (input.file_path as string) || "";
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

export function PermissionPrompt({ permissionId, toolName, toolInput, workspaceId, onResponded }: PermissionPromptProps) {
  async function handleRespond(behavior: "allow" | "deny") {
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/permission-response`, {
        method: "POST",
        body: JSON.stringify({ requestId: permissionId, behavior }),
      });
      onResponded();
    } catch {
      // Ignore errors — the MCP tool will timeout and deny
    }
  }

  const summary = summarizeInput(toolName, toolInput);

  return (
    <div className="border border-yellow-400 bg-yellow-50 rounded p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-yellow-600 font-semibold text-sm">Permission Request</span>
        <span className="text-xs font-mono bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">
          {toolName}
        </span>
      </div>
      {summary && (
        <p className="text-xs text-gray-700 font-mono truncate" title={summary}>
          {summary}
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => handleRespond("allow")}
          className="text-sm bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700"
        >
          Allow
        </button>
        <button
          onClick={() => handleRespond("deny")}
          className="text-sm bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
