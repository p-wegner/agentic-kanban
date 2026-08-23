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
 * Landed in #806's batch (19 handlers, 120 → 101): `codemods.ts` (3, and `POST /apply` WRITES
 * FILES using `projectId` as its security boundary), `projects.ts` (9), `workspace-actions.ts`
 * (5), `tags.ts` (2). The remaining 101 are the disclosed remainder, per CLAUDE.md's
 * partial-refactor rule — this file IS that disclosure.
 *
 * **Two families in the remainder are NOT mechanical**, and a later batch should not assume
 * they are:
 *   - `plugins.ts` (12) and `workers.ts` (4) throw `PluginError` / `UnprocessableError`, not the
 *     `c.json({error}, 400)` that `parseJsonBody`'s `HTTPException` reproduces. `workers.ts`
 *     answers **422**. Routing those through a schema changes the status code.
 *   - Many `plugins.ts` guards read `body.projectId ?? c.req.query("projectId")` — a field that
 *     is optional in the BODY but required overall. No body schema can express that.
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
  "agent-questions.ts": 1,
  "agent-skills.ts": 4,
  "approvals.ts": 2,
  "backlog-markdown.ts": 1,
  "backlog-snapshot.ts": 1,
  "board-monitor.ts": 2,
  "butler-definitions.ts": 2,
  "butler.ts": 6,
  "config-export-import.ts": 1,
  "drive-obstacles.ts": 1,
  "drive.ts": 2,
  "drives.ts": 3,
  "failure-patterns.ts": 2,
  "flaky-tests.ts": 3,
  "index.ts": 2,
  "issue-export-import.ts": 2,
  "issues.ts": 12,
  "merge-queue.ts": 1,
  "milestones.ts": 2,
  "plugins.ts": 12,
  "preferences.ts": 5,
  "project-analytics.ts": 1,
  "project-scripts.ts": 2,
  "project-stack-profile.ts": 1,
  "projects.ts": 6,
  "quality-metrics.ts": 1,
  "scheduled-runs.ts": 2,
  "showdowns.ts": 1,
  "tags.ts": 1,
  "voice-capture.ts": 1,
  "workers.ts": 4,
  "workflows.ts": 4,
  "workspace-actions.ts": 6,
  "workspace-review.ts": 1,
  "workspaces.ts": 3,
};

/** The total the baseline encodes — asserted separately so a mass edit cannot drift it silently. */
const BASELINE_TOTAL = 101;

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
