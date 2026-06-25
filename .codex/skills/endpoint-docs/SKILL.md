---
name: endpoint-docs
description: Create, maintain, and query a concise Markdown catalog of the REST API (docs/api/endpoints.md) — method, path, request shape, response, semantic — with a frontmatter SHA so staleness is detected via git diff. Use when asked "what endpoints exist", "is there an API for X", "where is endpoint Y used", "document the API", or after adding/changing Hono routes.
argument-hint: "[build | update | check | find <q> | get <METHOD> <path> | usage <path>]"
---

# endpoint-docs

Maintains **`docs/api/endpoints.md`** — a parseable, per-tag table of every REST endpoint, and a CLI to query it. Source of truth is the Hono route code under `packages/server/src/routes/`.

The catalog row format is: **Method | Path | Request | Response | Description**.
- **Request** — the named body type, the inline shape `{field, optional?, …}` (from `parseJsonBody<{…}>`), `json` (untyped body), or `—` (GET/DELETE / no body).
- **Response** — the producing service call `name()`, an object-literal shape `{field, …}`, or `json` (derived syntactically from the handler's success `c.json(...)`).
- **Description** — the route's own `//` comment, with the redundant `METHOD /path` prefix stripped.

The **YAML frontmatter** records `commit` (SHA of the analyzed tree), `generated` (ISO timestamp), `endpoints` (count), and `source` (the route pathspec). The SHA is what makes incremental staleness checks cheap.

## CLI

Run via node (no build step; ts-morph is loaded lazily from the server package only for `build`/`update`):

```
node .claude/skills/endpoint-docs/endpoint-docs.mjs <command>
```

| Command | Does |
|---|---|
| `build` | (Re)generate the catalog from source. |
| `update` | Rebuild **and** print a changelog (`+` added / `-` removed / `~` changed). |
| `check [--json]` | Is the catalog stale vs `HEAD`? Lists route files changed since the recorded SHA. **Exit 1 if stale** (hook/CI friendly). |
| `list [--tag T] [--json]` | List all endpoints, or one tag. |
| `find <query> [--json]` | Substring search over path/description/request/response/tag. |
| `get <METHOD> <path> [--json]` | Exact lookup of one endpoint (path may use `:id` or `{id}`). |
| `usage <path> [--json]` | Where the endpoint is called from — greps client/server/mcp source. |

`--json` makes `check/list/find/get/usage` emit machine-readable output for chaining.

## Workflows

### Look up / answer "what endpoints exist?"
Don't grep route files by hand — query the catalog:
- Specific area: `find butler` / `find "voice"`.
- One endpoint's contract: `get POST /api/projects`.
- Who consumes it: `usage /api/projects/{id}/board`.

The freshness `check` is **optional** — skip it by default and just answer from the catalog. Only run `check` first when the answer depends on routes possibly changed very recently (e.g. you or a just-merged branch touched `packages/server/src/routes/`), or when the user explicitly asks to verify. If invoked with "no verify" / "no check", don't run it at all. When you do skip it, you may note the catalog's recorded `commit` so the user knows the basis.

### Keep it up to date (the SHA + diff loop)
The catalog only needs regenerating when **route files** change. Use the recorded SHA to find out cheaply, instead of re-analyzing on every commit:

1. **`check`** — reads `commit:` from the frontmatter and runs, in effect,
   `git diff --name-only <commit>..HEAD -- packages/server/src/routes`.
   - Exit 0 + "fresh" → nothing to do.
   - Exit 1 + a list of changed route files → regenerate.
2. **`update`** — re-analyzes, rewrites the doc (new SHA + timestamp), and prints exactly which endpoints were added/removed/changed. Review that changelog; it's your diff of the API surface.
3. Commit `docs/api/endpoints.md` alongside the route change.

This is the right loop after you (or a merged branch) touch anything under `packages/server/src/routes/`. A good habit: run `check` at the start of API work and `update` before committing it.

### Creating the catalog the first time
`build` — writes `docs/api/endpoints.md`, stamping the current `HEAD` SHA.

## How analysis works (so you can trust / extend it)
- Parses `routes/index.ts` to map each `create<Name>Route` factory to its mount prefix (`routes.route("/projects", …)`), plus inline routes on the aggregate router (`/api/internal/*`).
- For each factory, walks the `createRouter()` variable's `.get/.post/.put/.patch/.delete(...)` calls and extracts path (`:x` → `{x}`), request, response, and the leading comment — all **syntactically** (ts-morph AST, no full type-check), so it's fast and deterministic.
- **Surfaces, never hides, gaps**: a `create…Route` factory that isn't mounted in `index.ts` (i.e. dead code) is reported on `build`/`update` and excluded from the catalog.

## Notes / limits
- Request/response are best-effort and reflect this codebase's reality: the REST layer uses inline `parseJsonBody<{…}>` bodies and untyped service returns, so you'll see inline shapes and `call()` names rather than named DTOs. The companion `pnpm openapi:generate` (`packages/server/scripts/generate-openapi.ts`) emits the full inline JSON Schemas if you need the exact field types.
- `usage` matches the path with parameter segments wildcarded; it also matches the definition's own comment line — that's the route file, not a consumer.
- On Git-Bash/MSYS, a leading `/api/...` argument may be path-mangled by the shell; the CLI recovers by slicing from the `/api` segment, so `get`/`usage` still work. From PowerShell, quote the path.
