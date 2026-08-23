/**
 * Request-body schemas for `routes/agent-skills.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 *
 * Only `POST /api/agent-skills/enhance` is here. The three other body reads in that file
 * (`POST /`, `PUT /:id`, `POST /:id/install`) have NO guard at all — each forwards the whole
 * body to `agentSkillService`, which owns the field rules, so a schema would either invent a
 * field list or check nothing. Same argument as `PATCH /api/projects/:id` in batch 2.
 */
import { z } from "zod";
import { required, unchecked } from "./body-schema-helpers.js";

/** `POST /api/agent-skills/enhance`. Trim-tested, original value forwarded to the model. */
export const enhanceSkillBody = z.object({
  name: required("name is required"),
  description: unchecked<string>(),
  prompt: unchecked<string>(),
}).passthrough();
