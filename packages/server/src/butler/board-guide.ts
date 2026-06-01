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

## Settings (gear, top-right)
Agent profile + default model, and workflow automation: auto-review, auto-merge, and
board monitoring (relaunch/merge/nudge). Toggle these to control how hands-off the
board runs.

## Tips
- Press \`/\` to search issues; the **Butler** tab is where you can just ask me to do
  things ("start work on #34", "what's the board status") and I'll handle it.
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
