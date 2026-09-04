import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDevBoardRole } from "./dev-port-plan.mjs";

export function buildDevPortEnv(serverPort, clientPort, env = process.env, supervisorPid = process.pid) {
  return {
    PORT: String(serverPort),
    VITE_PORT: String(clientPort),
    SERVER_PORT: String(serverPort),
    KANBAN_SERVER_PORT: String(serverPort),
    KANBAN_WORKTREE_SERVER_PORT: String(serverPort),
    KANBAN_CLIENT_PORT: String(clientPort),
    KANBAN_WORKTREE_CLIENT_PORT: String(clientPort),
    KANBAN_BOARD_SERVER_PID: String(supervisorPid),
    KANBAN_PROTECTED_PIDS: [env.KANBAN_PROTECTED_PIDS, String(supervisorPid)]
      .filter(Boolean)
      .join(","),
  };
}

/** Where a dev-board database lives by default: a data dir of its own, beside the operated one. */
const DEV_BOARD_DB_DIRNAME = ".agentic-kanban-dev";
const DEV_BOARD_DB_FILENAME = "kanban.db";

/** `file:`-URL form of an absolute path, in the spelling `db-path.ts` expects. */
function fileUrl(absPath) {
  return `file:${resolve(absPath).replace(/\\/g, "/")}`;
}

/**
 * The two databases the dev board must NEVER open, whatever it was told (#1013).
 *
 * `~/.agentic-kanban/kanban.db` is the home fallback — TODAY's live board data, and the file the
 * stable board is pinned to. `<checkout>/packages/server/kanban.db` is the in-checkout dev DB,
 * i.e. what `resolveDbLocation`'s `local-checkout` rung would adopt if the pin were ever dropped.
 * Either one under a board that is allowed to be red and to register fixture projects is the
 * whole failure this split exists to prevent, so it is asserted rather than merely documented.
 */
export function operatedDbUrls({ homeDir = homedir(), repoRoot = process.cwd() } = {}) {
  return [
    fileUrl(join(homeDir, ".agentic-kanban", "kanban.db")),
    fileUrl(join(repoRoot, "packages", "server", "kanban.db")),
  ];
}

/**
 * The dev board's database URL, or `null` when this is not a dev-board run.
 *
 * An explicit `KANBAN_DB_URL` in the environment WINS — an operator pointing the dev board at a
 * snapshot of their choosing is the documented workflow (`docs/two-boards.md`), and silently
 * overriding it would be worse than honouring it. What is not negotiable is the isolation
 * assertion below, which applies to the operator's value too.
 */
export function resolveDevBoardDbUrl({ env = process.env, homeDir = homedir() } = {}) {
  if (!isDevBoardRole(env)) return null;
  if (env.KANBAN_DB_URL) return env.KANBAN_DB_URL;
  return fileUrl(join(homeDir, DEV_BOARD_DB_DIRNAME, DEV_BOARD_DB_FILENAME));
}

/** Throws when `dbUrl` names one of {@link operatedDbUrls}. Case-insensitive: Windows paths. */
export function assertDevBoardDbIsolated(dbUrl, { homeDir = homedir(), repoRoot = process.cwd() } = {}) {
  const forbidden = operatedDbUrls({ homeDir, repoRoot });
  const normalized = String(dbUrl).trim().toLowerCase();
  const hit = forbidden.find((f) => f.toLowerCase() === normalized);
  if (hit) {
    throw new Error(
      `[dev] KANBAN_BOARD_ROLE=dev refuses to open ${hit}.\n` +
        "That is the OPERATED board's database — the stable board on 3001/5173 is pinned to it, and\n" +
        "the dev board is allowed to be red and to register throwaway fixture projects. Point\n" +
        "KANBAN_DB_URL at a database of its own (see docs/two-boards.md), or unset it to get the\n" +
        `default ${fileUrl(join(homeDir, DEV_BOARD_DB_DIRNAME, DEV_BOARD_DB_FILENAME))}.`,
    );
  }
  return dbUrl;
}

/**
 * The env additions that make a `pnpm dev` the DEV board — `{}` for every other run, so the
 * default path is byte-for-byte today's behaviour.
 *
 * Companion to {@link buildDevPortEnv}: ports there, database here, both driven by the single
 * `KANBAN_BOARD_ROLE` switch so the pair cannot be set apart.
 */
export function buildBoardRoleEnv({ env = process.env, homeDir = homedir(), repoRoot = process.cwd() } = {}) {
  const dbUrl = resolveDevBoardDbUrl({ env, homeDir });
  if (!dbUrl) return {};
  assertDevBoardDbIsolated(dbUrl, { homeDir, repoRoot });
  return { KANBAN_DB_URL: dbUrl };
}
