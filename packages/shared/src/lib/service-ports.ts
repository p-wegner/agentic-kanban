/**
 * Pure, client-safe helpers for the deterministic Docker Compose project name the
 * board assigns to a workspace's service stack.
 *
 * The name MUST be deterministic + UNIQUE PER WORKSPACE so teardown and the startup
 * reaper never destroy a sibling workspace's stack. It is keyed on the workspace's
 * unique id (NOT the branch offset — two workspaces on the same issue share an offset,
 * so an offset-keyed name would collide and one workspace's `down -v` would wipe the
 * other's live containers + volumes). Shape: `ak-ws-<first 12 sanitized chars of the
 * workspace id>`, lowercased and stripped to Compose's legal charset. Host PORTS, by
 * contrast, are allocated from free ports at create time (see server `port-allocator.ts`)
 * — only the NAME is derived.
 *
 * No Node builtins here — safe to export as VALUES from the shared lib barrel.
 */

/** Prefix marking a Compose project the board owns (per-workspace). */
const MANAGED_PREFIX = "ak-ws-";

/**
 * Deterministic, UNIQUE-per-workspace, Compose-legal stack name:
 * `ak-ws-<first 12 alphanumerics of the workspace id, lowercased>`. Keyed on the
 * workspace's unique id so no two workspaces (even on the same issue) ever collide.
 */
export function composeProjectName(workspaceId: string): string {
  const scope = workspaceId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  return `${MANAGED_PREFIX}${scope}`;
}

/**
 * Precise matcher for names WE generate: exactly `ak-ws-` + at least 6 lowercase
 * alphanumerics and NOTHING ELSE. Deliberately strict so the reaper can never `down`
 * a user's unrelated compose project that merely happens to start with `ak-` or contain
 * `ws` (e.g. `ak-myapp-ws-1`).
 */
const MANAGED_COMPOSE_RE = /^ak-ws-[0-9a-z]{6,}$/;

/** true if a compose project name is one WE manage (`ak-ws-<alnum>`). */
export function isManagedComposeProject(name: string): boolean {
  return MANAGED_COMPOSE_RE.test(name);
}
