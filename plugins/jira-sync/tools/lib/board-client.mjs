// Thin fetch-based client for the AGENTIC KANBAN board's own REST API — the write
// side of a pull (create/update board issues, keyed by external_key). Deliberately
// separate from jira-client.mjs: this talks to the board, not Jira, and the two must
// never be confused when reading a stack trace.
//
// No credential store resolves BOARD_URL/PROJECT_ID into env for these commands
// either (same known gap as auth.mjs describes for Jira credentials) — read directly
// from the process environment.

export class BoardConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "BoardConfigError";
  }
}

export class BoardApiError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = "BoardApiError";
    this.status = status;
    this.body = body;
  }
}

/** Reads BOARD_URL + PROJECT_ID from the environment. */
export function resolveBoardConfigFromEnv(env = process.env) {
  const boardUrl = env.JIRA_SYNC_BOARD_URL;
  const projectId = env.JIRA_SYNC_BOARD_PROJECT_ID;
  if (!boardUrl) throw new BoardConfigError("JIRA_SYNC_BOARD_URL is not set");
  if (!projectId) throw new BoardConfigError("JIRA_SYNC_BOARD_PROJECT_ID is not set");
  return { boardUrl: boardUrl.replace(/\/+$/, ""), projectId };
}

export class BoardClient {
  /**
   * @param {object} opts
   * @param {string} opts.boardUrl
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({ boardUrl, fetchImpl = fetch }) {
    if (!boardUrl) throw new BoardConfigError("boardUrl is required");
    this.boardUrl = boardUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = "GET", body } = {}) {
    const response = await this.fetchImpl(this.boardUrl + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const message = (parsed && typeof parsed === "object" && parsed.error) || `board API ${method} ${path} failed: ${response.status}`;
      throw new BoardApiError(message, { status: response.status, body: parsed });
    }
    return parsed;
  }

  listStatuses(projectId) {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/statuses`);
  }

  /**
   * Every issue in the project carrying a non-null `externalKey`, keyed by that key.
   * `GET /api/issues?limit=` caps a single page at 500 (server's MAX_ISSUE_PAGE_SIZE) —
   * paginate via `offset` rather than trusting one page, or a project past 500 issues
   * would silently miss externalKey lookups and re-create duplicates every pull.
   */
  async listExternallyTrackedIssues(projectId) {
    const pageSize = 500;
    const byExternalKey = new Map();
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.request(
        `/api/issues?projectId=${encodeURIComponent(projectId)}&limit=${pageSize}&offset=${offset}`,
      );
      for (const issue of page) {
        if (issue.externalKey) byExternalKey.set(issue.externalKey, issue);
      }
      if (page.length < pageSize) break;
    }
    return byExternalKey;
  }

  createIssue(body) {
    return this.request("/api/issues", { method: "POST", body });
  }

  updateIssue(issueId, body) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, { method: "PATCH", body });
  }

  listTags() {
    return this.request("/api/tags");
  }

  createTag(name) {
    return this.request("/api/tags", { method: "POST", body: { name } });
  }

  listIssueTags(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/tags`);
  }

  attachTag(issueId, tagId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/tags`, { method: "POST", body: { tagId } });
  }
}
