// Builds a fake `fetch` backed by recorded JSON fixtures, so the client, the
// sync commands and their tests all run with no network. See ../fixtures/*.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8"));
}

function fakeResponse({ status = 200, body = null, headers = {} }) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : String(status),
    headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
    text: async () => (body === null ? "" : JSON.stringify(body)),
  };
}

/**
 * `steps` is an ordered list of `{ match(url, init), respond(url, init, callCount) }`.
 * The first matching step handles the call; `callCount` (0-based, per step) lets a
 * step script "fail once, then succeed" for backoff tests.
 */
export function createScriptedFetch(steps) {
  const callCounts = new Map();
  return async function scriptedFetch(url, init) {
    const href = typeof url === "string" ? url : url.toString();
    for (const step of steps) {
      if (!step.match(href, init)) continue;
      const count = callCounts.get(step) ?? 0;
      callCounts.set(step, count + 1);
      return fakeResponse(step.respond(href, init, count));
    }
    throw new Error(`no fixture route matched ${init?.method ?? "GET"} ${href}`);
  };
}

/** The default offline scenario: a two-page search, one issue detail/transitions/comment round trip. */
export function createDefaultFixtureFetch() {
  return createScriptedFetch([
    {
      match: (url, init) => init?.method === "POST" && url.includes("/rest/api/3/search"),
      respond: (url, init) => {
        const body = JSON.parse(init.body);
        const page = body.startAt >= 2 ? loadFixture("search-page-2") : loadFixture("search-page-1");
        return { status: 200, body: page };
      },
    },
    {
      match: (url, init) =>
        (init?.method ?? "GET") === "GET" && /\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(url),
      respond: () => ({ status: 200, body: loadFixture("transitions") }),
    },
    {
      match: (url, init) => init?.method === "POST" && /\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(url),
      respond: () => ({ status: 204 }),
    },
    {
      match: (url, init) => init?.method === "POST" && /\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(url),
      respond: () => ({ status: 200, body: loadFixture("comment-response") }),
    },
    {
      match: (url, init) => init?.method === "POST" && /\/rest\/api\/3\/issue$/.test(url),
      respond: () => ({ status: 201, body: loadFixture("issue-create-response") }),
    },
    {
      match: (url, init) => (init?.method ?? "GET") === "GET" && /\/rest\/api\/3\/issue\/[^/]+$/.test(url),
      respond: () => ({ status: 200, body: loadFixture("issue-detail") }),
    },
  ]);
}
