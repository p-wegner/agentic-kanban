---
name: shared-checkout-commit
description: Commit safely when other agents work in the SAME checkout — pathspec commits, and the private-index + compare-and-swap recipe when another agent has uncommitted edits in a file you also changed. Use on index.lock contention, a contested file, or a staged-deleted file after such a commit.
---

# shared-checkout-commit

_Moved verbatim from the root `CLAUDE.md` on 2026-09-25; CLAUDE.md keeps the one-line rule._

`git add <paths>` + `git commit` is NOT safe when other agents work in the same checkout: the index is
shared process-wide, so a concurrent `git add`/`git reset` between your add and your commit sweeps
THEIR files into YOUR commit under YOUR message — or drops yours. This happened: `0a7d00bef3` carries
one agent's loop-convergence work plus another's monitor/git-exec work under a single misleading
subject. It is not rewritable once someone has built on it.

**Use a pathspec-limited commit, which ignores the shared index entirely:**
```bash
git commit -F msg.txt -- packages/server/src/services/foo.ts packages/server/src/__tests__/foo.test.ts
```
Never `git add -A`/`-a`/`.` in a shared checkout. On `index.lock` contention, wait and retry — do not
`git reset` to "clean up", which is what destroys the other agent's staged state. Intermediate commits
may then not typecheck standalone (a symbol can land one commit later); that is acceptable as long as
HEAD is coherent — say so in the commit message.

**Pathspec is NOT enough when two agents edit the SAME file** — it takes that path's whole current
worktree state, so it commits the other agent's half-written hunks under your subject. That is the
`0a7d00bef3` failure again, just via a different door. Waiting works only if they commit; when they
don't, commit YOUR HUNKS ONLY through a private index, which touches neither the shared index nor the
working tree:
```bash
export GIT_INDEX_FILE=$(mktemp)          # a private index — the shared one is untouched
git read-tree HEAD                        # start from HEAD, not from whatever is staged
# stage only your version of the contested file (e.g. from a blob you wrote aside),
# then build the commit object directly and move the ref under a compare-and-swap:
tree=$(git write-tree)
new=$(git commit-tree "$tree" -p "$(git rev-parse HEAD)" -F msg.txt)
git update-ref refs/heads/master "$new" "$(git rev-parse HEAD)"   # CAS: fails if HEAD moved
unset GIT_INDEX_FILE
```
The `update-ref` old-value argument is the point: if another agent committed while you were building,
it fails instead of clobbering. **This recipe is for the MAIN checkout only**: a worktree/builder/reviewer
session must never write the base ref (`update-ref refs/heads/master`, `branch -f master`, `push … master`,
`checkout master`) — it rebases its OWN branch onto the local base and lets the board land it; the
cross-worktree guard hard-blocks those commands under `KANBAN_WORKTREE_DIR` (#1237, after a reviewer
pattern-matched this very text and force-moved master five days back). Afterwards verify `git diff HEAD -- <file>` is *exactly* the other
agent's remaining delta, so you can show you left their work intact and committable.

**Aftermath to clean up:** a private-index commit leaves any NEW file it added looking
**staged-deleted** in the shared index (the shared index never learned about it, but HEAD now has
it). Reconcile with a targeted `git add <your-new-files>` — and check afterwards that you did not
also stage a neighbour's in-flight edit. If you did, unstage exactly that path with
`git restore --staged -- <path>`, never `git reset`, which is what destroys the other agent's
staged state.

