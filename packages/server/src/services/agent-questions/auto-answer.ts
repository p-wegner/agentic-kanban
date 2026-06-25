/**
 * Auto-answer + background-recommendation orchestration. When the
 * `butler_auto_answer` preference is on and the butler is confident on every
 * sub-question, the recommendation is turned into a follow-up turn and sent to
 * the agent's workspace automatically.
 */
import type { Database } from "../../db/index.js";
import { getPreference } from "../../repositories/preferences.repository.js";
import { recommendQuestionsForSet } from "./recommendation.js";
import { setCachedRecommendations, markAnswered, writeAgentQuestionComment } from "./markers.js";
import type {
  AgentQuestion,
  AgentQuestionRecommendation,
  AutoAnswerSendTurn,
  RecommendInput,
} from "./types.js";

/** In-flight recommendation calls, keyed by toolUseId — prevents duplicate butler turns
 *  when multiple list pollers race. */
const inFlightRecommendations = new Set<string>();

interface AutoAnswerDeps {
  workspaceId: string;
  sendTurn: AutoAnswerSendTurn;
}

export function scheduleBackgroundRecommendation(projectId: string, input: RecommendInput, db: Database, autoAnswerDeps?: AutoAnswerDeps): void {
  if (inFlightRecommendations.has(input.toolUseId)) return;
  inFlightRecommendations.add(input.toolUseId);
  void (async () => {
    try {
      const recs = await recommendQuestionsForSet(projectId, input, db);
      await setCachedRecommendations(input.toolUseId, recs, db);
      if (autoAnswerDeps) {
        await tryAutoAnswer(input.toolUseId, autoAnswerDeps.workspaceId, input.questions, recs, autoAnswerDeps.sendTurn, db);
      }
    } catch (err) {
      console.error(`[agent-questions] background recommend failed: toolUseId=${input.toolUseId} ${err instanceof Error ? err.message : String(err)}`);
      // Cache nulls so we don't re-poll on every list call.
      await setCachedRecommendations(input.toolUseId, input.questions.map(() => null), db);
    } finally {
      inFlightRecommendations.delete(input.toolUseId);
    }
  })();
}

/**
 * Attempt to auto-answer a question set using butler recommendations if the
 * `butler_auto_answer` preference is enabled.
 *
 * Requirements for auto-answering:
 * - `butler_auto_answer` preference is "true"
 * - All recommendations are non-null (butler must be confident on every sub-question)
 * - For single-select questions: recommendation has ≥1 selected option or freeText
 * - Butler session must not have been interrupted (recs already non-null means it ran)
 */
export async function tryAutoAnswer(
  toolUseId: string,
  workspaceId: string,
  questions: AgentQuestion[],
  recs: Array<AgentQuestionRecommendation | null>,
  sendTurn: AutoAnswerSendTurn,
  db: Database,
): Promise<void> {
  const autoAnswerEnabled = await getPreference("butler_auto_answer", db);
  if (autoAnswerEnabled !== "true") return;

  // All sub-questions must have a non-null recommendation.
  if (recs.some((r) => r === null)) {
    console.info(`[agent-questions] auto-answer skipped: incomplete recommendations toolUseId=${toolUseId}`);
    return;
  }

  // For single-select questions, require at least one selected option or freeText.
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const rec = recs[i]!;
    if (!q.multiSelect && rec.recommendedOptionIndexes.length === 0 && !rec.freeText) {
      console.info(`[agent-questions] auto-answer skipped: no clear winner for question ${i} toolUseId=${toolUseId}`);
      return;
    }
  }

  // Build answers from recommendations.
  const answers = buildAnswersFromRecommendations(questions, recs as AgentQuestionRecommendation[]);
  const content = formatAnswerMessage(questions, answers);

  const chosenLabels = questions.map((q, i) => {
    const rec = recs[i]!;
    const labels = rec.recommendedOptionIndexes.map((idx) => q.options[idx]?.label).filter(Boolean);
    return labels.length > 0 ? labels.join(", ") : rec.freeText ?? "(none)";
  });
  const rationales = (recs as AgentQuestionRecommendation[]).map((r) => r.rationale).join("; ");

  try {
    await sendTurn(workspaceId, content);
    await markAnswered(toolUseId, db);
    await writeAgentQuestionComment(
      { toolUseId, workspaceId, questions, answers, body: content, author: "butler" },
      db,
    );
    const firstQ = questions[0]?.question ?? "(unknown)";
    console.info(
      `[agent-questions] auto-answered toolUseId=${toolUseId} workspaceId=${workspaceId} ` +
      `question="${firstQ.slice(0, 80)}" chosen="${chosenLabels.join(" | ")}" rationale="${rationales.slice(0, 160)}"`,
    );
  } catch (err) {
    console.error(`[agent-questions] auto-answer send failed: toolUseId=${toolUseId} ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Build answer structs from butler recommendations — the server-side equivalent of the
 *  client's emptyAnswers() initializer. */
function buildAnswersFromRecommendations(
  questions: AgentQuestion[],
  recs: AgentQuestionRecommendation[],
): { selectedLabels: string[]; freeText?: string }[] {
  return questions.map((q, i) => {
    const rec = recs[i];
    if (!rec) return { selectedLabels: [] };
    const selectedLabels: string[] = [];
    for (const idx of rec.recommendedOptionIndexes) {
      const opt = q.options[idx];
      if (opt) selectedLabels.push(opt.label);
    }
    const freeText = selectedLabels.length === 0 && rec.freeText ? rec.freeText : undefined;
    return { selectedLabels, ...(freeText ? { freeText } : {}) };
  });
}

/**
 * Format the user's answers as a plain-text follow-up message for the agent.
 * Mirrors the structure the agent originally asked, so it can reconcile easily.
 */
export function formatAnswerMessage(
  questions: AgentQuestion[],
  answers: { selectedLabels: string[]; freeText?: string }[],
): string {
  const lines: string[] = ["Here are my answers to your questions:", ""];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i] ?? { selectedLabels: [] };
    const header = q.header ? `${q.header}: ` : "";
    lines.push(`${i + 1}. ${header}${q.question}`);
    if (a.selectedLabels.length > 0) {
      for (const label of a.selectedLabels) {
        lines.push(`   - ${label}`);
      }
    }
    if (a.freeText && a.freeText.trim()) {
      lines.push(`   Note: ${a.freeText.trim()}`);
    }
    lines.push("");
  }
  lines.push("Please proceed with these answers.");
  return lines.join("\n");
}
