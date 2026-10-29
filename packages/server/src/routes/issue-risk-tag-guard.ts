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
    const path = new URL(c.req.url).pathname.replace(/\/+$/, "");
    const tagMatch = /\/issues\/([^/]+)\/tags$/.exec(path);
    const isCreate = /\/issues$/.test(path);
    const isBatch = /\/issues\/batch$/.test(path);
    if (!tagMatch && !isCreate && !isBatch) return next();

    const body = await c.req.json().catch(() => null) as { tagId?: unknown; tags?: unknown; projectId?: unknown; issues?: unknown } | null;
    let issueId: string | null = tagMatch?.[1] ?? null;
    let projectId: string | null = typeof body?.projectId === "string" ? body.projectId : null;
    let names: string[] = [];
    if (tagMatch) {
      const tag = typeof body?.tagId === "string" ? await getTagById(body.tagId, database) : null;
      names = tag ? [tag.name] : [];
      projectId = issueId ? await getIssueProjectId(issueId, database) ?? null : null;
    } else if (isBatch) {
      const items = Array.isArray(body?.issues) ? body.issues as { tags?: unknown }[] : [];
      names = items.flatMap((i) => (Array.isArray(i?.tags) ? i.tags : [])).filter((t): t is string => typeof t === "string").map((t) => t.trim());
    } else if (Array.isArray(body?.tags)) {
      names = body.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim());
    }
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
    const source = `REST ${tagMatch ? "POST /api/issues/:id/tags" : isBatch ? "POST /api/issues/batch" : "POST /api/issues"} (${operator ? "operator" : "agent"})`;
    const record = async (id: string, name: string) => {
      const level = riskTagLevel(name);
      if (!level) return;
      await insertIssueComment({
        issueId: id,
        kind: "note",
        author: operator ? "user" : "agent",
        body: describeRiskTagApplied(level, source),
        payload: { riskTag: name, source },
      }, database).catch(() => {});
    };
    if (isBatch) {
      const created = await c.res.clone().json().then((r) => (r as { issues?: { id?: string }[] }).issues ?? []).catch(() => []);
      const items = Array.isArray(body?.issues) ? body.issues as { tags?: unknown }[] : [];
      for (let i = 0; i < created.length; i++) {
        const id = created[i]?.id;
        const tags = Array.isArray(items[i]?.tags) ? (items[i].tags as unknown[]) : [];
        if (id) for (const t of tags) if (typeof t === "string") await record(id, t.trim());
      }
      return;
    }
    if (!issueId) {
      issueId = await c.res.clone().json().then((r) => (r as { id?: string }).id ?? null).catch(() => null);
    }
    if (!issueId) return;
    for (const name of riskNames) {
      const level = riskTagLevel(name);
      if (!level) continue;
      await insertIssueComment({
        issueId,
        kind: "note",
        author: operator ? "user" : "agent",
        body: describeRiskTagApplied(level, source),
        payload: { riskTag: name, source },
      }, database).catch(() => {});
    }
  };
}
