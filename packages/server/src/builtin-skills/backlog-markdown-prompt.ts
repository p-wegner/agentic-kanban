// Prompt of the built-in `backlog-markdown` skill (registered in ../builtin-skills.ts). Kept in
// its own module so the skill list stays under the god-module ceiling.
export const BACKLOG_MARKDOWN_PROMPT = `You move backlogs between the board and markdown — both directions — with ONE file: **Backlog Markdown** (\`kanban-md 1\`). Tools: MCP \`mcp__agentic-kanban__export_backlog_markdown\` / \`import_backlog_markdown\` (preferred), CLI \`npx agentic-kanban backlog export|import\`, REST \`GET /api/projects/:id/backlog.md\` · \`POST …/backlog.md/preview|import\`. Spec: docs/backlog-markdown.md in the board repo.

## The standard (what you WRITE)

\`\`\`markdown
---
kanban-md: 1
project: <project name>          # optional; when it matches the target project, #numbers match existing issues
statuses: Backlog, In Progress, In Review, Done
---

# <project> — backlog

## Backlog                        # one ## per status column (the target's names; unknown names become new columns)

### #12 Title as one line          # #N optional — keep it when the issue exists on the target
\`priority: high\` · \`type: chore\` · \`tags: arch, client\` · \`milestone: M2\` · \`estimate: 3d\` · \`due: 2026-09-01\` · \`depends: #10, #11\` · \`blocks: #13\` · \`key: gh-77\` · \`url: https://…\`

Description in markdown (any length; headings inside must be #### or deeper).

- [ ] checklist item
- [x] done item
\`\`\`

Priority ∈ critical|high|medium|low · type ∈ feature|bug|task|chore|epic. Every metadata token is optional. Only what is in the file is written; on update, tags and dependencies are ADDED, never removed.

## Export (board → file)
1. Ask what to include if unclear: statuses (default: every non-terminal), tags, priorities, milestone, free text, "updated since". Done work is excluded unless asked (includeDone).
2. \`export_backlog_markdown\` with those filters → write the text to the file the user names (BACKLOG.md, docs/backlog.md, a share). Say how many issues and which filters.
3. Keeping a repo's BACKLOG.md in sync = export with the same filters again and overwrite (the format is stable and diff-friendly, issues match by #number on the way back).

## Import (file → board) — the agentic path
The board's parser is LIBERAL (## sections + \`- [ ] item\` lists, \`- **Title** — text\`, \`#12\` in titles, \`**Priority:** high\`, \`depends on #3\`, \`[x]\` = done) and returns a **confidence**. Your job is the part it cannot do: understand a file written for humans and turn it into the standard without inventing anything.
1. **Read the source** (a BACKLOG.md, a TODO list, another tool's export, meeting notes, a spreadsheet pasted as text). Identify: what is an item, what is its status (section names, checkboxes, words like DONE/WIP), priority signals (P1, urgent, !, "must"), type (bug/feature/refactor…), owners → tags, references (#N, ticket ids → \`key:\`), dependencies ("after", "blocked by", "needs"), estimates, dates.
2. **Preview first, always**: \`import_backlog_markdown\` with \`dryRun: true\` on the raw text. If confidence ≥ 0.6 and the preview rows look right (titles clean, statuses sensible, no prose mistaken for issues), you may apply the raw text as-is.
3. Otherwise **rewrite it into the standard** (above): one \`###\` per item, clean titles (no numbering artefacts, no trailing metadata), status sections mapped onto the TARGET project's status names (ask \`get_board_status\` for them; unknown sections either become new columns or — usually better — map to Backlog with a tag), metadata line from what the source actually said. Keep the source's wording in descriptions; do NOT invent priorities/estimates that were not there. Preserve source ids as \`key:\` so a re-import matches.
4. **Preview the rewritten text**; show the user the counts (create/update/unchanged), new columns/tags, and warnings; fix anything wrong; then apply with \`dryRun: false\`. Default \`mode: update\` (matches by #number for a same-project file, then external key, then title); use \`mode: create\` only when the user wants copies.
5. Report: created / updated / unchanged, new columns/tags, renumbering warnings, and where the file came from.

## Rules
- Never import without a preview the user (or you, for an obvious file) has sanity-checked — a bad parse creates junk tickets that someone must delete.
- Never delete or overwrite board data from a file: import adds and updates only. If the user wants "make the board look exactly like this file", say that removal is manual and list what would have to go.
- Descriptions with \`##\`/\`###\` headings must be demoted (\`####\`) or the parser reads them as sections/issues.
- Pass \`projectId\` explicitly when the target is not the active project.`;

