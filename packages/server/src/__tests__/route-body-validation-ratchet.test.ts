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
 * (4 → 3) — and REJECTED seven more handlers, each recorded on its entry below. The remainder
 * is the disclosed one, per CLAUDE.md's partial-refactor rule — this file IS that disclosure.
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
 * Family 3 and family 4 can still fall the way `plugins.ts`'s error CLASS did — by restoring the
 * identity around the schema. Families 1 and 2 cannot: there is nothing left to check that would
 * not narrow what the endpoint accepts today.
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
  "approvals.ts": 2,
  "backlog-markdown.ts": 1,
  "backlog-snapshot.ts": 1,
  "board-monitor.ts": 2,
  "butler-definitions.ts": 2,
  "butler.ts": 6,
  "config-export-import.ts": 1,
  // 1 = `POST /:projectId/drive/preflight`. REJECTED: `autoRepair` is read as
  // `body.autoRepair === true` with no guard, so `{ autoRepair: "yes" }` is a valid request
  // today that means "no"; a schema would turn it into a 400. `PUT /:projectId/drive`
  // converted in batch 3.
  "drive.ts": 1,
  "drives.ts": 3,
  // 1 = `DELETE /pin`. REJECTED: it is a `parseOptionalJsonBody` site whose contract is that
  // an absent body still reaches its own `testName is required` 400; `parseJsonBody` would
  // answer `invalid JSON body` for that same request.
  "flaky-tests.ts": 1,
  "index.ts": 2,
  "issue-export-import.ts": 2,
  // 2 = `PATCH /:id` and `POST /:id/time-entries`, both REJECTED with reasons at the call
  // sites. `PATCH /:id` forwards an UNTYPED body whole to `updateIssue(id, Record<string,
  // unknown>)` — there is nothing to tighten to (the `PATCH /projects/:id` argument).
  // `POST /:id/time-entries`'s only guard is a coercion (`Number(body.minutes)` then
  // `Number.isInteger`), so `{"minutes":"30"}` succeeds today and a schema would 400 it;
  // nothing else in that body is checked, so a schema would be decoration.
  "issues.ts": 2,
  "milestones.ts": 2,
  // 5 = 2 install-side reads + 3 `parseOptionalJsonBody`. The other seven converted in batch 2.
  // `POST /api/plugins` and `POST /api/plugins/validate` are REJECTED, not deferred: their
  // `source` handling is a COERCION (`typeof body.source === "string" ? body.source : ""`), not a
  // check, and `validatePluginSource("")` answers **200** with `{ok:false, errors:["source is
  // required"]}`. A schema would turn `{source: 123}` from a 200 report into a 400 — a live
  // request broken to gain a type check the endpoint deliberately does not perform.
  "plugins.ts": 5,
  "preferences.ts": 5,
  "project-scripts.ts": 2,
  "project-stack-profile.ts": 1,
  // 4 = `POST /`, `POST /create`, `PATCH /:id`, and one `parseOptionalJsonBody`. All three
  // rejected with reasons in `project-body-schemas.ts`'s header; the short version is that
  // `PATCH /:id` has no declared body type to tighten TO and its only real check answers 422,
  // and the two POSTs forward the whole body to a service with its own guards, where a
  // declared-type tightening risks 400-ing a body (a `null` optional) that succeeds today.
  "projects.ts": 4,
  "quality-metrics.ts": 1,
  "scheduled-runs.ts": 2,
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
  "workflows.ts": 4,
  "workspace-actions.ts": 6,
  "workspace-review.ts": 1,
  "workspaces.ts": 3,
};

/** The total the baseline encodes — asserted separately so a mass edit cannot drift it silently. */
const BASELINE_TOTAL = 70;

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
