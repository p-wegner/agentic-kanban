// A minimal in-memory fake of the board's REST API, for `--self-test` runs of
// tools/sync/pull.mjs. Unlike tools/fixtures.mjs (static recorded JSON, since Jira
// responses are read-only fixtures), the board is being WRITTEN to, so this fake
// needs to hold state across calls within one process — a plain object works.

import { randomUUID } from "node:crypto";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

// Field names the real board API reads on create/update (routes/issues.ts). The fixture
// rejects anything else so a misnamed field (#1629: `type` vs `issueType`) fails loudly.
const WRITABLE_ISSUE_FIELDS = new Set([
  "title", "description", "priority", "issueType", "skipAutoReview", "sortOrder", "statusId",
  "workflowTemplateId", "externalKey", "externalUrl", "reposTouched", "tags", "noAutoStart",
]);
function unknownFields(body, extra = []) {
  return Object.keys(body ?? {}).filter((k) => !WRITABLE_ISSUE_FIELDS.has(k) && !extra.includes(k));
}

/** A fresh in-memory board: one default status, no issues, no tags. */
export function createBoardFixtureState() {
  return {
    statuses: [{ id: "status-todo", name: "Todo", isDefault: true, sortOrder: 0 }],
    issues: [],
    tags: [],
    issueTags: new Map(), // issueId -> Set<tagId>
    comments: new Map(), // issueId -> comment[]
  };
}

/** Builds a scripted fetch backed by `state` (defaults to a fresh board). */
export function createDefaultBoardFixtureFetch(state = createBoardFixtureState()) {
  return async function boardFixtureFetch(url, init = {}) {
    const href = typeof url === "string" ? url : url.toString();
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = href.replace(/^https?:\/\/[^/]+/, "");

    if (method === "GET" && /\/api\/projects\/[^/]+\/statuses$/.test(path)) {
      return jsonResponse(200, state.statuses);
    }
    if (method === "GET" && path.startsWith("/api/issues?")) {
      return jsonResponse(
        200,
        state.issues.map((i) => ({
          ...i,
          tags: state.tags.filter((t) => state.issueTags.get(i.id)?.has(t.id)),
        })),
      );
    }
    if (method === "POST" && path === "/api/issues") {
      const bad = unknownFields(body, ["projectId"]);
      if (bad.length > 0) return jsonResponse(400, { error: `unknown issue field(s): ${bad.join(", ")}` });
      const now = new Date().toISOString();
      const issue = { id: randomUUID(), createdAt: now, updatedAt: now, ...body };
      state.issues.push(issue);
      return jsonResponse(201, issue);
    }
    const patchMatch = method === "PATCH" && /^\/api\/issues\/([^/]+)$/.exec(path);
    if (patchMatch) {
      const issue = state.issues.find((i) => i.id === patchMatch[1]);
      if (!issue) return jsonResponse(404, { error: "not found" });
      const bad = unknownFields(body);
      if (bad.length > 0) return jsonResponse(400, { error: `unknown issue field(s): ${bad.join(", ")}` });
      Object.assign(issue, body, { updatedAt: new Date().toISOString() });
      return jsonResponse(200, issue);
    }
    const commentsMatch = /^\/api\/issues\/([^/?]+)\/comments(?:\?.*)?$/.exec(path);
    if (method === "GET" && commentsMatch) {
      return jsonResponse(200, { comments: state.comments.get(commentsMatch[1]) ?? [] });
    }
    if (method === "POST" && commentsMatch) {
      const comment = { id: randomUUID(), createdAt: new Date().toISOString(), ...body };
      if (!state.comments.has(commentsMatch[1])) state.comments.set(commentsMatch[1], []);
      state.comments.get(commentsMatch[1]).push(comment);
      return jsonResponse(201, comment);
    }
    if (method === "GET" && path === "/api/tags") {
      return jsonResponse(200, state.tags);
    }
    if (method === "POST" && path === "/api/tags") {
      const tag = { id: randomUUID(), name: body.name };
      state.tags.push(tag);
      return jsonResponse(201, tag);
    }
    const tagsGetMatch = method === "GET" && /^\/api\/issues\/([^/]+)\/tags$/.exec(path);
    if (tagsGetMatch) {
      const ids = state.issueTags.get(tagsGetMatch[1]) ?? new Set();
      return jsonResponse(200, state.tags.filter((t) => ids.has(t.id)));
    }
    const tagsPostMatch = method === "POST" && /^\/api\/issues\/([^/]+)\/tags$/.exec(path);
    if (tagsPostMatch) {
      const issueId = tagsPostMatch[1];
      if (!state.issueTags.has(issueId)) state.issueTags.set(issueId, new Set());
      state.issueTags.get(issueId).add(body.tagId);
      return jsonResponse(201, { id: randomUUID() });
    }

    throw new Error(`no board fixture route matched ${method} ${href}`);
  };
}
