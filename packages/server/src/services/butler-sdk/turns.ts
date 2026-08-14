/** Send a turn to the active session, dispatching per backend (claude/codex/mock). */
import { broadcast, butlerSessionKey, sessions } from "./registry.js";
import { runProviderTurn } from "./codex-provider.js";

export function sendButlerTurn(
  projectId: string,
  content: string,
  opts?: { emitUserText?: boolean; butlerId?: string },
): boolean {
  const s = sessions.get(butlerSessionKey(projectId, opts?.butlerId));
  if (!s) return false;
  if (s.busy) return false;
  s.busy = true;
  s.transcript.push({ role: "user", text: content, ts: Date.now() });
  // For turns the UI itself didn't type (CLI/MCP `ask`), broadcast the prompt so
  // connected chat views render it instead of showing the butler acting on an
  // invisible request. The UI's own /message path renders its prompt optimistically,
  // so it leaves this off to avoid a duplicate bubble.
  if (opts?.emitUserText) broadcast(s, { type: "user", text: content });
  broadcast(s, { type: "turn-start" });
  if (s.backend === "codex") {
    runProviderTurn(s, content);
  } else if (s.backend === "mock") {
    const turnContent = content;
    setTimeout(() => {
      const response = `[mock] ${turnContent}`;
      broadcast(s, { type: "text", text: response });
      s.transcript.push({ role: "assistant", text: response, ts: Date.now() });
      s.busy = false;
      broadcast(s, { type: "result", text: response, isError: false });
    }, 50);
  } else {
    s.input?.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }
  return true;
}
