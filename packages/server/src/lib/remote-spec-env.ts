// Environment allowlist for REMOTE (fleet-worker) launch specs (#244).
//
// A host launch inherits the board server's whole `process.env` — that is
// correct, because the agent runs on the board's own machine with the board
// owner's own logins. A REMOTE launch is a different trust boundary: the spec
// crosses a WebSocket to another machine (no TLS on the fleet listener) and is
// spawned there. Decision 012 states "board agent credentials are NEVER sent to
// a worker — a worker authenticates its agent with its own machine-local login",
// so the remote spec env must be built from an explicit ALLOWLIST of non-secret
// board WIRING, never from a copy of `process.env`.
//
// Two rules make this hold:
//  1. Only the keys listed here cross the wire (allowlist, not denylist — a new
//     env var on the board host cannot silently start leaking).
//  2. A defence-in-depth `looksSecretEnvKey` check drops anything credential-
//     shaped even if it were somehow added to the list by a later edit.
//
// The worker MERGES this map over its OWN environment (see
// worker-agent-runner.ts), so its local login, HOME/USERPROFILE, PATH and
// provider config dir always win. Consequence, by design: a board-side profile's
// `ANTHROPIC_MODEL`/`ANTHROPIC_BASE_URL` does NOT reach a remote worker — model
// selection travels in argv, and the endpoint/credential is the worker's own.

import { gradleUserHomeForWorktree } from "@agentic-kanban/shared/lib/gradle-env";

/**
 * Non-secret board wiring a remote agent needs. Every entry must be safe to read
 * on a foreign machine AND safe to appear in a plaintext WebSocket frame.
 */
export const REMOTE_SPEC_ENV_ALLOWLIST: readonly string[] = [
  // Terminal behaviour — the board wants machine-readable output.
  "FORCE_COLOR",
  "NO_COLOR",
  // Session identity: how the agent's own board calls tag themselves.
  "KANBAN_SESSION_ID",
  "AGENTIC_KANBAN_SESSION_ID",
  "KANBAN_SESSION_TYPE",
  // Board + worktree port wiring.
  "KANBAN_BOARD_SERVER_PORT",
  "KANBAN_BOARD_CLIENT_PORT",
  "KANBAN_SERVER_PORT",
  "KANBAN_CLIENT_PORT",
  "KANBAN_WORKTREE_SERVER_PORT",
  "KANBAN_WORKTREE_CLIENT_PORT",
  "SERVER_PORT",
  "PORT",
  "VITE_PORT",
  // Process-safety wiring. Only meaningful for a worker that shares this
  // machine (the pids are board-host pids); harmless elsewhere, and the safety
  // hooks read them to avoid killing the board.
  "KANBAN_BOARD_SERVER_PID",
  "KANBAN_PROTECTED_PIDS",
  // Non-secret launch metadata.
  "KANBAN_WORKTREE_BRANCH",
  "KANBAN_AGENT_HANG_TIMEOUT_MS",
];

const ALLOWED = new Set(REMOTE_SPEC_ENV_ALLOWLIST);

/**
 * Credential-shaped key names. Belt-and-braces: nothing matching this may cross
 * to a worker even if it is allowlisted, so a careless future addition to the
 * list above cannot reopen the leak.
 */
export function looksSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (/(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION_KEY|APIKEY|_KEY|^KEY$|AUTH)/.test(upper)) {
    return true;
  }
  // Provider-owned namespaces carry endpoints and keys; the worker owns these.
  return ["ANTHROPIC_", "OPENAI_", "AZURE_", "AWS_", "GOOGLE_", "GH_", "GITHUB_", "NPM_", "CLAUDE_", "CODEX_", "COPILOT_", "PI_"]
    .some((prefix) => upper.startsWith(prefix));
}

export interface RemoteSpecEnvParams {
  /** The fully composed host-launch env (provider env + ports + extraEnv). */
  env: Record<string, string | undefined>;
  /**
   * True when the worker shares the board's filesystem, so board-host paths are
   * valid there. Only then may path-valued wiring (GRADLE_USER_HOME) cross.
   */
  sharesFilesystem: boolean;
  /** Worktree path used to derive GRADLE_USER_HOME for same-filesystem workers. */
  worktreePath?: string;
}

/**
 * Project a host-launch env down to what a remote worker may receive.
 * Everything not explicitly allowed is dropped — silently, because the drop is
 * the intended behaviour, not an error.
 */
export function buildRemoteSpecEnv(params: RemoteSpecEnvParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.env)) {
    if (value === undefined) continue;
    if (!ALLOWED.has(key)) continue;
    if (looksSecretEnvKey(key)) continue;
    out[key] = value;
  }
  // A same-machine worker runs in the board's own worktree, so per-worktree
  // Gradle isolation (#194) still applies. A true remote worker has its own
  // checkout at its own path — a board path there would name nothing.
  if (params.sharesFilesystem && params.worktreePath) {
    out.GRADLE_USER_HOME = gradleUserHomeForWorktree(params.worktreePath);
  }
  return out;
}
