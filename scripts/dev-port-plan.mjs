const DEFAULT_SERVER_PORT = 3001;
const DEFAULT_CLIENT_PORT = 5173;

/**
 * The DEV BOARD's ports (proposal `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §3.A).
 *
 * Two boards run on this machine at once. The STABLE board (the built artifact, which operates
 * every project including `agentic-kanban` itself) keeps 3001/5173 so MCP configs, skills and
 * hooks — every one of which reaches the board through the `resolveBoardServerPort` ladder whose
 * floor is 3001 — keep working untouched. The DEV board (this checkout, `pnpm dev`, allowed to be
 * red) moves out of the way onto 3101/5273.
 *
 * 100 above the stable base on purpose, and NOT a claim that the two ranges are disjoint: the
 * worktree convention adds the issue number to the base and issue numbers are already past 1000,
 * so no fixed gap could make that true. What the gap does buy is that the low, frequently-hit
 * offsets — a `feature/ak-N` worktree for N < 100 — never land on the other board's own port.
 */
const DEV_BOARD_SERVER_PORT = 3101;
const DEV_BOARD_CLIENT_PORT = 5273;

export { DEFAULT_SERVER_PORT, DEFAULT_CLIENT_PORT, DEV_BOARD_SERVER_PORT, DEV_BOARD_CLIENT_PORT };

/**
 * `KANBAN_BOARD_ROLE` — which of the two boards this `pnpm dev` is.
 *
 * `dev` selects the dev-board ports above AND the dev-board database (see `resolveDevBoardDbUrl`
 * in dev-env.mjs). Anything else — including unset — is the stable/default role, i.e. exactly
 * today's behaviour, so nothing changes for a checkout that never sets it.
 *
 * Deliberately ONE variable for both decisions rather than two: a board listening on the dev
 * ports while pointing at the operated database is precisely the split-brain this mechanism
 * exists to prevent, so the two must not be settable apart.
 */
export function isDevBoardRole(env = process.env) {
  return String(env.KANBAN_BOARD_ROLE ?? "").trim().toLowerCase() === "dev";
}

/**
 * `pnpm dev:devboard` — the one-command dev-board mode (#1013).
 *
 * A flag as well as the env var, because the two boards are started by hand from shells whose
 * env syntax differs (`KANBAN_BOARD_ROLE=dev pnpm dev` is not a thing in PowerShell) and one npm
 * script that works everywhere is the point. The env var stays the primary channel — this only
 * SETS it — so everything downstream reads the same `KANBAN_BOARD_ROLE` whichever door was used.
 */
export function applyBoardRoleFlag(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--dev-board")) env.KANBAN_BOARD_ROLE = "dev";
  return env;
}

export function getIssueNumber(branchName) {
  const match = branchName.match(/^feature\/(?:ak-)?(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

export function branchHash(branchName) {
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = (hash * 31 + branchName.charCodeAt(i)) & 0xffff;
  }
  // Use range 101-1000 to avoid collisions with issue numbers 1-100
  return (hash % 900) + 101;
}

export function resolveDevPorts({ isWorktree, branch, env = process.env }) {
  const devBoard = isDevBoardRole(env);
  const baseServerPort = devBoard ? DEV_BOARD_SERVER_PORT : DEFAULT_SERVER_PORT;
  const baseClientPort = devBoard ? DEV_BOARD_CLIENT_PORT : DEFAULT_CLIENT_PORT;

  if (isWorktree && branch) {
    const issueNum = getIssueNumber(branch);
    const offset = issueNum !== null ? issueNum : branchHash(branch);
    const serverPort = baseServerPort + offset;
    const clientPort = baseClientPort + offset;
    return { serverPort, clientPort, offset };
  }

  return { serverPort: baseServerPort, clientPort: baseClientPort, offset: 0 };
}
