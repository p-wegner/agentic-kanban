/**
 * Per-workspace Docker Compose "service stack" contract.
 *
 * A project may declare a Compose stack (e.g. a postgres sidecar) that the board
 * brings UP on workspace create and DOWN on merge/delete/abandon. Every workspace
 * gets its OWN isolated stack — its own deterministic compose project name and its
 * own free host ports — so many tickets can run in parallel without collisions.
 *
 * Pure type module (no runtime values that touch Node builtins) — safe to re-export
 * from the shared types barrel and reach the client bundle.
 *
 * See docs/decisions/011-per-workspace-service-stacks.md.
 */

export interface ServiceStackConfig {
  enabled: boolean;
  /** compose file path relative to its repo root. Default "docker-compose.yml". */
  composeFile: string;
  /** name of the repo holding the compose file; null/undefined = the leading repo. */
  composeRepo?: string | null;
  /** named host ports to allocate; injected into the env file as KANBAN_SVC_<UPPER>_PORT. */
  ports?: string[];
  /**
   * Compose profiles to ACTIVATE for this stack (services gated behind a `profiles:` key
   * in the compose file). The board runs `docker compose up` with NO `--profile` flag, so
   * a profile-gated service is omitted by default; listing its profile here emits
   * `COMPOSE_PROFILES=<comma-joined>` into the generated `--env-file`, which docker compose
   * reads to enable exactly those profiles. Empty/absent = default (only unprofiled
   * services start). Names must be shell-safe (no whitespace, CR/LF, single quotes, or
   * commas — a comma would be parsed as a profile separator).
   */
  profiles?: string[];
  /** ms to wait for `up --wait`; default 120000. */
  readyTimeoutMs?: number;
  /** extra static env vars written into the generated env file verbatim. */
  env?: Record<string, string>;
}

export interface ServiceStackState {
  composeProjectName: string;
  /** name -> allocated host port */
  ports: Record<string, number>;
  /** absolute path of the generated env file inside the compose worktree */
  envFilePath: string;
  status: "up" | "error" | "down";
  error?: string;
  /**
   * True when the stack was DELIBERATELY not started because the board is at its
   * `max_concurrent_stacks` admission cap (#56) — NOT a provisioning failure. Carried
   * as a distinct flag (rather than a 4th `status`) so every existing teardown/reaper
   * path that switches on "up"/"error"/"down" is unchanged: a deferred stack has status
   * "error" (nothing came up, nothing to reap), but consumers can tell a capacity
   * refusal from a real error and avoid crying wolf. The stack starts on the next
   * provisioning attempt once capacity frees up.
   */
  deferred?: boolean;
  updatedAt: string;
}

export const DEFAULT_SERVICE_STACK_CONFIG: ServiceStackConfig = {
  enabled: false,
  composeFile: "docker-compose.yml",
  ports: [],
  readyTimeoutMs: 120000,
};
