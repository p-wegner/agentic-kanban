import { homedir, tmpdir } from "node:os";
import { existsSync as fsExistsSync, statSync as fsStatSync } from "node:fs";
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
  | "home-fallback"
  | "test-throwaway";

export interface DbLocation {
  /** libsql connection url — `file:<abs>` for a file DB, or the verbatim `DB_URL`. */
  url: string;
  /** absolute path to the DB file, or `null` when `url` is not a `file:` URL. */
  path: string | null;
  /** directory that should contain the DB (for backups / mkdir), or `null`. */
  dir: string | null;
  /** which precedence rule decided the location — surfaced in startup logs. */
  source: DbPathSource;
  /**
   * In-checkout candidates that EXIST on disk but were rejected as stubs by the size
   * floor. Almost always the fingerprint of a real problem — a schema-only DB that some
   * tool (historically `drizzle-kit` with its old hardcoded `file:kanban.db`) minted in
   * the checkout. Returned rather than logged so this function stays pure; every caller
   * that logs its resolution logs these too, because the failure mode being guarded
   * against is precisely a SILENT choice of the wrong database.
   */
  rejectedLocalCandidates: string[];
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
  /** Injected for tests; defaults to `node:fs` `statSync`. */
  statSync?: (p: string) => { size: number };
  /** Injected for tests; defaults to `node:os` `homedir()`. */
  homeDir?: string;
}

/**
 * A `file:` URL is CREATED by the libsql client the moment something opens it —
 * `resolveDbLocation` never opens anything itself, but returning a candidate as
 * `local-checkout` is what makes a caller open (and thereby create) it. #165: a
 * stray process once materialized an empty `packages/server/kanban.db` (a probe,
 * a crashed migration run, a dev tool that deliberately targets the checkout
 * path) and from then on `existsSync` alone made EVERY later process — including
 * read-only CLI commands — permanently and silently pin to that empty shadow
 * file instead of falling through to the real home-fallback DB. A present file is
 * therefore not enough; it must also look like a real database. Table-level
 * introspection would be the precise check but requires opening a DB connection
 * (defeating the point), so this is a size floor: an accidental stub is at most a
 * few KB, while a DB anyone has actually used is reliably larger. It is a
 * heuristic, not a proof — the CLI's loud resolution-change warning (`db-warning.ts`
 * / `cli/last-resolved-db.ts`) is the backstop for whatever this floor misses.
 */
const MIN_VALID_LOCAL_DB_BYTES = 12_288;

function isValidLocalDb(candidate: string, stat: (p: string) => { size: number }): boolean {
  try {
    return stat(candidate).size >= MIN_VALID_LOCAL_DB_BYTES;
  } catch {
    return false;
  }
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
  return { url: `file:${abs}`, path: abs, dir: dirname(abs), source: "AGENTIC_KANBAN_DIR", rejectedLocalCandidates: [] };
}

export function resolveDbLocation(opts: ResolveDbLocationOptions = {}): DbLocation {
  const env = opts.env ?? process.env;
  const exists = opts.existsSync ?? fsExistsSync;
  const stat = opts.statSync ?? fsStatSync;
  const home = opts.homeDir ?? homedir();
  const candidates = opts.localDbCandidates ?? [];

  // 1. DB_URL — explicit connection URL, verbatim. A non-`file:` URL (e.g. a
  //    remote libsql endpoint) has no on-disk path/dir.
  const dbUrl = env.DB_URL;
  if (dbUrl) {
    const path = dbUrl.startsWith("file:") ? filePathFromFileUrl(dbUrl) : null;
    return { url: dbUrl, path, dir: path ? dirname(path) : null, source: "DB_URL", rejectedLocalCandidates: [] };
  }

  // 2. AGENTIC_KANBAN_DIR — explicit data dir. Env ALWAYS wins over the
  //    in-checkout dev-DB probe below (the #962 split-brain fix).
  const envDir = env.AGENTIC_KANBAN_DIR;
  if (envDir) {
    return { ...fileUrl(resolve(envDir, "kanban.db")), source: "AGENTIC_KANBAN_DIR" };
  }

  // 2b. Test runner with NO explicit override — NEVER resolve real data (#231). The silent
  //     fall-through below is how the pre-merge verify gate's vitest workers opened the
  //     user's LIVE board DB: they contended with the running server for SQLite locks
  //     (pinning six suites at their 60s timeout) and one suite wrote junk projects into
  //     production data. A test that genuinely needs a specific DB must say so explicitly
  //     via DB_URL or AGENTIC_KANBAN_DIR (both win above); everything else gets a
  //     per-process throwaway file, so a module-load side effect that opens the singleton
  //     can never reach real data. Loud by design: callers log `source: test-throwaway`.
  if (env.VITEST || env.NODE_ENV === "test") {
    // Directly in tmpdir() (no subdirectory) so the file's parent always exists — this
    // function stays pure and never mkdirs.
    const throwaway = join(tmpdir(), `agentic-kanban-vitest-${process.pid}.db`);
    return { ...fileUrl(throwaway), source: "test-throwaway", rejectedLocalCandidates: [] };
  }

  // 3. In-checkout dev DB — only when one actually exists on disk AND looks like
  //    a real database (see isValidLocalDb above). A present-but-empty/stub file
  //    falls through to the home-dir fallback rather than being opened (and so
  //    permanently adopted) as-is.
  const rejectedLocalCandidates: string[] = [];
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    if (isValidLocalDb(candidate, stat)) {
      return { ...fileUrl(candidate), source: "local-checkout", rejectedLocalCandidates };
    }
    // Present but too small to be a real DB. Report it: silently skipping it is how a
    // stray stub stayed invisible while it shadowed (or nearly shadowed) the real DB.
    rejectedLocalCandidates.push(candidate);
  }

  // 4. Home-dir fallback: ~/.agentic-kanban/kanban.db.
  return { ...fileUrl(join(home, ".agentic-kanban", "kanban.db")), source: "home-fallback", rejectedLocalCandidates };
}
