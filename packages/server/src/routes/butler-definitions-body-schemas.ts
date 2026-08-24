/**
 * Request-body schemas for `routes/butler-definitions.ts` (#806, batch 5).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 *
 * **Only `POST /` is here, and batch 4's recorded reason for skipping both reads was wrong
 * about it.** That reason said the real guards live "behind the MAX_BUTLERS / name rules",
 * i.e. too deep to move. They are not: `createButlerDefinition` opens with
 * `const name = input.name.trim(); if (!name) throw ButlerDefinitionError("Butler name is
 * required", "BAD_REQUEST")` — the FIRST statement, which is precisely the criterion batch 4
 * used to convert `milestones` / `drives` / `scheduled-runs` POST. The MAX_BUTLERS check runs
 * after it and stays where it is, so the order a caller observes is unchanged.
 *
 * **`PUT /:bid` genuinely cannot move, but for family 5 (ORDER), not the coercion reason on
 * record.** `updateButlerDefinition` looks the butler up and throws `"Butler not found"`
 * (404) BEFORE it touches `patch.name`, so a schema running at the boundary would answer 400
 * where a caller gets 404 today.
 */
import { z } from "zod";
import { required, unchecked } from "./body-schema-helpers.js";

/**
 * `POST /api/butler-definitions`.
 *
 * `required`, because the guard tested the TRIMMED value (`input.name.trim()`) and a
 * whitespace-only name answers "Butler name is required" today. The ORIGINAL value is
 * forwarded — the service does its own trim, and `requiredTrimmed` would move where that
 * happens.
 *
 * The route reads `body.name ?? ""`, so absent and `null` both reached the same 400; both are
 * rejected here with that same message rather than by zod's own text.
 *
 * `model` and `provider` stay {@link unchecked}: `provider` is read through a ternary that maps
 * anything unrecognised to `undefined`, and `model` is persisted verbatim (`input.model ?? ""`),
 * so `{ provider: 7, model: 7 }` is a request that succeeds today (rule 3).
 */
export const createButlerDefinitionBody = z.object({
  name: required("Butler name is required"),
  model: unchecked<string>(),
  provider: unchecked<string>(),
}).passthrough();
