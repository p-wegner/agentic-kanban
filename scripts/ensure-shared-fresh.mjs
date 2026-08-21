// No shebang, deliberately. This module is IMPORTED by dev-script.test.mjs, so vitest
// transforms it — and a transformed `#!` line is a syntax error unless the transform's
// shebang strip recognises it, which it does not do for the CRLF form every Windows
// checkout receives. That combination took the pre-merge gate down for every branch
// (#703). The shebang bought nothing: the only entry point is `node
// scripts/ensure-shared-fresh.mjs` in package.json's `typecheck`, never `./ensure-…`.
// Keep it off any script that is also imported.
/**
 * Rebuild `packages/shared/dist` when it is older than `packages/shared/src` (#582).
 *
 * `tsc` resolves `@agentic-kanban/shared` through the package's `types`/`import` exports —
 * i.e. `dist` — while DEV (`tsx --conditions development`) and Vite resolve `src`. So a main
 * checkout that MERGES a shared-package change and does not rebuild typechecks its server,
 * mcp-server and client against a `.d.ts` from before that merge. The failure mode is not a
 * missing module but a plausible, specific error in innocent consuming code — measured:
 * `Type '"stalled"' is not assignable to ...` for a union member that shared/src does declare.
 * The natural response is to "fix" the consumer by deleting the correct literal.
 *
 * It is worse than an inconvenience because `pnpm typecheck` runs from the PostToolUse hook,
 * so a stale artifact BLOCKS edits to unrelated files, and the merge gate never reproduces it
 * (a worktree runs `pnpm install -r`, whose `prepare` rebuilds shared — only the main checkout
 * rots).
 *
 * Why a freshness check and not the `development` condition in a typecheck-only tsconfig: the
 * client has no `@types/node`, and resolving shared to `src` pulls its node-only modules into
 * the client's program — the fix would have required giving the client node types, which is
 * exactly the guarantee `barrel-client-safety.test.ts` exists to keep. One mtime walk covers
 * all three consumers and leaves that guarantee intact.
 *
 * Cost when fresh: one directory walk (single-digit ms), no build.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncPnpm } from "./pnpm-exec.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sharedDir = join(repoRoot, "packages", "shared");

/** Newest mtime under `dir`, or 0 when it does not exist. Skips nothing else — a tree this size is cheap. */
function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // a file that vanished mid-walk cannot be the newest one that matters
      }
    }
  }
  return newest;
}

export function sharedBuildIsStale(srcMtime, distMtime) {
  // A missing dist (distMtime 0) is stale by definition. Equal timestamps are fresh: a build
  // writes dist AFTER reading src, so dist >= src is the healthy state.
  return distMtime < srcMtime;
}

function main() {
  const src = newestMtime(join(sharedDir, "src"));
  const dist = newestMtime(join(sharedDir, "dist"));
  if (!sharedBuildIsStale(src, dist)) return 0;

  const reason = dist === 0 ? "packages/shared/dist is missing" : "packages/shared/dist is older than src";
  console.log(`[shared] ${reason} — rebuilding so typecheck does not read a stale .d.ts (#582)`);
  const res = spawnSyncPnpm(["--filter", "@agentic-kanban/shared", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error("[shared] rebuild FAILED — the errors above are in packages/shared, not in the file you edited");
    return res.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("ensure-shared-fresh.mjs")) {
  process.exit(main());
}
