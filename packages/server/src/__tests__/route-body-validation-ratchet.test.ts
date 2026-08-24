// @gate:always-run — recursively walks packages/server/src/routes and parses every file; it
// imports nothing it checks, so `vitest related` can never select it from a route diff (#806).
import { describe, expect, it } from "vitest";
import path from "node:path";
import ts from "typescript";
import {
  walkPackageSources,
  packagesRootFrom,
  parseGuardSource,
  forEachNode,
  compareRatchet,
  lineOf,
} from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * #806, inbound half — **request bodies that are read but never CHECKED, shrink-only.**
 *
 * #780 made the OUTBOUND gap countable (`unvalidatedResponse`); the inbound side had no such
 * seam and no such number. The ticket described it as "0 uses of `zValidator`", which is true
 * and also the wrong measurement: this codebase does not use `zValidator`, it uses
 * `parseJsonBody(c, schema)` (`middleware/parse-body.ts`, #512), which is the same guarantee
 * through its own door. Counting `zValidator` would have reported 0/48 forever while the real
 * ratio moved. What actually matters is how many handlers read a body and trust its shape.
 *
 * **What counts as unvalidated**, measured on the AST rather than on text so a reformat or a
 * type-argument cannot hide a call site:
 *
 * | Call | Verdict |
 * |---|---|
 * | `parseJsonBody(c, schema)` | validated — the body is CHECKED and returned narrowed |
 * | `parseJsonBody(c)` / `parseJsonBody<T>(c)` | **unvalidated** — asserts a type it never verifies |
 * | `parseOptionalJsonBody(c)` | **unvalidated** — answers `{}` for anything unparseable |
 * | `c.req.json()` raw | **unvalidated** — not even the "invalid JSON body" 400 |
 *
 * `parseOptionalJsonBody` is counted deliberately, even though several of its call sites are
 * CORRECT (an endpoint whose contract is that the body is optional cannot answer 400 for a
 * missing one). The baseline is a census of trust, not a list of bugs — an entry leaves it by
 * gaining a schema, and a call site that should keep the loose helper simply keeps its slot.
 * Zero is not the goal and this file does not claim it is.
 *
 * **The baseline may only SHRINK.** `compareRatchet` fails both directions: a file over its
 * number is a regression, and a file UNDER it is a stale entry that must be lowered — which is
 * what stops a ceiling from decaying into a budget that the next regression hides inside.
 *
 * Landed in #806's batch 1 (19 handlers, 120 → 101): `codemods.ts` (3, and `POST /apply` WRITES
 * FILES using `projectId` as its security boundary), `projects.ts` (9), `workspace-actions.ts`
 * (5), `tags.ts` (2). Batch 2 took 101 → 92 by working the cases batch 1 had declared
 * non-mechanical: `plugins.ts` (12 → 5) and `projects.ts` (6 → 4). Batch 3 took 92 → 70
 * across eleven route files — `issues.ts` (12 → 2), `failure-patterns.ts` (2 → 0), `flaky-tests.ts` (3 → 1),
 * `agent-questions.ts`, `drive-obstacles.ts`, `merge-queue.ts`, `project-analytics.ts`,
 * `showdowns.ts`, `voice-capture.ts` (each 1 → 0), `drive.ts` (2 → 1) and `agent-skills.ts`
 * (4 → 3) — and REJECTED seven more handlers, each recorded on its entry below. Batch 4 took
 * 70 → 64 across four route files — `butler.ts` (6 → 3), `drives.ts` (3 → 2),
 * `milestones.ts` (2 → 1) and `scheduled-runs.ts` (2 → 1) — and is mostly a REJECTION batch:
 * it read every remaining handler and added two families below rather than manufacturing
 * conversions. Batch 5 took 64 → 58 across four route files — `butler.ts` (3 → 0),
 * `butler-definitions.ts` (2 → 1), `agent-skills.ts` (3 → 2) and `projects.ts` (4 → 3). The
 * remainder is the disclosed one, per CLAUDE.md's partial-refactor rule — this file IS that
 * disclosure.
 *
 * **Batch 5 was an AUDIT of the 64, not a search for more conversions, and it is the reason to
 * distrust a recorded reason that has not been re-read.** Batch 4 declared the route-level
 * surface exhausted and the remainder six documented families. Re-deriving every reason against
 * HEAD found four that did not survive, and all four had the same shape — a rejection argued
 * against a schema NOBODY HAD TO WRITE:
 *
 *   - **`butler.ts` ×3 rested on a factually wrong claim.** The recorded reason said
 *     `{ model: 7 }` "is a request that succeeds today". It does not: `?.` short-circuits on
 *     nullish only, so `normalizeModelForBackend`'s `model?.trim()` throws on a number and the
 *     endpoint answers **500**. `profile` is the same shape. For `skill`, the BRANCH reading was
 *     right (an empty prompt deletes the override and answers 200) but the conclusion did not
 *     follow: it argued against `required("prompt is required")`, when the declared-type
 *     tightening keeps the branch and touches only the 500.
 *   - **`butler-definitions.ts POST /` and `agent-skills.ts POST /` were recorded as having no
 *     movable guard.** Both service guards are their function's FIRST statement — batch 4's own
 *     conversion criterion, applied to `milestones` / `drives` / `scheduled-runs` in the same
 *     batch that rejected these.
 *   - **`projects.ts POST /create`'s reason was about the OPTIONAL fields** (no null discipline,
 *     true and still respected — they all stay unchecked) and never addressed `name`, whose
 *     guard is `createProject`'s first statement.
 *
 * The audit also found `workspace-actions.ts` carrying NO reason at all, against batch 4's claim
 * that "all 64 remaining entries now carry their family and reason inline". Its six were read
 * and are correctly rejected; the reason is written on the entry now.
 *
 * The other 54 entries were re-derived against HEAD and their reasons HOLD — including the
 * subtle ones: `milestone.service.update`, `drive.service.update`, `tag.updateTagById`,
 * `project-scripts.create/update`, `scheduled-run.update`, `quality-metrics.recordBatch`,
 * `agent-skill.updateSkill/installSkill` and `butler-definitions.updateButlerDefinition` were
 * each read to confirm the 404/403 lookup really does precede the body check (family 5), and
 * the five multi-encoding readers were read to confirm they still accept multipart / a bare
 * array / a bare string (family 6).
 *
 * **What batch 4 found, and why its yield is small on purpose.** Batches 1–3 took the
 * ROUTE-LEVEL guards; by batch 4 that surface is empty. Every remaining `c.json({error}, 400)`
 * sitting next to an unvalidated read is in `preferences.ts` (family 3 below) or in
 * `workspaces.ts`, where `resolveIssueIdFromBody` needs the DATABASE and can answer 404. What
 * is left is guards that live one hop away in a SERVICE, and those split cleanly on ORDER
 * (family 5). The four handlers batch 4 converted are exactly the ones whose service guard is
 * that service's FIRST statement.
 *
 * **Two things batch 4 measured that a fifth batch should not re-derive:**
 *   - **A service guard's `code` is part of the wire.** `MilestoneError` / `DriveError` /
 *     `ScheduledRunError` render as `{ error, code: "BAD_REQUEST" }` (#823) while
 *     `parseJsonBody`'s `HTTPException` renders `{ error }` alone, so every such conversion
 *     needs the `parsePluginBody` wrapper batch 2 invented — and that wrapper must be a
 *     SAME-FILE local function, because `scripts/generate-openapi.ts` follows exactly one hop
 *     via `findFunctionNamed(sf, …)` and would otherwise lose the operation's property list.
 *   - **The remainder does NOT overlap the OpenAPI gap.** Every handler batch 4 could convert
 *     reads `parseJsonBody<T>(c)`, which already gives the spec a property list, so the
 *     conversion improves WHAT is documented (required fields, `x-unknown-keys`) but removes
 *     nothing from `openapi-request-body-ratchet.test.ts`. The operations still lacking a
 *     property list are the untyped / optional / multi-encoding reads — families 2, 4 and 6 —
 *     plus operations that read no body at all.
 *
 * **The rejection FAMILIES, after three batches.** Every entry left below is one of these, so a
 * fourth batch can argue with the family rather than rediscover the case:
 *
 *   1. **Coercion, not check.** The handler reads the field through a conversion that accepts
 *      the "wrong" type on purpose (`Number(body.minutes)`, `body.autoRepair === true`,
 *      `typeof body.source === "string" ? body.source : ""`). A schema would 400 a request that
 *      succeeds today. `issues.ts POST /:id/time-entries`, `drive.ts POST …/preflight`,
 *      `plugins.ts POST /` and `/validate`.
 *   2. **No declared body to tighten TO.** The body is untyped (or `Record<string, unknown>`) and
 *      forwarded whole to a service that decides field by field what it recognises. A schema must
 *      either invent a field list — and 400 the fields it forgot — or check nothing and merely
 *      look validated. `issues.ts PATCH /:id`, `projects.ts PATCH /:id`,
 *      `project-stack-profile.ts PUT /:id/stack-profile`.
 *   3. **A different STATUS or error BODY.** `workers.ts` — 422, and the fleet protocol's
 *      `{ error, boardProtocolVersion }` that the worker daemon branches on (#754).
 *   4. **`parseOptionalJsonBody` by contract.** A missing body is a valid request the handler
 *      answers itself, so `parseJsonBody` would replace its message with `invalid JSON body`.
 *      `flaky-tests.ts DELETE /pin` is the explicit case; the rest are counted-but-correct.
 *
 *   5. **ORDER — the guard runs AFTER a lookup that answers 404/403** (new in batch 4). The
 *      body check lives in a service, but not as its first statement: `milestones.ts PUT /:id`,
 *      `drives.ts PUT /:id` and `tags.ts PATCH /:id` look the row up (404) and check its project
 *      (403) first; `project-scripts.ts` and `quality-metrics.ts` resolve the PROJECT first. A
 *      schema runs before the handler, so it would answer 400 where a caller gets 404 or 403
 *      today. This is the family that separates the four handlers batch 4 DID convert: in
 *      `milestone.service.ts`, `drive.service.ts` and `scheduled-run.service.ts` the guard is
 *      the FIRST statement, so moving it to the boundary re-orders nothing. Batch 5 moved
 *      `agent-skills.ts PUT /:id` + `POST /:id/install` and `butler-definitions.ts PUT /:bid`
 *      INTO this family, out of the "no guard at all" / "coercion" reasons they had been given:
 *      each of those services opens with a 404 lookup, which is a stronger and checkable
 *      reason than the one on record.
 *   6. **The JSON body is only ONE of several accepted encodings** (new in batch 4).
 *      `backlog-markdown.ts`, `backlog-snapshot.ts`, `issue-export-import.ts` (both reads) and
 *      `config-export-import.ts` branch on `Content-Type` and also accept `multipart/form-data`,
 *      `text/markdown`, a bare JSON array or a bare JSON string. `parseJsonBody` would 400 a
 *      multipart upload outright, and a `z.object` cannot express "an object OR an array OR a
 *      string". Their `c.req.json().catch(() => null)` is the correct read for that contract.
 *
 * Family 3 and family 4 can still fall the way `plugins.ts`'s error CLASS did — by restoring the
 * identity around the schema. Families 1, 2, 5 and 6 cannot: there is nothing left to check that
 * would not narrow what the endpoint accepts today, or would change which answer a caller gets.
 *
 * **The one structural move that would shrink the remainder further, and why batch 5 did not
 * make it.** Eighteen of the 58 are `parseOptionalJsonBody` sites (family 4), and that helper
 * has no schema overload — so an optional body cannot be type-checked at all today. A
 * `parseOptionalJsonBody(c, schema)` taking an all-optional schema would be a real seam. It was
 * declined here because for almost every one of those sites the field is read through a
 * coercion with a default (family 1 as well), so the new check would 400 requests that succeed
 * today: the seam would lower the census without hardening anything. Building middleware to
 * move a number is the failure this file's own preamble warns about.
 *
 * **What batch 2 learned about the two families batch 1 flagged**, since the flags were half
 * right and a later batch should inherit the corrected version:
 *
 *   - **The error CLASS is a real obstacle, but a surmountable one.** `PluginError(msg,
 *     "BAD_REQUEST")` renders as `{ error, code: "BAD_REQUEST" }` at 400 (#823) while
 *     `parseJsonBody`'s `HTTPException` renders as `{ error }` alone — so a bare swap drops a
 *     field, which is a wire change. `plugins.ts` keeps its error identity by re-throwing the
 *     schema's `HTTPException` as a `PluginError` (`parsePluginBody`), and converts. Any route
 *     file with its own error class can do the same.
 *   - **A different STATUS is not surmountable that way, and `workers.ts` is the case.** All four
 *     of its reads answer **422** (`UnprocessableError`) or a bespoke 401/409/422 protocol body;
 *     see the per-entry note below. Those stay.
 *   - **The `body.projectId ?? c.req.query("projectId")` claim was WRONG.** No POST/PUT handler in
 *     `plugins.ts` falls back to the query string — the fallback exists only on its GET routes,
 *     which read no body at all. Nothing in the remainder is blocked by "optional in the body,
 *     required overall". Verified by reading every handler in that file, not by grep.
 *
 * **A rejection is a valid outcome and is recorded as a comment on the entry**, so the next batch
 * argues with the reason instead of rediscovering it.
 */

const packagesRoot = packagesRootFrom(import.meta.dirname!, 3);
const routesDir = path.join(packagesRoot, "server", "src", "routes");

/** Body-reading helpers from `middleware/parse-body.ts`, and whether a schema argument exists. */
const PARSE_HELPERS = new Set(["parseJsonBody", "parseOptionalJsonBody"]);

interface Offender {
  file: string;
  line: number;
  call: string;
}

/**
 * Every unvalidated body read under `routes/`.
 *
 * Note the AST trap this file exists downstream of: `parseGuardSource` parses with
 * `setParentNodes: false`, so `node.parent` is `undefined` and `node.getText()` — which walks
 * `.parent` to find its source file — throws. Everything below reads `.text` off identifiers and
 * takes the parent from {@link forEachNode}, never from the node.
 */
function findUnvalidatedBodyReads(): Offender[] {
  const offenders: Offender[] = [];
  for (const abs of walkPackageSources(routesDir)) {
    const file = path.basename(abs);
    const sf = parseGuardSource(abs);
    forEachNode(sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;

      if (ts.isIdentifier(callee) && PARSE_HELPERS.has(callee.text)) {
        // `parseJsonBody(c, schema)` is the validated form; one argument is a bare assertion.
        const validated = callee.text === "parseJsonBody" && node.arguments.length >= 2;
        if (!validated) offenders.push({ file, line: lineOf(sf, node), call: `${callee.text}()` });
        return;
      }

      // `c.req.json()` — a body read that bypasses the middleware entirely.
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "json" &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === "req"
      ) {
        offenders.push({ file, line: lineOf(sf, node), call: "c.req.json()" });
      }
    });
  }
  return offenders;
}

/**
 * Unvalidated body reads per route file, frozen at #806's post-batch measurement.
 * **Only ever lower a number here** — raising one re-opens the gap this file measures.
 */
const BASELINE: Readonly<Record<string, number>> = {
  // 2 = `PUT /:id` and `POST /:id/install`. REJECTED, family 5 (ORDER) — and batch 3's recorded
  // reason for this file ("none of the three has a guard") was WRONG about the third read:
  // `createSkill` opens with `if (!input.name || !input.description || !input.prompt)`, a
  // first-statement guard, so `POST /` converted in batch 5. The two that remain both open with
  // `getAgentSkillById` → `Skill not found` (404) — `updateSkill` also `Cannot modify built-in
  // skills` (403) — before any field is read, so a boundary schema would answer 400 where a
  // caller gets 404/403 today. `POST /:id/install` is additionally a body-optional read
  // (`.catch(() => ({}))`).
  "agent-skills.ts": 2,
  // 2 = `POST /` and `PUT /:id`. REJECTED: neither has a guard, and the declared-type
  // tightening `addStatusBody` used is NOT available here — `resolveApprovalContext` CATCHES
  // its own failures and returns `{}`, so `POST /` with no `sessionId` creates an approval and
  // answers 200 today. Turning a succeeding request into a 400 is the one thing these swaps
  // may not do. `PUT /:id`'s `decision` is forwarded to `resolveApproval` unchecked.
  "approvals.ts": 2,
  // REJECTED, family 6: `readBody` branches on Content-Type and also accepts
  // `multipart/form-data` and `text/markdown`. `parseJsonBody` would 400 an upload.
  "backlog-markdown.ts": 1,
  // REJECTED, family 6: multipart or JSON, and the JSON form accepts EITHER `{snapshot}` or a
  // bare snapshot — then hands both to `validateBacklogSnapshot`, which owns the field rules.
  "backlog-snapshot.ts": 1,
  // 2 = `POST /:id/conductor` and `PUT /:id/conductor-schedule`. REJECTED (family 4, in a
  // third spelling): both read `c.req.json().catch(() => ({}))`, so an ABSENT body is a valid
  // request — it reaches "action must be 'start' or 'stop'" on the first and simply keeps the
  // stored schedule (200) on the second. `parseJsonBody` would answer `invalid JSON body` for
  // both.
  "board-monitor.ts": 2,
  // 1 = `PUT /:bid`. REJECTED, family 5 (ORDER) — a CORRECTION of batch 3's family-1 reason,
  // which was right about `provider` (a ternary mapping anything unrecognised to `undefined`,
  // so `{ provider: 7 }` is valid today, and it stays unchecked) and wrong about where the name
  // rule lives: it is the FIRST statement of `createButlerDefinition`, which is why `POST /`
  // converted in batch 5. `updateButlerDefinition` is the one that cannot move — it throws
  // `Butler not found` (404) before it reads `patch.name`.
  "butler-definitions.ts": 1,
  // REJECTED, family 6: multipart-or-JSON, then `validateBoardConfigShape` answers
  // `{ error: "Invalid config shape", details }` — a body `parseJsonBody` cannot produce.
  "config-export-import.ts": 1,
  // 1 = `POST /:projectId/drive/preflight`. REJECTED: `autoRepair` is read as
  // `body.autoRepair === true` with no guard, so `{ autoRepair: "yes" }` is a valid request
  // today that means "no"; a schema would turn it into a 400. `PUT /:projectId/drive`
  // converted in batch 3.
  "drive.ts": 1,
  // 2 = `PUT /:projectId/drives/:id` (family 5 — `target cannot be empty` runs after the
  // existence + ownership checks, so a schema would answer 400 where a caller gets 404/403)
  // and `POST /:id/finish` (family 4). `POST /:projectId/drives` converted in batch 4.
  "drives.ts": 2,
  // 1 = `DELETE /pin`. REJECTED: it is a `parseOptionalJsonBody` site whose contract is that
  // an absent body still reaches its own `testName is required` 400; `parseJsonBody` would
  // answer `invalid JSON body` for that same request.
  "flaky-tests.ts": 1,
  // 2 = `POST /api/internal/board-notify` and `/internal/workflow-advanced`. REJECTED,
  // family 4: both answer `{ ok: true }` for an EMPTY body on purpose — they are
  // fire-and-forget notifications whose fields are all `if (body.x)` optional.
  "index.ts": 2,
  // REJECTED, family 6: `/issues/import` and `/import/preview` each accept multipart, a JSON
  // `{ text, format }` object, a bare JSON ARRAY of issues, or (preview) a bare JSON string.
  // A `z.object` cannot express that union, and multipart never reaches a JSON parse at all.
  "issue-export-import.ts": 2,
  // 2 = `PATCH /:id` and `POST /:id/time-entries`, both REJECTED with reasons at the call
  // sites. `PATCH /:id` forwards an UNTYPED body whole to `updateIssue(id, Record<string,
  // unknown>)` — there is nothing to tighten to (the `PATCH /projects/:id` argument).
  // `POST /:id/time-entries`'s only guard is a coercion (`Number(body.minutes)` then
  // `Number.isInteger`), so `{"minutes":"30"}` succeeds today and a schema would 400 it;
  // nothing else in that body is checked, so a schema would be decoration.
  "issues.ts": 2,
  // 1 = `PUT /:projectId/milestones/:id`. REJECTED, family 5 — the reason is written out in
  // `milestone-body-schemas.ts`. `POST /:projectId/milestones` converted in batch 4.
  "milestones.ts": 1,
  // 5 = 2 install-side reads + 3 `parseOptionalJsonBody`. The other seven converted in batch 2.
  // `POST /api/plugins` and `POST /api/plugins/validate` are REJECTED, not deferred: their
  // `source` handling is a COERCION (`typeof body.source === "string" ? body.source : ""`), not a
  // check, and `validatePluginSource("")` answers **200** with `{ok:false, errors:["source is
  // required"]}`. A schema would turn `{source: 123}` from a 200 report into a 400 — a live
  // request broken to gain a type check the endpoint deliberately does not perform.
  "plugins.ts": 5,
  // REJECTED, all five, and this is family 3's second instance after `workers.ts`:
  //   - `POST /codex-login` and `/claude-login` DO have real guards, but they answer
  //     `{ ok: false, error }` — `parseJsonBody` renders `{ error }` alone, so the swap would
  //     drop `ok` from a body the UI branches on. There is no error class here to re-wrap.
  //   - `POST /agent-profiles/preflight` answers a full `AgentProfilePreflightResult`
  //     (`{ ok, status, errors[], warnings[], flags[], command, provider, profileName }`) at 400.
  //   - `PUT /settings` takes a `Record<string, string>` with no field list at all (family 2)
  //     and answers **422** with `{ ok, applied, droppedKeys | divergence, error }` (#874/#903).
  //   - `PUT /active-project` has no guard: `body.projectId ?? ""` is a coercion (family 1).
  "preferences.ts": 5,
  // 2 = `POST /:projectId/scripts` and `PATCH /:projectId/scripts/:scriptId`. REJECTED,
  // family 5: both bodies are untyped `Record<string, unknown>` forwarded whole, and every
  // `name is required` / `command is required` guard in `project-scripts.service.ts` runs
  // AFTER `Project not found` (404) — and, for PATCH, after `Script shortcut not found`.
  "project-scripts.ts": 2,
  // 1 = `PUT /:id/stack-profile`. REJECTED, family 2: the body is a `Partial<StackProfile>`
  // merged field-by-field into the stored profile by `saveManualStackProfile`, with no guard
  // anywhere — a schema would have to invent a field list for a type that is all-optional.
  "project-stack-profile.ts": 1,
  // 3 = `POST /`, `PATCH /:id`, and one `parseOptionalJsonBody` (`/onboarding/dismiss`, whose
  // body is read and DISCARDED). Reasons in `project-body-schemas.ts`'s header: `PATCH /:id`
  // has no declared body type to tighten TO and its only real check answers 422; `POST /`'s
  // cross-field guard sits behind `startRegistrationProgress`, so moving it would stop creating
  // the progress record the caller polls, and `{ repoPath: 7 }` is truthy and fails later with
  // a different 400 message. `POST /create` converted in batch 5 — its `name` guard is the
  // first statement of `createProject`, which batch 2's optional-field reason never addressed.
  "projects.ts": 3,
  // 1 = `POST /:id/quality-metrics`. REJECTED, families 5 + 3: `recordBatch` runs
  // `assertProject` (404) BEFORE `metrics must be a non-empty array`, and its per-ENTRY rules
  // (`metricKey is required`, …) throw `ValidationError`, rendered as
  // `{ error, code: "VALIDATION_ERROR" }`. It is also the one rejected read whose OpenAPI body
  // is shapeless DESPITE a type argument — `CreateQualityMetricsRequest` is an imported
  // interface the generator cannot resolve — so it is the most valuable single conversion
  // left, for whoever is willing to move `assertProject` after the body check.
  "quality-metrics.ts": 1,
  // 1 = `PUT /:id`. REJECTED, family 5: untyped body forwarded whole, and its only check
  // (`Invalid cron expression: …`) runs after the existence lookup. `POST /` converted in
  // batch 4.
  "scheduled-runs.ts": 1,
  // 1 = `PATCH /:id`. REJECTED, family 5: `No fields to update` is decided after
  // `Tag not found` (404) and `Built-in tags cannot be modified` (403).
  "tags.ts": 1,
  // REJECTED, all four — this is the family that genuinely cannot use `parseJsonBody(c, schema)`:
  //   - `POST /incoming/land` and `/incoming/discard` throw `UnprocessableError` → **422**. A
  //     schema answers 400. Changing a documented status is not a hardening.
  //   - `POST /register` and `POST /:id/heartbeat` are the FLEET PROTOCOL. A malformed body is
  //     answered by the registry with `{ error, boardProtocolVersion }` at 401 / 409 / 422, and
  //     the worker daemon branches on that status to decide retry-vs-stop (#754). A 400 with a
  //     bare `{ error }` is invisible to that logic. They are also `parseOptionalJsonBody` sites
  //     whose contract really is "a body may be absent".
  "workers.ts": 4,
  // REJECTED, all four (families 1 + 2): `POST /templates`, `PUT /templates/:id` and
  // `POST /templates/import` hand every field to the workflow-template service, which answers
  // `{ error, errors[] }` — a second field `parseJsonBody` cannot produce — and `import`
  // passes the WHOLE raw body on as the template document. `POST /workspaces/:id/transition`
  // reads an untyped body and casts three optional strings out of it with no check at all.
  "workflows.ts": 4,
  // 6 = `POST /:id/launch`, `/implement-plan`, `/bisect`, `/reconcile-as-done`, `/fix-and-merge`
  // (all `parseOptionalJsonBody`) and `POST /:id/update-base` (`parseJsonBody(c)`). Batch 4
  // claimed every remaining entry carried a family and a reason; this one did not, and batch 5
  // audited all six rather than assuming. REJECTED, families 4 + 1: five have an OPTIONAL body
  // (`/launch` and `/fix-and-merge` are called with none by the monitor), which `parseJsonBody`
  // would answer `invalid JSON body` for, and every field any of them reads is a COERCION with
  // a default — `body.scope === "full" ? … : "related"`, `adoptMainCheckout === true`,
  // `body.mode === "merge" ? … : "rebase"` — so `{ mode: 7 }` is a live request meaning
  // "rebase". `/launch` additionally forwards the whole body to `launchSession` (family 2).
  "workspace-actions.ts": 6,
  // 1 = `POST /:id/review`. REJECTED, family 4: `thoroughReview` is read as
  // `body.thoroughReview === true` and the endpoint is called with no body at all by the UI.
  "workspace-review.ts": 1,
  // REJECTED, all three: `POST /` and `POST /preview` have exactly one body guard, and it is
  // inside `resolveIssueIdFromBody` — which reads the ACTIVE-PROJECT preference and the issues
  // table, and answers **404** for an issue number that does not exist. A schema can do
  // neither. `PATCH /:id` forwards an untyped body whole to `updateWorkspace` (family 2).
  "workspaces.ts": 3,
};

/** The total the baseline encodes — asserted separately so a mass edit cannot drift it silently. */
const BASELINE_TOTAL = 58;

describe("route request-body validation (#806)", () => {
  it("scans the real routes directory", () => {
    // A broken path would make every count 0 and the ratchet vacuously green.
    const files = walkPackageSources(routesDir);
    expect(files.length).toBeGreaterThan(40);
  });

  it("never grows the number of unvalidated request bodies, and shrinks when one is fixed", () => {
    const offenders = findUnvalidatedBodyReads();
    const current: Record<string, number> = {};
    for (const o of offenders) current[o.file] = (current[o.file] ?? 0) + 1;

    const { over, stale } = compareRatchet(BASELINE, current);

    const detail = (file: string): string =>
      offenders
        .filter((o) => o.file === file)
        .map((o) => `      ${o.file}:${o.line} ${o.call}`)
        .join("\n");

    expect(
      over,
      [
        "A route handler reads a request body it never checks.",
        "Give it a schema and pass it: `await parseJsonBody(c, mySchemaBody)`.",
        "Write the schema in a `*-body-schemas.ts` beside the route, using the predicates in",
        "`routes/body-schema-helpers.ts` — they exist so the guard's EXACT message and status",
        "survive the swap. A migration that lets the text drift is a contract change.",
        ...over.map((line) => `  ${line}\n${detail(line.split(":")[0]!)}`),
      ].join("\n"),
    ).toEqual([]);

    expect(
      stale,
      [
        "The baseline is now higher than reality — lower it in this file.",
        "A ratchet nobody lowers stops being a ceiling and becomes a budget the next",
        "regression hides inside.",
        ...stale.map((line) => `  ${line}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("keeps BASELINE_TOTAL in step with the per-file numbers", () => {
    const sum = Object.values(BASELINE).reduce((a, b) => a + b, 0);
    expect(sum).toBe(BASELINE_TOTAL);
  });
});
