/**
 * apiResponseSchemas.ts — the RUNTIME half of the client<->server wire contract (#780).
 *
 * The problem
 * -----------
 * The client and server agree on ~75 DTOs shared through `@agentic-kanban/shared`, but
 * `shared/src/types/api.ts` is `export type *` BY DESIGN — it must stay purely type-only so
 * importing it can never pull server code into the client bundle. A type-only declaration is
 * erased before either process starts, so the agreement held at compile time and nowhere
 * else, and `api.ts` finished with `res.json() as T`: an assertion, not a check. A renamed
 * or dropped field produced the wrong shape with full type-system confidence and surfaced
 * later and elsewhere as an `undefined` inside a component.
 *
 * Why HERE and not in `shared/src/lib`
 * ------------------------------------
 * That is where this module started. `shared-lib-single-consumer-ratchet.test.ts` (#730)
 * correctly rejected it: `shared/lib` is for code more than one package needs, and today
 * exactly one package needs this — the client is the only side that parses responses.
 * Grandfathering it would have been special pleading for a rule that exists because 31
 * modules already drifted that way. It moves to `shared/` the day the server validates its
 * own responses (step 3 of #780), which is when it genuinely has two consumers.
 *
 * Why no zod
 * ----------
 * `zod` is a dependency of `shared`, not of `client`, and this boundary does not need it:
 * the combinators below are ~60 lines, add nothing to the bundle, and are PASSTHROUGH by
 * construction. That last point is not a style preference — zod's `z.object()` STRIPS
 * unknown keys by default, so a non-`.passthrough()` schema at this choke point would
 * silently delete every field it had not thought to name, turning a validator into a
 * data-loss bug. Here there is no such default to forget.
 *
 * How it is wired
 * ---------------
 * Keyed by METHOD + PATH TEMPLATE, not by call site. Every client response already funnels
 * through `apiFetch`, so registering an endpoint validates all of its existing call sites at
 * once — ~200 call sites did not have to be edited, and a new caller is covered the day it
 * is written.
 *
 * Scope, stated plainly: 49 method+path pairs of the 257 the client calls — 208 remain. It is
 * NOT the whole surface. An unregistered
 * path is returned unchecked through the single named seam in `apiFetch`
 * (`unvalidatedResponse`). `API_RESPONSE_SCHEMA_COUNT` is the number to quote.
 *
 * The number that says how far this has to go is NOT 352 (the operations in the generated
 * OpenAPI spec — most of which only the MCP server, the CLI or a fleet worker ever calls, and
 * which nothing here can cover, because this registry only runs inside `apiFetch`). It is the
 * 257 method+path pairs the CLIENT actually calls, derived from source by
 * `__tests__/api-response-validation-ratchet.test.ts`. That suite is shrink-only: every
 * endpoint not registered here is written down in its baseline, a new unregistered endpoint
 * fails it, and a baseline line whose endpoint has since been registered fails it too. The
 * registry sat at #780's original 17 for five #806 batches precisely because no such gate
 * existed; do not add an endpoint to the client without answering to it.
 *
 * Schemas assert the INVARIANTS THE CLIENT CONSUMES, not whole DTOs: the fields a caller
 * would crash on, at the loosest type that is still meaningful (`str` for an id, not an
 * enum of ids). Two consequences worth stating, because both look like under-checking:
 *
 *  - A field the server returns and no client code reads is deliberately NOT asserted. A
 *    schema stricter than what the UI depends on turns an irrelevant server change into a
 *    boundary error, and a false alarm is how a gate gets deleted.
 *  - The CREATE endpoints therefore check less than the READ next to them: `POST
 *    /api/workspaces` guarantees a handle, `GET /api/workspaces/:id` guarantees the shape
 *    the panels render.
 */
import type { ProjectResponse } from "@agentic-kanban/shared/types";
import type { WorkspaceResponse } from "@agentic-kanban/shared/types";
import type { IssueComment } from "@agentic-kanban/shared/types";
import type { ProjectRepoResponse } from "@agentic-kanban/shared/types";
import type { RepoMergeStatusResponse } from "@agentic-kanban/shared/types";
import type { StatusWithIssues, IssueWithStatus } from "@agentic-kanban/shared/types";
import type { DiffResponse, DiffStatsResponse } from "@agentic-kanban/shared/types";
import type { ScorecardResult } from "@agentic-kanban/shared/types";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ───────────────────────── Minimal validator combinators ─────────────────────────

/** A field check. Appends a human-readable problem to `issues` and returns nothing. */
export interface Check<T> {
  readonly _t?: T;
  check(value: unknown, path: string, issues: string[]): void;
}

function primitive<T>(name: string, ok: (v: unknown) => boolean): Check<T> {
  return {
    check(value, path, issues) {
      if (!ok(value)) issues.push(`${path}: expected ${name}, got ${describe(value)}`);
    },
  };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export const str = primitive<string>("string", (v) => typeof v === "string");
export const num = primitive<number>("number", (v) => typeof v === "number");
export const bool = primitive<boolean>("boolean", (v) => typeof v === "boolean");
export const trueLiteral = primitive<true>("true", (v) => v === true);

export function nullable<T>(inner: Check<T>): Check<T | null> {
  return {
    check(value, path, issues) {
      if (value === null) return;
      inner.check(value, path, issues);
    },
  };
}

export function arrayOf<T>(inner: Check<T>): Check<T[]> {
  return {
    check(value, path, issues) {
      if (!Array.isArray(value)) {
        issues.push(`${path}: expected array, got ${describe(value)}`);
        return;
      }
      value.forEach((item, i) => inner.check(item, `${path}[${i}]`, issues));
    },
  };
}

/**
 * The value is an ARRAY; its elements are not checked (#806 batch 2).
 *
 * The honest way to say "this endpoint answers a list of things whose element shape no
 * caller depends on structurally". `arrayOf(nested(...))` is the stricter option and is used
 * where the elements ARE destructured; reaching for this one instead is a deliberate choice,
 * not a shortcut — a `comments: DiffComment[]` the diff panel only maps over by id gains
 * nothing from ten per-element field checks, and each one is a way for an unrelated server
 * change to redden a boundary the UI does not actually depend on.
 */
function anyArray<T = unknown>(): Check<T[]> {
  return primitive<T[]>("array", (v) => Array.isArray(v));
}

/**
 * An {@link ObjectSchema} used as a FIELD check, so schemas can nest (#806 batch 2).
 *
 * `arrayOf` takes a `Check`, and until now the only `Check`s were primitives — which is why
 * the registry could describe a list of scalars but not a list of records, nor an object with
 * an object inside it. `GET /api/projects/:id/board` is exactly that shape (columns holding
 * issues), and it is the single most load-bearing read in the app.
 *
 * Nested problems are reported with the outer path prefixed, so a failure names
 * `issues[3].id` rather than a bare `id` whose owner is anyone's guess.
 */
function nested<T = unknown>(schema: ObjectSchema): Check<T> {
  return {
    check(value, path, issues) {
      const inner: string[] = [];
      schema.validate(value, inner);
      for (const issue of inner) issues.push(`${path}.${issue}`);
    },
  };
}

/** A schema is a set of field checks over an object. Unknown keys always pass through. */
export interface ObjectSchema {
  readonly fields: Record<string, Check<unknown>>;
  validate(value: unknown, issues: string[]): void;
}

function objectSchema(fields: Record<string, Check<unknown>>): ObjectSchema {
  return {
    fields,
    validate(value, issues) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        issues.push(`<root>: expected object, got ${describe(value)}`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const [key, check] of Object.entries(fields)) {
        if (!(key in record)) {
          issues.push(`${key}: missing`);
          continue;
        }
        check.check(record[key], key, issues);
      }
    },
  };
}

/**
 * An object schema whose field types are CHECKED AGAINST THE DTO at compile time: a field
 * the DTO does not declare is an excess-property error, and a field declared `string`
 * cannot be given `num`. That link is what makes these schemas track the types instead of
 * drifting away from them — without it this file becomes the second stale artifact #780 is
 * about. Naming a SUBSET of the DTO's fields is allowed and expected; naming a field that
 * is not on it is not.
 */
function dtoObject<T>(shape: { [K in keyof T]?: Check<T[K]> }): ObjectSchema {
  return objectSchema(shape as Record<string, Check<unknown>>);
}

/** For responses with no shared DTO (server-internal projections, `{ success: true }`). */
function looseObject(shape: Record<string, Check<unknown>>): ObjectSchema {
  return objectSchema(shape);
}

/**
 * A response whose ROOT is a JSON array of objects (#806).
 *
 * `objectSchema` rejects an array outright, so before this existed the registry could not
 * describe a list endpoint at all — and list endpoints are most of the client's reads. That
 * limitation is a large part of why the registry stopped at the mutating endpoints of three
 * resources: not a judgement that lists did not matter, but that there was nothing to write.
 *
 * Each element is checked with the element schema and reported by index, so a single bad row
 * in a long list names its position instead of failing anonymously.
 */
function arrayRoot(item: ObjectSchema): ObjectSchema {
  return {
    fields: {},
    validate(value, issues) {
      if (!Array.isArray(value)) {
        issues.push(`<root>: expected array, got ${describe(value)}`);
        return;
      }
      value.forEach((element, index) => {
        const elementIssues: string[] = [];
        item.validate(element, elementIssues);
        for (const issue of elementIssues) issues.push(`[${index}].${issue}`);
      });
    },
  };
}

/** Accepts a value matching ANY arm; reports every arm's problems when none matches. */
function union(...arms: ObjectSchema[]): ObjectSchema {
  return {
    fields: {},
    validate(value, issues) {
      const perArm = arms.map((arm) => {
        const armIssues: string[] = [];
        arm.validate(value, armIssues);
        return armIssues;
      });
      if (perArm.some((a) => a.length === 0)) return;
      perArm.forEach((a, i) => issues.push(`(alternative ${i + 1}) ${a.join(", ")}`));
    },
  };
}

// ───────────────────────── The schemas ─────────────────────────

/**
 * What `POST /api/issues`, `PATCH /api/issues/:id` and `POST /api/issues/:id/duplicate`
 * return: `CreateIssueResult` — a server-internal projection (`getIssueDescription`), not
 * `IssueWithStatus`. There is no shared DTO to bind to, hence `looseObject`.
 */
const issueRow = looseObject({
  id: str,
  title: str,
});

const issueComment = dtoObject<IssueComment>({
  id: str,
  issueId: str,
  workspaceId: nullable(str),
  author: str,
  body: str,
  createdAt: str,
});

const workspace = dtoObject<WorkspaceResponse>({
  id: str,
  issueId: str,
  branch: str,
  status: str,
  workingDir: nullable(str),
  createdAt: str,
});

/**
 * `POST /api/workspaces` answers TWO ways and `as T` could not tell them apart: 201 with the
 * workspace, or 202 with a create-job handle when creation is backgrounded
 * (`routes/workspaces.ts`). Stating that as a union is exactly what a compile-time-only
 * contract could never do.
 */
const workspaceOrCreateJob = union(
  // The CREATE response's client-facing contract is "a workspace handle": every caller
  // reads `id` (and optionally `sessionId`). The full-shape check belongs on the READ,
  // `GET /api/workspaces/:id`, which is where a caller actually renders the fields.
  looseObject({ id: str }),
  looseObject({ accepted: trueLiteral, jobId: str, statusUrl: str }),
);

const project = dtoObject<ProjectResponse>({
  id: str,
  name: str,
  repoPath: str,
  createdAt: str,
});

/** `{ id, name }` is all the register/create endpoints are contractually required to give. */
const projectHandle = looseObject({ id: str, name: str });

const successFlag = looseObject({ success: bool });
const sessionHandle = looseObject({ sessionId: str });

/** `{ id }` — every service that answers a mutation with a bare handle (`archiveProject`,
 *  `updateTagById`, …). Named rather than repeated so the registry reads as the census of
 *  "this endpoint tells you nothing but the id" that it is. */
const idHandle = looseObject({ id: str });

// ── #806 batch 1: tags, issue tags/dependencies, workspace lifecycle, project list ──

/**
 * `GET /api/tags` — `tagService.listTags()` is `select().from(tags)`, so a row is the
 * `tags` table (`shared/src/schema/tags.ts`): `id`, `name`, `color` nullable, `isBuiltin`,
 * `createdAt`. The four the settings panel renders are asserted; `createdAt` is returned and
 * read by nobody, and per this module's convention an unread field is deliberately not
 * checked.
 */
const tagRow = looseObject({ id: str, name: str, color: nullable(str), isBuiltin: bool });

/**
 * `POST /api/tags` answers `createTag`'s `{ id, name, color }` — WITHOUT `isBuiltin`, which
 * `TagsSettings` supplies itself (`{ ...created, isBuiltin: false }`). Asserting the read
 * shape here would have been the "schema stricter than the response" mistake.
 */
const createdTag = looseObject({ id: str, name: str, color: nullable(str) });

/** `POST /api/tags/merge` → `{ success: true, ...{ merged } }` (`routes/tags.ts`). */
const tagMergeResult = looseObject({ success: bool, merged: num });

/** `POST /api/issues/:id/dependencies` → `{ id, type }` — the route projects exactly two
 *  fields out of the service result (`routes/issues.ts`). */
const dependencyHandle = looseObject({ id: str, type: str });

/**
 * `POST /api/workspaces/:id/turn` answers TWO ways, and only ONE of them carries a session:
 * `{ ok: true }` at 200 when the turn was delivered to the running agent, or
 * `{ sessionId, resumed: true }` at 201 when a stopped agent had to be resumed
 * (`routes/workspace-actions.ts`). The client types it as three OPTIONAL fields and then
 * branches on `result.resumed && result.sessionId` — correct, but a shape in which "no
 * session and not resumed" and "resumed with no session" are equally legal. The union states
 * which pairs actually occur.
 */
const turnResult = union(looseObject({ ok: trueLiteral }), looseObject({ sessionId: str, resumed: trueLiteral }));

/** `POST /api/workspaces/:id/stop` and `/quarantine` → `{ stopped: boolean }`
 *  (`workspace-session.service.ts`). */
const stoppedFlag = looseObject({ stopped: bool });

/** `POST /api/workspaces/:id/close` → `{ id, status: "closed" }`
 *  (`workspace-crud.service.ts`). `str`, not the literal: this module asserts at the loosest
 *  type that is still meaningful, and no caller reads the status. */
const closedWorkspace = looseObject({ id: str, status: str });

// ── #806 batch 2: the deep READS — the board, the issue panel, the diff, the lists ──
//
// Batch 1 registered mutations, which mostly answer a handle: a wrong shape there fails
// loudly and immediately (a button does nothing). These are the opposite end — responses the
// client destructures several levels down and then RENDERS. A dropped field in one of them
// does not throw where it happened; it arrives as an `undefined` inside a component, and the
// screen goes blank or silently empty with no line number pointing at the wire. That is the
// failure mode #780 exists to convert into a boundary error, so it is where the next batch
// is worth spending.
//
// Every shape below was read off the SERVER handler (route file → service → repository
// projection), not inferred from how the client happens to use it — inferring from the
// consumer is how a schema ends up asserting a field the server never promised.

/**
 * A board issue, as `buildBoardColumns` emits it (`server/src/lib/board-view.ts`): the issue
 * row spread wholesale, plus `tags` and an optional `checklist`.
 *
 * Only the four fields whose absence breaks the CARD are asserted. `IssueWithStatus` declares
 * a dozen more — `issueNumber`, `statusName`, `priority`, `workspaceSummary`, … — and several
 * are genuinely optional or absent on the slim projection, so asserting them would make an
 * ordinary server-side narrowing look like a contract break.
 */
const boardIssue = looseObject({ id: str, title: str, statusId: str, projectId: str });

/**
 * `GET /api/projects/:id/board` → `StatusWithIssues[]`.
 *
 * **The most load-bearing read in the app.** Every column, every card and the whole drag
 * target derive from it, so a shape change here does not break one panel — it empties the
 * board, which reads to the user as "my tickets are gone" rather than as a bug. It is also
 * the response most likely to change shape, because it is assembled (statuses joined to
 * issues joined to workspace summaries) rather than returned from one query.
 *
 * Answered through an ETag fast path, so a 304 never reaches a schema; only a 200 body is
 * checked, which is exactly right — the 304 branch returns the PREVIOUS body, already checked
 * when it was a 200.
 */
const boardColumn = dtoObject<StatusWithIssues>({
  id: str,
  name: str,
  projectId: str,
  sortOrder: num,
  count: num,
  issues: arrayOf(nested<IssueWithStatus>(boardIssue)),
});

/**
 * `GET /api/projects/:id/statuses` → the `project_statuses` rows (`getProjectStatuses`, a
 * bare `select()`), so the four NOT NULL columns the workflow builder and the
 * backlog-markdown lookups read are guaranteed. `isDefault`/`createdAt` are returned and read
 * by nobody here.
 */
const projectStatus = looseObject({ id: str, name: str, projectId: str, sortOrder: num });

/**
 * `GET /api/projects/:id/repos` → `toProjectRepoResponse` (`routes/projects.ts`), which
 * builds the DTO field by field — so unlike most list endpoints this one's shape is stated in
 * the route rather than inherited from a table. `name` and `defaultBranch` are genuinely
 * `string | null` on the DTO and in the column; modelling them as plain `str` would have
 * reddened every project whose sibling repo has no configured branch.
 */
const projectRepo = dtoObject<ProjectRepoResponse>({
  id: str,
  projectId: str,
  path: str,
  name: nullable(str),
  defaultBranch: nullable(str),
  createdAt: str,
});

/**
 * `GET /api/projects/all/workspaces` → one group per project
 * (`projectService.getCrossProjectWorkspaces`). The group header is what the All-Workspaces
 * panel renders and navigates by; the issues inside carry a `workspaceSummary` whose shape is
 * the summary cache's, checked no further than "it is a list".
 */
const crossProjectGroup = looseObject({ projectId: str, projectName: str, issues: anyArray() });

/**
 * `GET /api/issues` → `getIssuesByProject`'s rows. TWO projections answer this path —
 * `?slim=1` drops `description` — so only the columns present in BOTH are asserted. That is
 * the same reasoning as the diff union below, arrived at from the other direction: where the
 * variants differ in one optional field, the intersection is enough; where they are different
 * shapes, it takes a union.
 */
const issueListRow = looseObject({ id: str, title: str, statusId: str, projectId: str });

/**
 * `GET /api/issues/:id/detail-bundle` (#418) → the ONE request behind the whole issue panel.
 *
 * Its twelve fields are each a `Promise.all` arm with `.catch(() => …)`, so the failure modes
 * are already distinguished by the server: six arms fall back to `null`, five to `[]`, and
 * `activity` to `{ events: [] }`. Only the arms with a NON-null fallback are asserted —
 * `dependencies`, `cycleTime`, `timeEntries`, `touchedFiles`, `relatedIssues` and
 * `mergedCommits` are legitimately `null` on a healthy response, and the client's own props
 * are typed `T | null` to match. Asserting them would turn a caught server-side error into a
 * blank panel, which is precisely the outcome this file exists to prevent.
 */
const issueDetailBundle = looseObject({
  issue: nested(looseObject({ id: str, title: str })),
  workspaces: anyArray(),
  tags: anyArray(),
  artifacts: anyArray(),
  comments: anyArray(),
  activity: nested(looseObject({ events: anyArray() })),
});

/** The `{ filesChanged, insertions, deletions }` triple, shared by both diff variants. */
const diffStatsTriple = looseObject({ filesChanged: num, insertions: num, deletions: num });

/**
 * `GET /api/workspaces/:id/diff` answers TWO DIFFERENT SHAPES on ONE path, selected by the
 * `?stats=1` query parameter (#415) — and the registry is keyed by method+path, with the
 * query deliberately stripped. So this is the case the module header calls out as possibly
 * un-schematisable ("a shape that varies by query parameter"), and it turns out to be
 * schematisable after all: the two variants are a union, exactly like `POST /api/workspaces`'s
 * 201-or-202. Worth stating, because the alternative was a baseline line with a reason,
 * permanently exempting the response four panels destructure most deeply.
 *
 * The full variant additionally carries `conflicts` and (multi-repo only) `repos`, and the
 * route may spread a `remoteMidSession` beside either — all passthrough, none asserted.
 */
const workspaceDiff = union(
  dtoObject<DiffResponse>({
    diff: str,
    stats: nested<DiffResponse["stats"]>(diffStatsTriple),
    comments: anyArray(),
  }),
  dtoObject<DiffStatsResponse>({
    stats: nested<DiffStatsResponse["stats"]>(diffStatsTriple),
    repos: anyArray(),
  }),
);

/**
 * `GET /api/workspaces/:id/sessions` → the `sessions` rows (a bare `select()`) with a
 * `skillName` attached. The four NOT NULL columns the timeline keys and orders by are
 * asserted; `endedAt`/`exitCode`/`pid` are nullable by schema and stay unchecked.
 */
const sessionRow = looseObject({ id: str, workspaceId: str, status: str, startedAt: str });

/**
 * `GET /api/workspaces/:id/repo-merge-status` → `RepoMergeStatusResponse` (#70/#168). The
 * strip's headline is `allMerged`, and a missing boolean reads as `false` — so this endpoint
 * silently claims "not merged" rather than failing, the quiet failure mode this ratchet's
 * whole premise is about. `branch` is `string | null` on the DTO; `installSummary` is optional
 * (`tracked: 0` is the inline-install default) and is not asserted.
 */
const repoMergeStatus = dtoObject<RepoMergeStatusResponse>({
  branch: nullable(str),
  baseBranch: str,
  allMerged: bool,
  repos: anyArray(),
});

// ── #806 batch 3: the slow-request panel, the scorecard, and the attempt comparison ──

/**
 * `GET /api/metrics/slow-requests` → `{ entries: SlowRequestEntry[] }`
 * (`SlowRequestsPanel.tsx`, no shared DTO — a server-internal ring buffer projection).
 * All four fields on `SlowRequestEntry` are rendered by the panel, so all four are asserted.
 */
const slowRequestsResult = looseObject({
  entries: arrayOf(
    nested(looseObject({ method: str, path: str, durationMs: num, timestamp: str })),
  ),
});

/**
 * `GET /api/workspaces/:id/scorecard` → `ScorecardResult` (`shared/types/api/scorecard.ts`).
 * `WorkspaceScorecardPanel` reads all three top-level fields and, per dimension, `name`,
 * `score`, `maxScore` and `signal` — the full DTO, so the nested check names every field too.
 */
const scorecardResult = dtoObject<ScorecardResult>({
  total: num,
  computedAt: str,
  dimensions: arrayOf(
    nested<ScorecardResult["dimensions"][number]>(
      looseObject({ name: str, score: num, maxScore: num, signal: str }),
    ),
  ),
});

/**
 * `GET /api/issues/:id/workspaces` → `getEnrichedWorkspaces` (`issue.service.ts`): the
 * workspace row spread wholesale, plus computed `diffStats`/`scorecard`/`sessionStatus`/
 * `lastSessionAt`. Two client types bind to this one path — `CompareAttemptsPanel`'s
 * `WorkspaceAttempt[]` (destructures all fields below) and `WorkspacePanel`'s
 * `WorkspaceResponse[]` (destructures only `id`/`status`/`workingDir` of the row). The schema
 * covers the union actually read; `pendingPlanPath` and `serviceState` are genuinely optional
 * on this projection (checked with `=== undefined`) and stay unasserted per this file's rule
 * against asserting a field whose absence is not a bug.
 */
const workspaceAttempt = looseObject({
  id: str,
  branch: str,
  status: str,
  createdAt: str,
  workingDir: nullable(str),
  mergedAt: nullable(str),
  closedAt: nullable(str),
  diffStats: nullable(nested(looseObject({ filesChanged: num, insertions: num, deletions: num }))),
  scorecard: nullable(nested(looseObject({ score: num }))),
  sessionStatus: nullable(str),
  lastSessionAt: nullable(str),
});

export interface ApiResponseRoute {
  method: ApiMethod;
  /** Express-style template with `:param` segments, matched against the request path. */
  template: string;
  schema: ObjectSchema;
}

/**
 * Declaration order does not matter: matching requires the same segment COUNT, so
 * `/api/issues/:id` cannot swallow `/api/issues/:id/duplicate`, and where two entries could
 * both match, `findApiResponseSchema` prefers the one with more literal segments.
 */
export const API_RESPONSE_SCHEMAS: readonly ApiResponseRoute[] = [
  // ── issues ──
  { method: "POST", template: "/api/issues", schema: issueRow },
  { method: "PATCH", template: "/api/issues/:id", schema: issueRow },
  { method: "DELETE", template: "/api/issues/:id", schema: successFlag },
  { method: "POST", template: "/api/issues/:id/duplicate", schema: issueRow },
  { method: "POST", template: "/api/issues/:id/comments", schema: issueComment },
  { method: "PUT", template: "/api/issues/:id/repos-touched", schema: looseObject({ reposTouched: arrayOf(str) }) },

  // ── workspaces ──
  { method: "POST", template: "/api/workspaces", schema: workspaceOrCreateJob },
  { method: "GET", template: "/api/workspaces/:id", schema: workspace },
  // NOT `workspace`: PATCH answers with `{ id }` alone (`workspace-crud.service.ts:273`),
  // which the client has been asserting as a full `WorkspaceResponse` for as long as the
  // cast existed. Found while writing this registry — the first thing it caught.
  { method: "PATCH", template: "/api/workspaces/:id", schema: looseObject({ id: str }) },
  { method: "POST", template: "/api/workspaces/:id/launch", schema: sessionHandle },
  // Registered in `startup/route-setup.ts`, not `src/routes/` — which is why the OpenAPI
  // generator cannot see it at all. Noted as a follow-up on #780.
  { method: "POST", template: "/api/workspaces/:id/review", schema: sessionHandle },
  { method: "POST", template: "/api/workspaces/:id/fix-and-merge", schema: sessionHandle },
  { method: "POST", template: "/api/workspaces/:id/resolve-conflicts", schema: sessionHandle },

  // ── projects ──
  { method: "POST", template: "/api/projects", schema: projectHandle },
  { method: "POST", template: "/api/projects/create", schema: projectHandle },
  { method: "PATCH", template: "/api/projects/:id", schema: project },
  { method: "DELETE", template: "/api/projects/:id", schema: successFlag },

  // ── tags (#806 batch 1) ──
  { method: "GET", template: "/api/tags", schema: arrayRoot(tagRow) },
  { method: "POST", template: "/api/tags", schema: createdTag },
  // Like `PATCH /api/workspaces/:id`, this answers with `{ id }` alone
  // (`tag.service.ts:updateTagById`) — not the updated tag. No caller reads the result here,
  // so unlike the workspaces case there is no bug to report, only a contract to pin.
  { method: "PATCH", template: "/api/tags/:id", schema: idHandle },
  { method: "DELETE", template: "/api/tags/:id", schema: successFlag },
  { method: "POST", template: "/api/tags/merge", schema: tagMergeResult },

  // ── issue tags & dependencies (#806 batch 1) ──
  { method: "POST", template: "/api/issues/:id/tags", schema: idHandle },
  { method: "DELETE", template: "/api/issues/:id/tags/:tagId", schema: successFlag },
  { method: "POST", template: "/api/issues/:id/dependencies", schema: dependencyHandle },
  { method: "DELETE", template: "/api/issues/:id/dependencies/:depId", schema: successFlag },

  // ── workspace lifecycle (#806 batch 1) ──
  { method: "DELETE", template: "/api/workspaces/:id", schema: successFlag },
  { method: "POST", template: "/api/workspaces/:id/turn", schema: turnResult },
  { method: "POST", template: "/api/workspaces/:id/stop", schema: stoppedFlag },
  { method: "POST", template: "/api/workspaces/:id/quarantine", schema: stoppedFlag },
  { method: "POST", template: "/api/workspaces/:id/close", schema: closedWorkspace },
  { method: "POST", template: "/api/workspaces/:id/implement-plan", schema: sessionHandle },
  { method: "POST", template: "/api/workspaces/:id/reject-plan", schema: sessionHandle },

  // ── projects, the list and the archive pair (#806 batch 1) ──
  // The project list is the one read every view depends on; a wrong shape here empties the
  // switcher rather than one panel. `routes/projects.ts` answers `ProjectResponse[]` (through
  // `conditionalJsonResponse`, so a 304 never reaches a schema).
  { method: "GET", template: "/api/projects", schema: arrayRoot(project) },
  { method: "POST", template: "/api/projects/:id/archive", schema: idHandle },
  { method: "POST", template: "/api/projects/:id/unarchive", schema: idHandle },

  // ── the deep reads (#806 batch 2) ──
  { method: "GET", template: "/api/projects/:id/board", schema: arrayRoot(boardColumn) },
  { method: "GET", template: "/api/projects/:id/statuses", schema: arrayRoot(projectStatus) },
  { method: "GET", template: "/api/projects/:id/repos", schema: arrayRoot(projectRepo) },
  // `all` is a LITERAL segment, not a project id. It has the same segment count as
  // `/:id/statuses`, and `findApiResponseSchema` prefers the more literal template — but the
  // last segments differ anyway, so neither can shadow the other.
  { method: "GET", template: "/api/projects/all/workspaces", schema: arrayRoot(crossProjectGroup) },
  { method: "GET", template: "/api/issues", schema: arrayRoot(issueListRow) },
  { method: "GET", template: "/api/issues/:id/detail-bundle", schema: issueDetailBundle },
  // The list is `listWorkspacesSlim`'s projection, which happens to be a superset of exactly
  // the fields `GET /api/workspaces/:id` guarantees — so the element schema is the same one.
  { method: "GET", template: "/api/workspaces", schema: arrayRoot(workspace) },
  { method: "GET", template: "/api/workspaces/:id/diff", schema: workspaceDiff },
  { method: "GET", template: "/api/workspaces/:id/sessions", schema: arrayRoot(sessionRow) },
  { method: "GET", template: "/api/workspaces/:id/repo-merge-status", schema: repoMergeStatus },

  // ── #806 batch 3 ──
  { method: "GET", template: "/api/metrics/slow-requests", schema: slowRequestsResult },
  { method: "GET", template: "/api/workspaces/:id/scorecard", schema: scorecardResult },
  { method: "GET", template: "/api/issues/:id/workspaces", schema: arrayRoot(workspaceAttempt) },
];

export const API_RESPONSE_SCHEMA_COUNT = API_RESPONSE_SCHEMAS.length;

// ───────────────────────── Lookup ─────────────────────────

interface CompiledRoute extends ApiResponseRoute {
  segments: string[];
  literalCount: number;
}

const compiled: CompiledRoute[] = API_RESPONSE_SCHEMAS.map((r) => {
  const segments = r.template.split("/").filter(Boolean);
  return { ...r, segments, literalCount: segments.filter((s) => !s.startsWith(":")).length };
});

function matchTemplate(route: CompiledRoute, segments: string[]): boolean {
  if (route.segments.length !== segments.length) return false;
  return route.segments.every((s, i) => s.startsWith(":") || s === segments[i]);
}

/**
 * Resolve the schema for one request, or `undefined` when the endpoint is not covered.
 * Query string and hash are ignored; a relative or absolute URL both work (the desktop
 * build talks to the API on another origin).
 */
export function findApiResponseSchema(method: string, path: string): ObjectSchema | undefined {
  const upper = method.toUpperCase();
  const withoutQuery = path.split(/[?#]/)[0] ?? path;
  const pathname = /^[a-z][a-z0-9+.-]*:\/\//i.test(withoutQuery)
    ? withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
    : withoutQuery;
  const segments = pathname.split("/").filter(Boolean);

  let best: CompiledRoute | undefined;
  for (const route of compiled) {
    if (route.method !== upper) continue;
    if (!matchTemplate(route, segments)) continue;
    if (!best || route.literalCount > best.literalCount) best = route;
  }
  return best?.schema;
}

/**
 * Thrown when a response does not match the schema registered for its endpoint. A distinct
 * class so a caller — or a test — can tell "the server said no" (`apiFetch`'s HTTP error)
 * from "the server said something we do not understand", which used to be indistinguishable
 * because the second case did not exist: it was a cast that always succeeded.
 */
export class ApiContractError extends Error {
  readonly method: string;
  readonly path: string;
  readonly issues: string[];

  constructor(method: string, path: string, issues: string[]) {
    super(
      `API contract violation: ${method.toUpperCase()} ${path} returned a response that does not match its schema` +
        (issues.length ? ` — ${issues.join("; ")}` : ""),
    );
    this.name = "ApiContractError";
    this.method = method.toUpperCase();
    this.path = path;
    this.issues = issues;
  }
}

/**
 * Validate `value` against the schema registered for `method`+`path`.
 *
 * Returns `{ validated: false }` when the endpoint is not covered — the caller then decides
 * what to do with an unchecked body, which keeps "we did not check this" a visible decision
 * at ONE place rather than an invisible `as T` at every call site.
 */
export function parseApiResponse(
  method: string,
  path: string,
  value: unknown,
): { validated: true } | { validated: false } {
  const schema = findApiResponseSchema(method, path);
  if (!schema) return { validated: false };
  const issues: string[] = [];
  schema.validate(value, issues);
  if (issues.length) throw new ApiContractError(method, path, issues);
  return { validated: true };
}
