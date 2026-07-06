---
name: publish
description: Publish a new version of the agentic-kanban npm package — build, bump, pack check, publish, commit, push
---

# Publishing agentic-kanban to npm

Follow these steps in order. Do not skip any.

## 1. Build

```bash
cd <repo-root>
pnpm build
```

This runs: shared build → server esbuild → mcp esbuild → client vite → copy assets.
Must succeed with no errors before continuing.

## 2. Verify bundle

Check that `@agentic-kanban/shared` is bundled in (not an external import):

```bash
grep -c "agentic-kanban/shared" packages/server/dist/cli.js
# Should be 0 (bundled in, not imported)
```

If >0, the esbuild config has `packages: "external"` — remove it and only list specific npm packages in the `external` array.

## 3. Bump version

Edit `packages/server/package.json` — increment the patch version (e.g. `"0.1.6"` → `"0.1.7"`).

## 4. Dry-run pack

```bash
cd packages/server
npm pack --dry-run
```

Verify:
- No "invalid" warnings for bin entries
- Tarball includes: `bin/cli.js`, `bin/mcp.js`, `dist/cli.js`, `dist/server.js`, `dist/mcp.js`, `dist/client/`, `dist/migrations/`
- Total files ~58, package size ~400KB

## 5. Publish

```bash
cd packages/server
npm publish --access public
```

If you get EOTP or E403, ask the user to set a valid npm token with publish permissions:
```bash
npm config set //registry.npmjs.org/:_authToken=<token>
```

## 6. Commit and push

```bash
cd <repo-root>
git add packages/server/package.json packages/server/bin/ packages/server/src/ packages/server/README.md scripts/
git commit -m "Bump to v<X.Y.Z>"
git push
```

## 7. Smoke test the published package (REQUIRED)

Not just "server boots" — the smoke test is the full loop: **register a project, create a ticket, run its workspace**. Run it against the REAL registry package, never the local build.

```bash
SMOKE=<scratch-dir>   # session scratchpad, NOT /tmp
mkdir -p "$SMOKE/data" "$SMOKE/repo"

# scratch project repo
cd "$SMOKE/repo" && git init -b master && echo "# Smoke" > README.md \
  && git add . && git -c user.email=smoke@test -c user.name=Smoke commit -m init

# install from the registry (npx fetch also works; install survives flaky npx)
cd "$SMOKE" && npm install agentic-kanban@<version>

# start from the repo dir — first run must auto-register the CWD project
cd "$SMOKE/repo" && AGENTIC_KANBAN_DIR="$SMOKE/data" PORT=3988 \
  "$SMOKE/node_modules/.bin/agentic-kanban"   # run in background
```

Then, via REST on :3988, verify each step:
1. `GET /api/projects` — the scratch repo was auto-registered (1 project).
2. `POST /api/issues` — create a trivial ticket ("append one line to README.md, commit").
3. `POST /api/workspaces` with `{"issueId":..., "provider":"claude", "claudeProfile":"anth"}` — **always pass provider + profile explicitly** (id-only defaults to codex). Response must show a worktree under `$SMOKE/repo/../.worktrees/` and `status: active`.
4. Poll `GET /api/workspaces/:id` until terminal; the branch must contain the README change (`git -C "$SMOKE/repo" log --oneline --all`). Auto-review runs first (`status: reviewing`) — wait for it to return to `idle`.
5. `POST /api/workspaces/:id/ready-for-merge` then `POST /api/workspaces/:id/merge` — merge alone returns `not_approved` until the workspace is marked ready. Verify master advanced: `git -C "$SMOKE/repo" show master:README.md` contains the new line.

Cleanup: kill ONLY the smoke server PID (from its startup log / `boardPid` in process-audit lines), then delete `$SMOKE`.

Gotchas seen in real runs:
- The published CLI has **no `start` subcommand** — the bare command starts the server; port via `PORT` env (`--port/--no-open` exist only on `dev`).
- `AGENTIC_KANBAN_DIR` isolates the DB; without it the smoke run writes `~/.agentic-kanban/kanban.db`.
- A native npm/npx crash or `ENOSPC` during install = **check disk space first** (`df -h /c`), not the package.

## Known pitfalls

- **bin wrappers**: `bin/cli.js` uses `import("../dist/cli.js")` (not `./dist/`) — relative to the bin/ dir
- **@agentic-kanban/shared**: must be bundled by esbuild, NOT left as external. Do NOT use `packages: "external"` — only list specific npm packages in the `external` array
- **serveStatic path**: must use absolute path from `__dirname`, not relative `"./client"` (resolves to CWD, which is wrong for npx)
- **prepublishOnly guard**: do NOT add a prepublishOnly script that exits 1 — it blocks npm publish
- **WAL files**: never commit `kanban.db-shm` or `kanban.db-wal`
