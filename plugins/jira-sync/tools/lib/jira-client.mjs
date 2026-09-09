// Zero-dependency Jira REST client. Uses the platform `fetch` (Node >= 18) —
// no npm dependency, so it works offline against a fixture-backed fetch with
// no install step. See tools/lib/fixtures.mjs for the offline mode.

import { buildAuthHeader } from "./auth.mjs";
import { normalizeHttpError, normalizeNetworkError } from "./errors.mjs";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_RESULTS = 50;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wraps plain text into the minimal Atlassian Document Format Jira Cloud v3 requires for comments. */
export function textToAdf(text) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: String(text) }] }],
  };
}

export class JiraClient {
  /**
   * @param {object} opts
   * @param {string} opts.siteUrl
   * @param {string} [opts.email]
   * @param {string} opts.apiToken
   * @param {typeof fetch} [opts.fetchImpl] — injectable for offline/fixture testing
   * @param {(ms:number)=>Promise<void>} [opts.sleepImpl] — injectable so tests don't wait for real backoff
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.retryBaseMs]
   */
  constructor({
    siteUrl,
    email,
    apiToken,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
  }) {
    if (!siteUrl) throw new Error("siteUrl is required");
    this.siteUrl = siteUrl.replace(/\/+$/, "");
    this.authHeader = buildAuthHeader({ email, apiToken });
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
    this.maxRetries = maxRetries;
    this.retryBaseMs = retryBaseMs;
  }

  /** Retry-After is seconds per HTTP spec; falls back to exponential backoff when absent. */
  static backoffDelayMs({ attempt, retryAfterHeader, baseMs }) {
    if (retryAfterHeader != null) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
    return baseMs * 2 ** attempt;
  }

  async request(path, { method = "GET", query, body } = {}) {
    const url = new URL(this.siteUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (cause) {
        lastError = normalizeNetworkError(cause);
        if (attempt === this.maxRetries) throw lastError;
        await this.sleepImpl(this.retryBaseMs * 2 ** attempt);
        continue;
      }

      if (response.status === 204) return null;

      const text = await response.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (response.ok) return parsed;

      const error = normalizeHttpError({ status: response.status, statusText: response.statusText, body: parsed });
      lastError = error;

      if (!error.retryable || attempt === this.maxRetries) throw error;

      const delay = JiraClient.backoffDelayMs({
        attempt,
        retryAfterHeader: response.headers?.get?.("retry-after") ?? null,
        baseMs: this.retryBaseMs,
      });
      await this.sleepImpl(delay);
    }

    // Unreachable in practice (the loop always returns or throws), kept for type-safety.
    throw lastError;
  }

  /** One page of `POST /search`. */
  async searchIssues(jql, { fields, startAt = 0, maxResults = DEFAULT_MAX_RESULTS } = {}) {
    return this.request("/rest/api/3/search", {
      method: "POST",
      body: { jql, fields, startAt, maxResults },
    });
  }

  /** Async generator over every issue matching `jql`, paginating transparently. */
  async *searchAll(jql, { fields, pageSize = DEFAULT_MAX_RESULTS } = {}) {
    let startAt = 0;
    for (;;) {
      const page = await this.searchIssues(jql, { fields, startAt, maxResults: pageSize });
      const issues = page?.issues ?? [];
      for (const issue of issues) yield issue;

      const total = page?.total ?? issues.length + startAt;
      startAt += issues.length;
      if (issues.length === 0 || startAt >= total) break;
    }
  }

  async getIssue(issueIdOrKey, { fields } = {}) {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`, {
      query: fields ? { fields: Array.isArray(fields) ? fields.join(",") : fields } : undefined,
    });
  }

  async listTransitions(issueIdOrKey) {
    const result = await this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`);
    return result?.transitions ?? [];
  }

  async transitionIssue(issueIdOrKey, transitionId, { fields } = {}) {
    const body = { transition: { id: String(transitionId) } };
    if (fields) body.fields = fields;
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`, {
      method: "POST",
      body,
    });
  }

  /** `body` may be plain text (wrapped into ADF) or an already-ADF document. */
  async addComment(issueIdOrKey, body) {
    const adf = typeof body === "string" ? textToAdf(body) : body;
    return this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`, {
      method: "POST",
      body: { body: adf },
    });
  }
}
