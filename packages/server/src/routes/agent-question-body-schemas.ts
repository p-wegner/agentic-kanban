/**
 * Request-body schemas for `routes/agent-questions.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 */
import { z } from "zod";
import { requiredRaw, arrayOnly } from "./body-schema-helpers.js";
import type { AgentQuestion } from "../services/agent-questions.service.js";

/**
 * `POST /api/projects/:id/agent-questions/:toolUseId/answer`.
 *
 * Declared in the order the single guard evaluated its three clauses
 * (`!body.workspaceId || !Array.isArray(body.questions) || !Array.isArray(body.answers)`)
 * rather than in the order the old type literal listed them — all three share one message, so
 * nothing on the wire depends on it, but the order is the guard's and should read that way.
 *
 * The element shapes stay unvalidated: `formatAnswerMessage` renders whatever it is given, and
 * checking elements here would refuse partially-filled answers the endpoint accepts today.
 */
export const answerAgentQuestionBody = z.object({
  workspaceId: requiredRaw("workspaceId, questions[], and answers[] are required"),
  questions: arrayOnly<AgentQuestion>("workspaceId, questions[], and answers[] are required"),
  answers: arrayOnly<{ selectedLabels: string[]; freeText?: string }>(
    "workspaceId, questions[], and answers[] are required",
  ),
}).passthrough();
