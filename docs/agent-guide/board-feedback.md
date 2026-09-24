# Board feedback conventions

_Moved verbatim from the root `CLAUDE.md` on 2026-09-25 (token pass). CLAUDE.md keeps the rules; this page keeps the rationale, incidents and detail. Section headings are the originals._

## Board Feedback Conventions — what to do when you hit a flaw IN THE BOARD
Using the board (driving a project, implementing a ticket, running the monitor) surfaces bugs and
impediments in the board itself. There are four ways to route that feedback. Pick by CONTEXT, not by
taste — the first three are preferred, and **never silently drop the finding**:

| Mode | Use when |
|---|---|
| **`fix-direct`** — fix it in the board's code now | Best outcome. Only when you can edit the board's main checkout without colliding with other activity — especially when the flaw BLOCKS planned work. |
| **`file-ticket`** — file a board ticket for later | The safe default. Use whenever direct work would collide with another agent/session, or the flaw is off your current task's path. |
| **`file-and-drive`** — file a ticket AND drive the board to implement it | The flaw is worth fixing now but you shouldn't hand-edit master (e.g. mid-drive with builders running). |
| **`gh-issue`** — file an issue on the board's GitHub repo | For machines that only CONSUME the board and do no active development on it — no local checkout to fix, no shared DB to file into. |

**Deployment decides what is even POSSIBLE — check this before preference:**

| Deployment | What's available |
|---|---|
| **git clone** (development) | All four. The board's repo is usually registered as a project, so there's a real backlog; source is editable. |
| **`npx agentic-kanban` / npm install** | `gh-issue` only. The code is an immutable package under `node_modules`/the npx cache — nothing to fix, and no board project to file into. |
| **`docker run`** | `gh-issue` only. Source lives in the image; edits die with the container. |

So on a consumer install, "file a ticket" is not a cheaper `gh-issue` — it's a **worse** one: the
ticket lands in whatever project backlog is at hand, about code nobody on that machine maintains,
and is never actioned. The board computes this itself in
`packages/server/src/services/board-feedback-routing.ts` (`detectBoardDeployment`) and renders the
resulting instruction into every worktree's ticket-context file. A registered board project always
wins — if the operator tracks the board ON the board, that's where they look.

**Choosing the mode — resolution order:**
1. **Deployment first.** If this board is packaged or containerized, it's `gh-issue`. Stop here.
2. **`CLAUDE.local.md` in the board's MAIN CHECKOUT** sets it, via a line `Board feedback mode: <mode>`.
   That file is gitignored, so it is per-machine — which is the point: a dev box says `fix-direct`,
   a consumer box says `gh-issue`.
3. **No such file and you are in the main checkout (fresh clone)** — ASK the user which mode they want
   the first time it comes up, then offer to record it in `CLAUDE.local.md`. Don't guess.
4. **You are in a WORKTREE** — always **`file-ticket`** (or `gh-issue` per rule 1). See the collision
   note below: a worktree's `CLAUDE.local.md` is not config, and a builder must not hand-edit the
   board's main checkout while other workspaces are live. Report it and keep going — a found bug is
   never a reason to abandon your ticket.

**`CLAUDE.local.md` means two different things — do not confuse them:**
- **Main checkout** → per-machine human/agent config (the `Board feedback mode:` line above).
- **Worktree** → the board GENERATES it as the ticket-context file (`TICKET_CONTEXT_FILENAME` in
  `packages/shared/src/lib/ticket-context.ts`): ticket text, context primer, stack profile, sibling
  repos, service stack. It is rewritten on every workspace creation, so **anything you put there by
  hand is lost** — never store config in a worktree's copy, and never treat it as user-authored.

**File against the RIGHT project — this is the easy mistake.** `create_issue` defaults to the board's
**active project**, which is usually NOT the project you are working in. A builder in `pantry` that
finds a *board* flaw must file it against the **agentic-kanban** project, not `pantry`. Always pass
`projectId` explicitly. (Real instance: two board bugs were filed into the `bookvault` fixture project
and sat there unactionable until they were moved to the dev board as #209/#210.) The generated
worktree ticket context names the board's project and id for exactly this reason.

**How the convention reaches a builder in ANOTHER repo.** A builder driving `pantry` reads *pantry's*
CLAUDE.md, never this one — so this section alone would never be seen. The board therefore renders the
routing into the ticket-context file it writes into **every** worktree
(`buildBoardFeedbackSection`, `packages/shared/src/lib/ticket-context.ts`). Keep the two in sync: this
section is the rationale, that function is what agents actually execute.

