import { getString } from "./shared.js";

// Single interpretation point for "what did this tool call DO to the repo"
// (#951). Maps a parsed tool_use display event (name + parsed input) to the
// file/command activity the session summary aggregates. All four providers
// funnel through this: Claude's capitalized tool names (Read/Edit/Write/Bash),
// Copilot/Codex/Pi lowercase tools (view/edit/create/shell/...), and Codex
// native `file_change` items.

const READ_TOOLS = new Set(["read", "view", "grep", "glob"]);
const EDIT_TOOLS = new Set(["edit", "apply_patch", "file_change"]);
const WRITE_TOOLS = new Set(["write", "create"]);
const COMMAND_TOOLS = new Set(["bash", "powershell", "shell", "shell_command"]);

export type ToolActivityClassification =
  | { kind: "read" | "edit" | "write"; path: string }
  | { kind: "command"; command: string };

/** True when a raw string input is usable as a bare path/command (not serialized JSON). */
function usableRawString(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return "";
  return raw;
}

/**
 * Classify a tool invocation into repo-visible activity.
 *
 * @param name       tool name as parsed by the provider parser
 * @param input      parsed input record (display event `inputParsed`)
 * @param rawInput   optional raw string form — only consulted when `input` has
 *                   no usable field (Copilot sometimes sends the bare command/
 *                   path as a plain string)
 */
export function classifyToolActivity(
  name: string,
  input: Record<string, unknown>,
  rawInput?: string,
): ToolActivityClassification | undefined {
  const lower = name.toLowerCase();

  if (COMMAND_TOOLS.has(lower)) {
    const command = getString(input, ["command", "cmd", "script"])
      || (Object.keys(input).length === 0 ? usableRawString(rawInput) : "");
    return command ? { kind: "command", command } : undefined;
  }

  const path = getString(input, ["file_path", "filePath", "path", "target", "uri"])
    || (Object.keys(input).length === 0 && rawInput && !rawInput.includes("\n") ? usableRawString(rawInput) : "");
  if (!path) return undefined;

  if (READ_TOOLS.has(lower)) return { kind: "read", path };
  if (WRITE_TOOLS.has(lower)) return { kind: "write", path };
  if (EDIT_TOOLS.has(lower)) {
    // Codex `file_change` items carry a change kind; a brand-new file is a write.
    if (lower === "file_change" && input.kind === "add") return { kind: "write", path };
    return { kind: "edit", path };
  }
  return undefined;
}
