# Backlog Markdown (`kanban-md 1`)

A backlog as **one human-readable, hand-editable, diff-able `.md` file** — so a backlog can be
shared, reviewed in a PR, kept as a repo's `BACKLOG.md`, moved between boards, or written by
anyone (or any agent) and imported. It is the readable twin of the JSON backlog snapshot: same
exclusions (no ids, workspaces, sessions, device paths), same persistence underneath.

Two halves:

- **Export** (board → file) is exact and filterable.
- **Import** (file → board) is **liberal**: it reads the standard *and* the styles people already
  write, previews before writing, and hands hard cases to an agent (the `backlog-markdown`
  built-in skill) rather than guessing.

## The standard (what export writes, what an agent should write)

```markdown
---
kanban-md: 1
project: pantry
exported: 2026-08-17T10:00:00.000Z
statuses: Backlog, In Progress, In Review, Done
filter: status=open; tag=arch
issues: 2
---

# pantry — backlog

## Backlog

### #12 refactor: collapse the client's provider ladders
`priority: high` · `type: chore` · `tags: arch, client` · `milestone: M2` · `estimate: 3d` · `due: 2026-09-01` · `depends: #10, #11` · `blocks: #13` · `key: gh-77` · `url: https://example.test/77` · `created: 2026-08-01` · `updated: 2026-08-02`

Why: nine hand-rolled copies drift.

#### Steps
1. write the table
2. delete the copies

- [x] write the table
- [ ] delete the copies

## In Progress

### #13 Ship it
`priority: medium` · `type: feature`
```

Rules:

| Element | Meaning |
|---|---|
| front matter (`---` … `---`) | optional. `kanban-md: 1` declares the standard; `project` lets `#N` match existing issues on re-import into the same project; `statuses` fixes column order (empty columns are still rendered as `_(empty)_`). |
| `# Title` | optional document title; `<project> — backlog` by default. |
| `## Section` | a **status column**. Names are matched to the target's statuses case-insensitively, then through aliases (`Todo`/`To Do`/`Open` → Backlog, `Doing`/`WIP` → In Progress, `Closed`/`Completed` → Done, `Blocked`/`On hold` → Blocked, …). An unknown section is created as a new column (or mapped to the default column with `unknownStatus=map`). |
| `### [#N] Title` | one **issue**. `#N` is the project-local number — keep it when the issue exists; omit for new ones (numbers are assigned, colliding ones renumbered). |
| the backtick line right under the heading | **metadata**: `` `key: value` `` tokens joined by ` · `. Keys: `priority` (critical/high/medium/low + aliases P0–P4, urgent, minor…), `type` (feature/bug/task/chore/epic + aliases story, defect, refactor…), `tags`/`labels`, `milestone`/`sprint`, `estimate`/`points`, `due`, `depends`/`blocked by`/`after`, `blocks`, `key` (external id), `url`, `created`, `updated`. All optional. |
| body until the next `###`/`##` | the **description** (markdown). Headings inside must be `####` or deeper — export demotes them; a `##`/`###` inside a description would be read as a new section/issue. |
| `- [ ]` / `- [x]` lines in the body | the issue's **checklist**. |

Priorities, types and section names are normalised through the alias tables in
`packages/shared/src/lib/backlog-markdown.ts` (`PRIORITY_ALIASES`, `TYPE_ALIASES`, `STATUS_ALIASES`).

## Liberal styles the importer also reads

- `## Todo` + `- [ ] item` lists (the classic BACKLOG.md): every **top-level list item is an issue**,
  `[x]` = done (the section wins over the checkbox when both are present), indented sub-bullets are
  the description, indented `- [ ]` are the checklist, and sub-bullets or lines like `priority: high`,
  `**Labels:** a, b`, `depends on #3`, `blocked by #4` are metadata.
- `- **Title** — one-line description`, `- Title — description`.
- `#12` anywhere in a title (`Title (#12)`, `#12 Title`), inline hints `[bug]`, `[P1]`, `(high)`, `!p1`.
- `## Heading` issues without sections (a file with `##` headings and no list items).
- Code fences are opaque (nothing inside starts an issue).

The parser reports `confidence` (share of issue-looking lines it could place) and `warnings`
(unknown priorities, references to numbers not in the file, …). Below 0.6 the UI/CLI/MCP suggest
the agentic path instead of importing.

## Import semantics

- **`mode: update`** (default): each parsed issue is matched to an existing one — by `#N` when the
  file's `project` is this project (or `matchBy=number`), then by external `key`, then by title
  (case-insensitive) — and **only fields present in the file** are written; tags and dependencies
  are **added, never removed**; unmatched issues are created. Re-importing an unchanged export is a
  no-op (`unchanged` for every row).
- **`mode: create`**: everything is created (numbers kept when free, renumbered on collision).
- Missing statuses/tags/milestones are created (statuses appended at the end).
- Nothing is ever deleted by an import.
- Everything runs through the issue service, so board events, webhooks and status-transition
  side effects fire exactly as for a manual edit.

## Surfaces

| Surface | Export | Import |
|---|---|---|
| UI | Settings → UI → Board filters & export → **Export ▸ Backlog as Markdown…** (statuses/tags/priority/type/text/since filters, live count, copy or download) | **Export ▸ Import backlog Markdown…** (paste / file / drop → preview table with create/update/unchanged → apply) |
| REST | `GET /api/projects/:id/backlog.md?status=a,b&tag=x&priority=&type=&milestone=&q=&since=&numbers=&includeDone=1&timestamps=0&deps=0&bare=1&download=1` | `POST /api/projects/:id/backlog.md/preview` · `POST …/backlog.md/import` — body `{ text, mode?, matchBy?, defaultStatus?, unknownStatus? }`, `text/markdown`, or multipart `file` |
| CLI | `pnpm cli -- backlog export [--out BACKLOG.md] [--status …] [--tag …] [--include-done] …` | `pnpm cli -- backlog import FILE [--apply] [--mode update\|create]` (preview by default) |
| MCP | `export_backlog_markdown` | `import_backlog_markdown` (`dryRun` defaults to true) |
| Agent | built-in skill **`backlog-markdown`**: how to normalise an arbitrary backlog document to the standard, preview, apply |

## Where the code is

- `packages/shared/src/lib/backlog-markdown.ts` — pure render/parse + alias tables (tests: `packages/shared/__tests__/backlog-markdown.test.ts`).
- `packages/server/src/services/backlog-markdown.service.ts` — export filters, import preview/apply on top of the backlog-snapshot machinery.
- `packages/server/src/routes/backlog-markdown.ts`, `packages/server/src/cli/commands/backlog.ts`, `packages/mcp-server/src/tools/backlog-markdown.ts`, `packages/client/src/components/BacklogMarkdownModal.tsx`.
