import { homedir } from "node:os";
import { existsSync as fsExistsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for resolving the kanban.db location.
 *
 * Both the HTTP server (`packages/server/src/db/data-dir.ts`) and the MCP server
 * (`packages/mcp-server/src/db.ts`) resolve the DB through THIS function so they
 * agree on ONE precedence. They previously diverged: the server let
 * `AGENTIC_KANBAN_DIR` win over an in-checkout dev DB, while the MCP server let a
 * present dev DB outrank `AGENTIC_KANBAN_DIR` — so with the env var set and a dev
 * DB on disk the two processes silently opened DIFFERENT databases (wrong-board
 * reads/writes, the recurring "board looks empty" worktree incident). See #962.
 *
 * Precedence — an EXPLICIT env override ALWAYS wins over the on-disk probe:
 *   1. `DB_URL`               — explicit connection URL, used verbatim.
 *   2. `AGENTIC_KANBAN_DIR`   — explicit data dir; `<dir>/kanban.db`.
 *   3. in-checkout dev DB     — the first `localDbCandidates` path that exists.
 *   4. home-dir fallback      — `~/.agentic-kanban/kanban.db`.
 *
 * Pure and dependency-injectable (env / existsSync / homeDir) so it is unit
 * testable without touching real disk. The only caller-specific input is the
 * ordered list of in-checkout `kanban.db` candidate paths, which differ by the
 * calling package's location on disk.
 */
export type DbPathSource =
  | "DB_URL"
  | "AGENTIC_KANBAN_DIR"
  | "local-checkout"
  | "home-fallback";

export interface DbLocation {
  /** libsql connection url — `file:<abs>` for a file DB, or the verbatim `DB_URL`. */
  url: string;
  /** absolute path to the DB file, or `null` when `url` is not a `file:` URL. */
  path: string | null;
  /** directory that should contain the DB (for backups / mkdir), or `null`. */
  dir: string | null;
  /** which precedence rule decided the location — surfaced in startup logs. */
  source: DbPathSource;
}

export interface ResolveDbLocationOptions {
  /**
   * Ordered absolute candidate `kanban.db` file paths probed for an in-checkout
   * dev DB. The first one that exists wins. Package-specific (relative to the
   * calling module's location), which is why it is passed in rather than derived.
   */
  localDbCandidates?: readonly string[];
  /** Injected for tests; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to `node:fs` `existsSync`. */
  existsSync?: (p: string) => boolean;
  /** Injected for tests; defaults to `node:os` `homedir()`. */
  homeDir?: string;
}

/**
 * Extract the on-disk path from a `file:` DB_URL. A proper `file://` URL with a
 * Windows drive letter (`file:///C:/Users/...`) MUST go through `fileURLToPath` —
 * naively slicing the `file:` scheme off leaves the URL's leading `///`, which
 * `path.resolve`/`dirname` then treat as `/C:/...` and rewrite into a bogus
 * `<drive>:/C:/...` location (silently breaking `createBackup` on Windows). Plain
 * `file:/relative/or/unix/path` strings (no drive letter, used verbatim in a few
 * tests/configs) aren't valid Windows file URLs — `fileURLToPath` throws on those,
 * so fall back to the old scheme-strip for them.
 */
function filePathFromFileUrl(fileUrl: string): string {
  try {
    return fileURLToPath(fileUrl);
  } catch {
    return fileUrl.slice("file:".length);
  }
}

function fileUrl(path: string): DbLocation {
  const abs = resolve(path);
  return { url: `file:${abs}`, path: abs, dir: dirname(abs), source: "AGENTIC_KANBAN_DIR" };
}

export function resolveDbLocation(opts: ResolveDbLocationOptions = {}): DbLocation {
  const env = opts.env ?? process.env;
  const exists = opts.existsSync ?? fsExistsSync;
  const home = opts.homeDir ?? homedir();
  const candidates = opts.localDbCandidates ?? [];

  // 1. DB_URL — explicit connection URL, verbatim. A non-`file:` URL (e.g. a
  //    remote libsql endpoint) has no on-disk path/dir.
  const dbUrl = env.DB_URL;
  if (dbUrl) {
    const path = dbUrl.startsWith("file:") ? filePathFromFileUrl(dbUrl) : null;
    return { url: dbUrl, path, dir: path ? dirname(path) : null, source: "DB_URL" };
  }

  // 2. AGENTIC_KANBAN_DIR — explicit data dir. Env ALWAYS wins over the
  //    in-checkout dev-DB probe below (the #962 split-brain fix).
  const envDir = env.AGENTIC_KANBAN_DIR;
  if (envDir) {
    return { ...fileUrl(resolve(envDir, "kanban.db")), source: "AGENTIC_KANBAN_DIR" };
  }

  // 3. In-checkout dev DB — only when one actually exists on disk.
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return { ...fileUrl(candidate), source: "local-checkout" };
    }
  }

  // 4. Home-dir fallback: ~/.agentic-kanban/kanban.db.
  return { ...fileUrl(join(home, ".agentic-kanban", "kanban.db")), source: "home-fallback" };
}
