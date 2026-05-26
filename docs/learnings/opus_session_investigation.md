I've traced the full failure chain. Here's what actually went wrong.

## Root cause: the SQLite WAL/SHM files are tracked in git

```
$ git ls-files | grep kanban.db
packages/server/kanban.db-shm   ← TRACKED
packages/server/kanban.db-wal   ← TRACKED
```

`.gitignore` *does* list `*.db-wal` and `*.db-shm` (lines 5-6), but these two files were committed **before** that rule existed — and `.gitignore` only affects untracked files. So `kanban.db` itself is correctly untracked, but its two live sidecar files are version-controlled.

This is a latent landmine: **every git merge/rebase/checkout/reset the board monitor performs touches these files while the server has the SQLite database open.**

## What happened tonight (chronological, from the agent-task-troubleshooting transcript)

1. **Board monitor loop** (running every 20 min) started merging completed workspaces via git.
2. During merges, git tried to update the tracked `kanban.db-wal` / `kanban.db-shm` against the live DB. On Windows this failed hard (transcript L857, L1338):
   ```
   error: unable to unlink old 'packages/server/kanban.db-shm': Invalid argument
   fatal: Could not reset index file to revision 'HEAD'.
   ```
3. To unblock the merge, the agent ran `git checkout -- kanban.db-shm kanban.db-wal` and `git reset HEAD` (L1334, L1340) — **overwriting the WAL out from under the running SQLite connection.** That is what corrupts SQLite.
4. Result (L1474): `database disk image is malformed`, then `malformed database schema (sqlite_autoindex_agent_skills_new_1) - invalid rootpage`.
5. **Recovery made it worse.** `db:repair` repeatedly failed with `EBUSY: unlink kanban.db` because worktree server processes still held the file open (L1485–1551). Its `--force` path then *recreated an empty DB* while locked. Backups were also corrupt. The agent eventually gave up, deleted the DB, re-registered the project (new ID `7a0afafc-…`), and reseeded — i.e. the reset you saw.

## The two real problems

| #   | Problem                                                                                                                             | Fix                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | **WAL/SHM tracked in git** → every merge mutates live SQLite files → corruption                                                     | `git rm --cached packages/server/kanban.db-wal packages/server/kanban.db-shm` and commit. `.gitignore` already covers them. |
| 2   | `db:repair --force` recreates an empty DB even when the file is EBUSY-locked, and doesn't refuse when a server still holds the lock | Make `--force` abort on EBUSY instead of destroying data; don't auto-force on transient locks                               |

Problem #1 is the trigger and is a one-line fix. Problem #2 is why a recoverable corruption became a full data-loss reset.

Want me to untrack the WAL/SHM files now (the safe, direct fix for the trigger)? I'd run:

```
git rm --cached packages/server/kanban.db-wal packages/server/kanban.db-shm
```

This stops git from ever touching them again. I'd leave the `db:repair` hardening (#2) for you to decide on separately since it changes recovery behavior.