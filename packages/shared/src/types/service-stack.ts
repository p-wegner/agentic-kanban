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
  updatedAt: string;
}

export const DEFAULT_SERVICE_STACK_CONFIG: ServiceStackConfig = {
  enabled: false,
  composeFile: "docker-compose.yml",
  ports: [],
  readyTimeoutMs: 120000,
};
