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

## Known pitfalls

- **bin wrappers**: `bin/cli.js` uses `import("../dist/cli.js")` (not `./dist/`) — relative to the bin/ dir
- **@agentic-kanban/shared**: must be bundled by esbuild, NOT left as external. Do NOT use `packages: "external"` — only list specific npm packages in the `external` array
- **serveStatic path**: must use absolute path from `__dirname`, not relative `"./client"` (resolves to CWD, which is wrong for npx)
- **prepublishOnly guard**: do NOT add a prepublishOnly script that exits 1 — it blocks npm publish
- **WAL files**: never commit `kanban.db-shm` or `kanban.db-wal`
