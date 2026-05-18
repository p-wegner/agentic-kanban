# npx Deployment Guide

## Publishing Prerequisites

1. **npm account**: Create an account at [npmjs.com](https://npmjs.com)
2. **Login**: `npm login` (or `pnpm login`)
3. **Package scope**: The package is published as `agentic-kanban` (no scope — first-come-first-served on npm)
4. **Org consideration**: If the name is taken, publish under an org scope (e.g., `@agentic-kanban/kanban`)

## First Publish Checklist

1. Build the package:
   ```powershell
   pnpm build
   ```
2. Verify the dist output:
   ```powershell
   ls packages/server/dist/
   # Should see: cli.js, server.js, mcp.js, client/, migrations/
   ```
3. Test locally:
   ```powershell
   node packages/server/dist/cli.js --help
   node packages/server/dist/cli.js dev
   ```
4. Dry-run publish:
   ```powershell
   npm publish --dry-run
   ```
5. Publish:
   ```powershell
   npm publish
   ```

## Release Workflow

Uses [changesets](https://github.com/changesets/changesets) for versioning:

1. **Create a changeset** when making changes that should be released:
   ```powershell
   pnpm changeset
   ```
   Select packages affected and version bump type (patch/minor/major).

2. **Version bump** (consumes changesets, updates package.json versions):
   ```powershell
   pnpm version
   ```

3. **Build and publish**:
   ```powershell
   pnpm release
   ```
   This runs `pnpm build && changeset publish`.

## npx Usage

After publishing:

```powershell
# Start the full app (server + UI)
npx agentic-kanban dev

# Start with custom port
npx agentic-kanban dev --port 8080

# Register a git repo as a project
npx agentic-kanban register /path/to/repo

# List projects
npx agentic-kanban list

# Board status
npx agentic-kanban status

# MCP server (for Claude Code integration)
npx agentic-kanban-mcp
```

## MCP Server Configuration for Claude Code

Add to your project's `.claude/settings.json` or global settings:

```json
{
  "mcpServers": {
    "agentic-kanban": {
      "command": "npx",
      "args": ["-y", "agentic-kanban-mcp"],
      "env": {
        "DB_URL": "/path/to/kanban.db"
      }
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "agentic-kanban": {
      "command": "agentic-kanban-mcp",
      "env": {
        "DB_URL": "/path/to/kanban.db"
      }
    }
  }
}
```

## Beta/RC Channel Strategy

To publish a beta version:

1. Update version in `packages/server/package.json` to `0.2.0-beta.1`
2. Publish with tag: `npm publish --tag beta`
3. Users install with: `npx agentic-kanban@beta dev`

Or use changesets with prerelease mode:

```powershell
pnpm changeset pre enter beta
pnpm changeset version
pnpm release
pnpm changeset pre exit
```

## Architecture Notes

### Build output structure

```
packages/server/dist/
  cli.js              # CLI entry (bin: agentic-kanban)
  server.js           # Server entry (started by dev command)
  mcp.js              # MCP server entry (bin: agentic-kanban-mcp)
  client/             # Vite-built React app (index.html, assets/)
  migrations/         # Drizzle SQL migrations + journal
```

### How it works

- **esbuild** bundles `server/src` and `mcp-server/src` into single JS files, inlining `@agentic-kanban/shared`
- npm dependencies (hono, drizzle-orm, etc.) remain as regular `dependencies` — not bundled
- Client is built with Vite, output copied to `server/dist/client/`
- Migrations are copied to `server/dist/migrations/`
- At runtime, the server detects whether `./client/index.html` exists and serves static assets if so (production mode)
- The `dev` CLI command starts the server in-process and opens the browser

### Migration path resolution

The `getMigrationsFolder()` helper in `packages/server/src/db/migrations.ts` resolves migrations at runtime:
- Published mode: looks for `./migrations/` adjacent to the JS file
- Dev mode: falls back to `../../shared/drizzle` (monorepo relative path)
