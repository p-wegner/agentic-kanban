/**
 * Pure, client-safe helpers for the deterministic Docker Compose project name the
 * board assigns to a workspace's service stack.
 *
 * The name MUST be deterministic + project-scoped so teardown and the startup reaper
 * never have to guess which stacks are ours: `ak-<projectId8>-ws-<offset>`, sanitized
 * to Compose's legal charset (`[a-z0-9-]`, lowercase). Host PORTS, by contrast, are
 * allocated from free ports at create time (see server `port-allocator.ts`) — only the
 * NAME is derived.
 *
 * No Node builtins here — safe to export as VALUES from the shared lib barrel.
 */

/** Prefix marking a Compose project the board owns. */
const MANAGED_PREFIX = "ak-";
/** Infix separating the project scope from the workspace offset. */
const WS_INFIX = "-ws-";

/** Lowercase and strip everything but `[a-z0-9-]` (Compose project-name rules). */
function sanitizeComposeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * The first 8 chars of a project id, lowercased with non-alphanumerics stripped —
 * the project scope embedded in a compose project name.
 */
export function projectScope(projectId: string): string {
  return projectId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
}

/**
 * Deterministic, project-scoped, Compose-legal stack name for a workspace:
 * `ak-<projectId8>-ws-<offset>`. Fully sanitized to `[a-z0-9-]`.
 */
export function composeProjectName(projectId: string, offset: number): string {
  const scope = projectScope(projectId);
  return sanitizeComposeSegment(`${MANAGED_PREFIX}${scope}${WS_INFIX}${offset}`);
}

/** true if a compose project name is one WE manage (prefix `ak-` + `-ws-` infix). */
export function isManagedComposeProject(name: string): boolean {
  return name.startsWith(MANAGED_PREFIX) && name.includes(WS_INFIX);
}
