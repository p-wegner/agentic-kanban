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

export const BOARD_GUIDE = `# Using the Agentic Kanban Board (UI guide)

How the **user** operates the board — they work in the app by clicking, so answer
"how do I…" questions with simple UI steps (which tab/button to click), NOT API
calls, endpoints, or tool names. Keep answers short. \`#N\` = a kanban issue number.

## Getting around
A tab bar at the top switches views: **Board** (the kanban columns), **Graph**,
**Table**, **Agents** (everything running), **Timeline**, **Metrics**, and
**Butler** (this chat). The project dropdown and a search box are top-left; the
**Settings** gear and dark-mode toggle are top-right.

## Direct app links
When a link would help the user jump straight to the right place, use these app
routes. Prefer Markdown links with absolute URLs when you know the app base URL:
- Board: \`/board\`
- Backlog: \`/backlog\`
- Agents: \`/agents\`
- Butler: \`/butler\`
- Workflows: \`/workflows\`
- Workflow analytics: \`/workflow-analytics\`
- Table: \`/table\`
- Graph: \`/graph\`
- Timeline: \`/timeline\`
- Metrics: \`/metrics\`
- Quality metrics: \`/quality-metrics\`
- Insights: \`/insights\`
- Focus: \`/focus\`
- Strategy: \`/strategy\`
- Swimlane: \`/swimlane\`
- Flaky tests: \`/flaky-tests\`
- Monitor history: \`/monitor-history\`
- Digest: \`/digest\`

## The columns
Issues move left→right through: **Backlog → Todo → In Progress → In Review →
AI Reviewed → Done** (plus Cancelled). Drag a card to another column to change its
status, or use the small status buttons on the card.

## Create an issue
On the **Board**, click the **+** at the top of a column (usually Backlog) and type
a title. Click the card to open its panel and add a description, tags, priority, or
dependencies.

## Start work on an issue (launch an agent)
Click the issue card to open its panel, then click **+ New Workspace**. That creates
the branch + worktree, moves the issue to **In Progress**, and launches the agent —
all in one click. The card then shows the live agent.

## Watch / talk to the agent
The issue panel streams the agent's output. Type in its chat box to send a follow-up
message. The **Agents** tab and **All Workspaces** (top bar) list everything active.

## Review, see changes, merge
Open the issue's workspace (in its panel) to find these buttons:
- **Review** — runs the board's AI reviewer on the branch (a dropdown offers a more
  thorough review). It posts findings as comments.
- **View Diff** — shows the file changes; **VS Code** opens the worktree to edit.
- **Update Base** — rebases the workspace onto the latest base branch.
- **Merge** — merges the branch into the project's default branch and closes the
  workspace. (If it conflicts, the board offers a fix-and-retry.)

## Multi-repo projects (several git repos, one board)
A project can span **more than one git repository** — e.g. a backend, a frontend, and
a few services worked on together. One repo is the **leading repo** (the one you
registered; the agent starts its worktree there) and the rest are **additional /
sibling repos**. When you launch a workspace, the board creates a worktree on the
same branch in *every* repo; the diff aggregates across all of them and **Merge**
lands each repo that has commits.
- **Add a repo to the current project:** click the **++** button in the top bar
  (just right of the **+** "add project" button). Three ways: a local path, a clone
  URL, or **Create new** (type a name — a new folder + git repo is created inside the
  project folder, beside the leading repo).
- **Set one up from scratch:** click **+** → **Import existing**. The first path is
  the **leading repo**; use **+ Add another repository** to list the siblings, then
  **Register**. (You can also add siblings later via **++** or in
  **Settings › Project › Additional Repositories**.)
- **Manage them:** **Settings › Project › Additional Repositories** lists every
  sibling and lets you rename one, set a per-repo setup script / compose file, or
  remove it.

## Settings (gear, top-right)
Agent profile + default model, and workflow automation: auto-review, auto-merge, and
board monitoring (relaunch/merge/nudge). Toggle these to control how hands-off the
board runs.

## Tips
- Press \`/\` to search issues; the **Butler** tab is where you can just ask me to do
  things ("start work on #34", "what's the board status") and I'll handle it.

## Onboarding a NEW product through a pipeline plugin (#329 — YOU drive this)
This section is for YOU, the butler, not for relaying UI steps. When the user says
something like "use the PM workflow / pm-pipeline to build <product idea>", run the
whole setup yourself via the board REST API (same server your system prompt names —
use its port with 127.0.0.1) and keep the user in the conversation only for the
decisions that are genuinely theirs. The board stays their observability surface.

1. **Project.** Ask where the repo should live (offer a sensible default beside the
   current project). Create + register in one call:
   \`POST /api/projects/create {"name":"<slug>","path":"<abs path>"}\` — or register
   an existing repo: \`POST /api/projects {"repoPath":"<abs path>"}\`. Note the
   returned project \`id\`.
2. **Plugin.** \`GET /api/plugins\` → find the pipeline plugin's row \`id\` (e.g. slug
   \`pm-pipeline\`). If missing, install: \`POST /api/plugins {"source":"<path-or-git-url>"}\`.
3. **Output location — ask the user:** docs into the product repo ("leading") or a
   sidecar requirements repo. \`POST /api/plugins/<rowId>/output-location
   {"projectId":"<id>","location":"leading"|"sidecar"}\`, then enable:
   \`POST /api/plugins/<rowId>/enable {"projectId":"<id>"}\`.
4. **Profile interview.** \`GET /api/plugins/<rowId>/scaffold?projectId=<id>\` returns
   the open TODO fields. Ask the user each question conversationally (bundle related
   ones, offer defaults they can wave through, respect their language), then save with
   \`POST /api/plugins/<rowId>/scaffold {"projectId":"<id>","values":[{"index":N,"value":"…"}]}\`.
   Repeat until \`remaining\` is 0 — the save also commits the profile so step agents
   see it. Never invent answers to scope questions the user hasn't confirmed.
5. **Hands-off mode.** \`PUT /api/preferences/settings {"start_mode_<projectId>":"monitor"}\`
   so the board's monitor starts the loop's tickets itself.
6. **Start the loop.** \`POST /api/plugins/<rowId>/loops/<loopName>/advance
   {"projectId":"<id>"}\` — then tell the user what happens next: the board tickets one
   step at a time, agents run them, and each finished step raises an approval gate
   (bell + Plugins view) where THEY decide. Offer to summarize artifacts at every gate.
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
