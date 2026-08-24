/**
 * Request-body schemas for `routes/agent-skills.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 *
 * `POST /api/agent-skills/enhance` came in batch 3; `POST /` in batch 5.
 *
 * **Batch 3's recorded reason for skipping all three of the file's other reads was wrong about
 * `POST /`.** It said each of them "has NO guard at all — each forwards the whole body to
 * `agentSkillService`, which owns the field rules". `createSkill` does own the rule, but it is
 * that function's FIRST statement (`if (!input.name || !input.description || !input.prompt)
 * throw AgentSkillError("name, description, and prompt are required", "BAD_REQUEST")`), which
 * is exactly the criterion batch 4 used to move `milestones` / `drives` / `scheduled-runs`
 * POST to the boundary. Nothing is re-ordered by moving it: the name-pattern check, the
 * duplicate lookup and the insert all run after it and stay where they are.
 *
 * The other two reads DO stay, and their reason is family 5 (ORDER), not "no guard":
 * `updateSkill` and `installSkill` both open with `getAgentSkillById` → `"Skill not found"`
 * (404), so a schema at the boundary would answer 400 where a caller gets 404 today.
 */
import { z } from "zod";
import { required, requiredTruthy, unchecked } from "./body-schema-helpers.js";

/** `POST /api/agent-skills/enhance`. Trim-tested, original value forwarded to the model. */
export const enhanceSkillBody = z.object({
  name: required("name is required"),
  description: unchecked<string>(),
  prompt: unchecked<string>(),
}).passthrough();

/**
 * `POST /api/agent-skills`.
 *
 * One message for three fields, because `!input.name || !input.description || !input.prompt`
 * was ONE condition — whichever field zod reports first, the wire text is identical, which is
 * what makes the guard-order rule vacuous here rather than violated.
 *
 * {@link requiredTruthy}, NOT `requiredRaw`: the guard is a bare falsy test on fields it never
 * type-checked, so `{ name: 7, description: 7, prompt: 7 }` creates a skill today (the
 * name-pattern check coerces via `RegExp.test`, and the column takes it). `z.string().min(1)`
 * would start answering 400 for it — a live request broken to gain a type check the endpoint
 * has never performed (rule 3).
 *
 * Every remaining field stays {@link unchecked}, and `.passthrough()` is load-bearing: the
 * handler forwards the WHOLE body to `agentSkillService.createSkill`.
 */
export const createSkillBody = z.object({
  name: requiredTruthy("name, description, and prompt are required"),
  description: requiredTruthy("name, description, and prompt are required"),
  prompt: requiredTruthy("name, description, and prompt are required"),
  model: unchecked<string>(),
  projectId: unchecked<string | null>(),
  isInit: unchecked<boolean>(),
}).passthrough();
