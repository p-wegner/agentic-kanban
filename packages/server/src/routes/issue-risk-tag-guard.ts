import type { MiddlewareHandler } from "hono";
import {
  OPERATOR_ACTOR_HEADER,
  OPERATOR_ACTOR_VALUE,
  describeRiskTagApplied,
  refuseSofterRiskTags,
  riskPosturePrefKeyFor,
  riskTagLevel,
} from "@agentic-kanban/shared/lib/risk-tag-guard";
import type { Database } from "../db/index.js";
import { ForbiddenError } from "../errors/index.js";
import { getIssueProjectId } from "../repositories/issue.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { getTagById } from "../repositories/tag.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { riskTagGuardPeekBody } from "./issue-body-schemas.js";

type Peek = { projectId?: unknown; tagId?: unknown; tags?: unknown; issues?: unknown } | null | undefined;
type Route = { tagMatch: RegExpExecArray | null; isCreate: boolean; isBatch: boolean };

function matchRoute(path: string): Route | null {
  const tagMatch = /\/issues\/([^/]+)\/tags$/.exec(path);
  const isCreate = /\/issues$/.test(path);
  const isBatch = /\/issues\/batch$/.test(path);
  return tagMatch || isCreate || isBatch ? { tagMatch, isCreate, isBatch } : null;
}

const trimmedStrings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).filter((t): t is string => typeof t === "string").map((t) => t.trim());

const batchItems = (body: Peek): { tags?: unknown }[] => (Array.isArray(body?.issues) ? body.issues as { tags?: unknown }[] : []);

/** The tag names the request would attach, plus the project they would land in (when knowable up front). */
async function peekTagNames(route: Route, body: Peek, database: Database): Promise<{ names: string[]; projectId: string | null }> {
  const bodyProject = typeof body?.projectId === "string" ? body.projectId : null;
  if (route.tagMatch) {
    const issueId = route.tagMatch[1];
    const tag = typeof body?.tagId === "string" ? await getTagById(body.tagId, database) : null;
    return { names: tag ? [tag.name] : [], projectId: (await getIssueProjectId(issueId, database)) ?? null };
  }
  if (route.isBatch) return { names: batchItems(body).flatMap((i) => trimmedStrings(i?.tags)), projectId: bodyProject };
  return { names: trimmedStrings(body?.tags), projectId: bodyProject };
}

function routeSource(route: Route, operator: boolean): string {
  const label = route.tagMatch ? "POST /api/issues/:id/tags" : route.isBatch ? "POST /api/issues/batch" : "POST /api/issues";
  return `REST ${label} (${operator ? "operator" : "agent"})`;
}

async function recordRiskTag(database: Database, issueId: string, name: string, operator: boolean, source: string): Promise<void> {
  const level = riskTagLevel(name);
  if (!level) return;
  await insertIssueComment({
    issueId,
    kind: "note",
    author: operator ? "user" : "agent",
    body: describeRiskTagApplied(level, source),
    payload: { riskTag: name, source },
  }, database).catch(() => {});
}

async function recordBatch(res: Response, body: Peek, record: (id: string, name: string) => Promise<void>): Promise<void> {
  const created = await res.clone().json().then((r) => (r as { issues?: { id?: string }[] }).issues ?? []).catch(() => []);
  const items = batchItems(body);
  for (let i = 0; i < created.length; i++) {
    const id = created[i]?.id;
    if (!id) continue;
    for (const t of trimmedStrings(items[i]?.tags)) await record(id, t);
  }
}

/**
 * #1745 — REST guard for the two paths that can attach a `risk:<level>` tag to an issue
 * (`POST /api/issues` with `tags`, `POST /api/issues/:id/tags`).
 *
 * Callers that do not identify as an operator (the UI and an explicit CLI flag send
 * `x-kanban-actor: operator`) are treated as agent-facing: a tag SOFTER than the project posture
 * is refused with 403. Either way an applied `risk:` tag writes an issue comment naming the
 * level and the source (the board derives its activity feed from comments).
 */
export function createRiskTagGuard(database: Database): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const route = matchRoute(new URL(c.req.url).pathname.replace(/\/+$/, ""));
    if (!route) return next();

    // The three handlers behind this guard all `parseJsonBody` the same body, so invalid JSON
    // gets the same 400 here as it would there; the schema deliberately checks nothing else.
    const body = await parseJsonBody(c, riskTagGuardPeekBody);
    const { names, projectId } = await peekTagNames(route, body, database);
    const riskNames = names.filter((n) => riskTagLevel(n));
    if (riskNames.length === 0) return next();

    const operator = c.req.header(OPERATOR_ACTOR_HEADER)?.toLowerCase() === OPERATOR_ACTOR_VALUE;
    if (!operator) {
      const pref = projectId ? await getPreference(riskPosturePrefKeyFor(projectId), database) : null;
      const refusal = refuseSofterRiskTags(riskNames, pref);
      if (refusal) throw new ForbiddenError(refusal);
    }

    await next();

    if (c.res.status >= 400) return;
    const source = routeSource(route, operator);
    const record = (id: string, name: string) => recordRiskTag(database, id, name, operator, source);
    if (route.isBatch) return recordBatch(c.res, body, record);
    const issueId = route.tagMatch?.[1]
      ?? await c.res.clone().json().then((r) => (r as { id?: string }).id ?? null).catch(() => null);
    if (!issueId) return;
    for (const name of riskNames) await record(issueId, name);
  };
}
