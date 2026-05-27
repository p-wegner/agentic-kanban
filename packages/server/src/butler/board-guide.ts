/**
 * Bundled board-usage reference for the project butler.
 *
 * Shipped as a string constant (not a loose file) so it travels with the app no
 * matter where the butler runs — including when its cwd is some OTHER project's
 * repo. `ensureBoardGuideFile()` writes it to a stable path on disk so the butler
 * can Read it ON DEMAND (progressive disclosure): the system prompt only carries a
 * short pointer to this path, and the agent opens the file when it actually needs
 * the detail, instead of paying for the whole guide in every turn's context.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BOARD_GUIDE = `# Using the Agentic Kanban Board

Reference for the **project butler** on operating the agentic-kanban board on the
user's behalf. Read this when the user asks how to do something on the board, or
when you are unsure how an operation works — do not guess board mechanics.

Prefer the MCP tools (\`mcp__agentic-kanban__*\`); they are authoritative. Fall back
to the REST API (\`http://localhost:<serverPort>/api\`) only for the actions noted
below that have no MCP tool. \`#N\` always means a kanban issue number, never a
GitHub PR.

## The core loop
Register repo → create issue → start work (one step: branch + worktree + agent) →
review → merge. Issues flow through statuses:
**Backlog → Todo → In Progress → In Review → AI Reviewed → Done** (plus Cancelled).

## Seeing what's happening
- \`get_board_status\` — comprehensive overview: every active agent, workspace state,
  diff stats, session stats, last output. Use this first for "what's happening".
- \`list_issues\` — filter by status / priority / tag.
- \`get_issue\` (by issueNumber) — full detail incl. workspaces + dependencies.
- \`get_context\` — project info + issue counts.

## Creating & editing issues
- \`create_issue\` — returns the new issueNumber.
- \`update_issue\` / \`move_issue\` — change status/priority/description; move columns.
- Improve a vague ticket: \`POST /api/issues/enhance\` (AI-powered) — don't hand-rewrite.
- Suggest dependencies: \`POST /api/issues/analyze-dependencies\`.

## Starting work on an issue (the workflow)
Use the board's ONE-STEP flow so the whole workflow runs — it creates the worktree,
moves the issue to **In Progress**, AND launches the agent:

    POST http://localhost:<serverPort>/api/workspaces
    body: { "issueId": "<the issue id>", "branch": "feature/ak-<issueNumber>-<short-kebab-slug>" }

The 201 response includes the new workspace and a \`sessionId\` — that is your
confirmation the agent actually launched.

Do NOT use the \`start_workspace\` MCP tool to launch work — it only creates a bare
worktree (no agent, no status change). Never create worktrees/branches with raw
\`git worktree\`, and never run \`claude\` yourself.

## Talking to a running agent
- Send a follow-up turn: \`POST /api/workspaces/:id/turn\` (returns 409 if the agent
  is still processing the previous turn).

## Reviewing & merging
- Review a branch: \`POST /api/workspaces/:id/review\` — use the board's reviewer;
  don't critique the diff yourself.
- Inspect changes before merging: \`get_workspace_diff\`.
- Merge: \`merge_workspace\` (or \`POST /api/workspaces/:id/merge\`) — merges into the
  project's default branch and closes the workspace.
- Conflicts: \`POST /api/workspaces/:id/fix-and-merge\` (resolve + retry).
- Rebase onto latest base: \`POST /api/workspaces/:id/update-base\`.

## Tags & skills
- \`list_tags\`, \`create_tag\`.
- \`list_agent_skills\`, \`get_agent_skill\` — skills are reusable prompt templates an
  agent can apply when launched.

## Verify — never fabricate
After any state-changing action, re-check with \`get_issue\` / \`get_board_status\` and
report the ACTUAL result. Never claim an agent launched, an issue moved, or a merge
happened unless the board confirms it.

## MCP tool quick reference
| Task | Tool / endpoint |
|---|---|
| Board overview | \`get_board_status\` |
| List / filter issues | \`list_issues\` |
| Issue detail | \`get_issue\` |
| Project info + counts | \`get_context\` |
| Create issue | \`create_issue\` |
| Update / move issue | \`update_issue\` / \`move_issue\` |
| Start work (launch agent) | \`POST /api/workspaces\` |
| Follow-up to running agent | \`POST /api/workspaces/:id/turn\` |
| Inspect diff | \`get_workspace_diff\` |
| Review a branch | \`POST /api/workspaces/:id/review\` |
| Merge | \`merge_workspace\` |
| Tags | \`list_tags\` / \`create_tag\` |
| Skills | \`list_agent_skills\` / \`get_agent_skill\` |
`;

let cachedPath: string | null = null;

/**
 * Write the bundled guide to a stable temp path and return it (forward-slashed so
 * it reads cleanly in the prompt; the Read tool accepts it on Windows too). Cheap
 * and idempotent — safe to call on every butler session start.
 */
export function ensureBoardGuideFile(): string {
  const dir = join(tmpdir(), "agentic-kanban");
  const path = join(dir, "board-guide.md");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, BOARD_GUIDE, "utf-8");
    cachedPath = path;
  } catch {
    // If the write fails, fall back to the last good path (or the intended one).
  }
  return (cachedPath ?? path).replace(/\\/g, "/");
}
