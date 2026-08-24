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
 * conversions. The remainder is the disclosed one, per CLAUDE.md's partial-refactor rule —
 * this file IS that disclosure.
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
 *      look validated. `issues.ts PATCH /:id`, `projects.ts PATCH /:id`, all three unconverted
 *      `agent-skills.ts` reads.
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
 *      the FIRST statement, so moving it to the boundary re-orders nothing.
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
  // 3 = `POST /`, `PUT /:id`, `POST /:id/install`. REJECTED, not deferred: none of the three
  // has a guard — each forwards the WHOLE body to `agentSkillService`, which owns the field
  // rules. `POST /enhance`, the one with a real `name is required` guard, converted in batch 3.
  "agent-skills.ts": 3,
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
  // 2 = `POST /` and `PUT /:bid`. REJECTED, family 1: `provider` is read through a ternary
  // that maps anything unrecognised to `undefined`, and `name` through `body.name ?? ""` —
  // both coercions, so `{ provider: 7 }` is a valid request today. The real guards live in
  // `butler-definitions.service.ts`, behind the MAX_BUTLERS / name rules.
  "butler-definitions.ts": 2,
  // 3 = `POST /:id/butler/model`, `POST /:id/butler/profile`, `PUT /:id/butler/skill`. The
  // other three converted in batch 4. REJECTED, not deferred — see the header of
  // `routes/butler-body-schemas.ts`: `model` is normalised, `profile` is `(x ?? "").trim()`,
  // and `skill`'s `!body.prompt?.trim()` is a BRANCH (an empty prompt DELETES the override and
  // answers 200), so a schema there would 400 the documented way to revert to the default.
  "butler.ts": 3,
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
  // 4 = `POST /`, `POST /create`, `PATCH /:id`, and one `parseOptionalJsonBody`. All three
  // rejected with reasons in `project-body-schemas.ts`'s header; the short version is that
  // `PATCH /:id` has no declared body type to tighten TO and its only real check answers 422,
  // and the two POSTs forward the whole body to a service with its own guards, where a
  // declared-type tightening risks 400-ing a body (a `null` optional) that succeeds today.
  "projects.ts": 4,
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
const BASELINE_TOTAL = 64;

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
