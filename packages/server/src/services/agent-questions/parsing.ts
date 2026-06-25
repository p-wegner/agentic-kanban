/**
 * AskUserQuestion parsing — turn raw session stdout and synthetic MCP comment
 * payloads into structured {@link AgentQuestion} records.
 */
import type { AgentQuestion, AgentQuestionOption } from "./types.js";

export function parseSyntheticQuestionPayload(
  payload: string | null,
): { toolUseId: string; questions: AgentQuestion[] } | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { toolUseId?: unknown; questions?: unknown; source?: unknown };
    if (parsed.source !== "mcp_clarify_or_propose") return null;
    if (typeof parsed.toolUseId !== "string" || !Array.isArray(parsed.questions)) return null;
    const questions = parsed.questions
      .map((q): AgentQuestion | null => {
        if (!q || typeof q !== "object") return null;
        const raw = q as {
          question?: unknown;
          header?: unknown;
          multiSelect?: unknown;
          options?: unknown;
        };
        if (typeof raw.question !== "string" || !raw.question.trim()) return null;
        const rawOptions = Array.isArray(raw.options) ? raw.options : [];
        const options = rawOptions
          .map((opt): AgentQuestionOption | null => {
            if (!opt || typeof opt !== "object") return null;
            const rawOpt = opt as { label?: unknown; description?: unknown };
            if (typeof rawOpt.label !== "string" || !rawOpt.label.trim()) return null;
            return {
              label: rawOpt.label,
              ...(typeof rawOpt.description === "string" ? { description: rawOpt.description } : {}),
            };
          })
          .filter((opt): opt is AgentQuestionOption => opt !== null);
        return {
          question: raw.question,
          ...(typeof raw.header === "string" ? { header: raw.header } : {}),
          ...(typeof raw.multiSelect === "boolean" ? { multiSelect: raw.multiSelect } : {}),
          options: options.length > 0 ? options : [{ label: "Answer in free text" }],
        };
      })
      .filter((q): q is AgentQuestion => q !== null);
    return questions.length > 0 ? { toolUseId: parsed.toolUseId, questions } : null;
  } catch {
    return null;
  }
}

/** Shape of one parsed `result` stdout event carrying AskUserQuestion permission denials. */
interface ResultEventWithDenials {
  type?: string;
  permission_denials?: {
    tool_name?: string;
    tool_use_id?: string;
    tool_input?: { questions?: AgentQuestion[] };
  }[];
}

/**
 * Parse the last `result` stdout event for AskUserQuestion permission denials and
 * return their structured questions. Returns [] if none.
 */
export function extractQuestionsFromSession(
  messages: { type: string; data?: string | null }[],
): { toolUseId: string; questions: AgentQuestion[] }[] {
  const out: { toolUseId: string; questions: AgentQuestion[] }[] = [];
  for (const msg of messages) {
    if (msg.type !== "stdout" || !msg.data) continue;
    // Each "stdout" row is one JSON line emitted by the agent.
    const line = msg.data.trim();
    if (!line.includes("permission_denials")) continue;
    let evt: ResultEventWithDenials;
    try {
      evt = JSON.parse(line) as ResultEventWithDenials;
    } catch {
      continue;
    }
    if (evt.type !== "result" || !Array.isArray(evt.permission_denials)) continue;
    for (const denial of evt.permission_denials) {
      if (denial.tool_name !== "AskUserQuestion") continue;
      const qs = denial.tool_input?.questions;
      const toolUseId = denial.tool_use_id;
      if (!toolUseId || !Array.isArray(qs) || qs.length === 0) continue;
      out.push({ toolUseId, questions: qs });
    }
  }
  return out;
}
