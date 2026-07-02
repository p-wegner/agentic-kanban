/**
 * Butler-recommendation pipeline — build the prompt, run one warm butler turn,
 * and coerce the JSON reply into per-question {@link AgentQuestionRecommendation}s.
 */
import type { Database } from "../../db/index.js";
import { getPreference } from "../../repositories/preferences.repository.js";
import { getRuntimeState } from "../../repositories/runtime-state.repository.js";
import { getProjectRow } from "../../repositories/agent-questions.repository.js";
import { ensureButlerSession, sendButlerTurn, subscribeButler, getButlerSession } from "../butler-sdk.service.js";
import type { AgentQuestionRecommendation, RecommendInput } from "./types.js";

function buildRecommendationPrompt(input: RecommendInput): string {
  const issueRef = input.issueNumber !== null ? `#${input.issueNumber}: ${input.issueTitle}` : input.issueTitle;
  const desc = (input.issueDescription ?? "").slice(0, 500).trim();
  const lines: string[] = [
    `You are helping the user answer a question that an agent paused on.`,
    ``,
    `Issue ${issueRef}`,
  ];
  if (desc) lines.push(``, desc);
  lines.push(``, `The agent asked:`);
  input.questions.forEach((q, i) => {
    const header = q.header ? `${q.header}: ` : "";
    lines.push(`Question ${i + 1}: ${header}${q.question}`);
    lines.push(`  multiSelect: ${q.multiSelect ? "yes" : "no"}`);
    lines.push(`  Options:`);
    q.options.forEach((opt, j) => {
      const dsc = opt.description ? ` — ${opt.description}` : "";
      lines.push(`    [${j}] ${opt.label}${dsc}`);
    });
  });
  lines.push(
    ``,
    `Recommend an answer for each question. Reply with ONLY a JSON array (no prose, no code fences), one entry per question, in order:`,
    `[{"recommendedOptionIndexes":[0],"rationale":"short reason under 120 chars"}, ...]`,
    ``,
    `Rules:`,
    `- Use option indexes (0-based) from the Options list above.`,
    `- For single-select questions: exactly one index in recommendedOptionIndexes (or [] if none fit).`,
    `- For multi-select: zero or more indexes.`,
    `- If none of the options fit, set "freeText" to a short suggested reply and leave recommendedOptionIndexes as [].`,
    `- Keep each rationale under 120 characters and grounded in the ticket if relevant.`,
  );
  return lines.join("\n");
}

/** Strip code fences / leading prose and extract the first JSON array in the text. */
export function extractJsonArray(text: string): unknown {
  if (!text) throw new Error("empty butler response");
  let s = text.trim();
  // Strip ```json ... ``` or ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Find first '[' and last ']' to tolerate leading/trailing prose.
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON array found in butler response");
  return JSON.parse(s.slice(start, end + 1));
}

export function coerceRecommendation(raw: unknown, optionCount: number, multi: boolean): AgentQuestionRecommendation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { recommendedOptionIndexes?: unknown; freeText?: unknown; rationale?: unknown };
  const rationale = typeof r.rationale === "string" ? r.rationale.trim().slice(0, 240) : "";
  const idxArr = Array.isArray(r.recommendedOptionIndexes) ? r.recommendedOptionIndexes : [];
  const indexes: number[] = [];
  for (const v of idxArr) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < optionCount) {
      indexes.push(v);
    }
  }
  // Enforce single-select cardinality.
  const finalIndexes = multi ? indexes : indexes.slice(0, 1);
  const freeText = typeof r.freeText === "string" && r.freeText.trim() ? r.freeText.trim() : undefined;
  if (finalIndexes.length === 0 && !freeText && !rationale) return null;
  return { recommendedOptionIndexes: finalIndexes, rationale: rationale || (freeText ? "Butler suggests a free-text reply." : "Butler's pick."), ...(freeText ? { freeText } : {}) };
}

/** Run one short butler turn for this question set and return per-question recommendations.
 *  Uses the warm SDK session if present, starting it on demand. The call is a one-shot
 *  prompt — listeners are attached, the turn pushed, and we resolve on the next `result`. */
export async function recommendQuestionsForSet(
  projectId: string,
  input: RecommendInput,
  db: Database,
): Promise<Array<AgentQuestionRecommendation | null>> {
  // Ensure a butler session exists; if not, start one from the project record so the
  // recommender works even before the user opens the Butler view.
  if (!getButlerSession(projectId).active) {
    const project = await getProjectRow(projectId, db);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const claudeProfile = (await getPreference(`butler_profile_${projectId}`, db))
      || (await getPreference("claude_profile", db))
      || undefined;
    const model = (await getPreference(`butler_model_${projectId}`, db)) || undefined;
    const resumeSessionId = (await getRuntimeState(`butler_session_${projectId}`, db)) || undefined;
    ensureButlerSession({
      projectId,
      repoPath: project.repoPath,
      projectName: project.name,
      claudeProfile,
      model,
      resumeSessionId,
    });
  }

  const prompt = buildRecommendationPrompt(input);
  const timeoutMs = 45_000;
  const answer = await new Promise<{ text: string; isError: boolean }>((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (text: string, isError: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve({ text, isError });
    };
    const unsubscribe = subscribeButler(projectId, (e) => {
      if (e.type === "text") buf += e.text;
      else if (e.type === "result") finish(e.text ?? buf, e.isError ?? false);
      else if (e.type === "error") finish(e.message, true);
    });
    const timer = setTimeout(() => finish(buf || "(timed out)", true), timeoutMs);
    sendButlerTurn(projectId, prompt);
  });

  if (answer.isError) {
    throw new Error(`butler returned error: ${answer.text.slice(0, 200)}`);
  }

  const parsed = extractJsonArray(answer.text);
  if (!Array.isArray(parsed)) throw new Error("butler response was not a JSON array");
  return input.questions.map((q, i) => coerceRecommendation(parsed[i], q.options.length, !!q.multiSelect));
}
