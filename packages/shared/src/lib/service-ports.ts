/**
 * Pure, client-safe helpers for the deterministic Docker Compose project name the
 * board assigns to a workspace's service stack.
 *
 * The name MUST be deterministic + UNIQUE PER WORKSPACE so teardown and the startup
 * reaper never destroy a sibling workspace's stack. It is keyed on the workspace's
 * unique id (NOT the branch offset — two workspaces on the same issue share an offset,
 * so an offset-keyed name would collide and one workspace's `down -v` would wipe the
 * other's live containers + volumes).
 *
 * The name is ALSO scoped to a per-server-instance id (persisted in that instance's
 * DB, see server `workspace-service-state.repository.ts`): the Docker daemon is shared
 * by every board instance on the host (main checkout + worktree dev servers on the
 * ~/.agentic-kanban fallback DB, DooD-containerized boards on the host socket), so a
 * purely global `ak-ws-*` namespace let one instance's startup reaper `down -v`
 * ANOTHER instance's live stacks. Shape: `ak-<instanceId8>-ws-<first 12 sanitized
 * chars of the workspace id>`, lowercased and stripped to Compose's legal charset.
 * Host PORTS, by contrast, are allocated from free ports at create time (see server
 * `port-allocator.ts`) — only the NAME is derived.
 *
 * No Node builtins here — safe to export as VALUES from the shared lib barrel.
 */

/** Strip a token down to Compose's legal lowercase-alphanumeric charset. */
function sanitizeToken(token: string, maxLen: number): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, maxLen);
}

/**
 * Deterministic, UNIQUE-per-workspace, instance-scoped, Compose-legal stack name:
 * `ak-<instanceId8>-ws-<first 12 alphanumerics of the workspace id, lowercased>`.
 * Keyed on the workspace's unique id so no two workspaces (even on the same issue)
 * ever collide, and on the server instance's persisted id so no two board INSTANCES
 * sharing one Docker daemon ever claim (or reap) each other's stacks.
 *
 * Throws on an empty/unsanitizable instance id — silently falling back to an
 * unscoped name would reopen the cross-instance reaping hazard.
 */
export function composeProjectName(workspaceId: string, instanceId: string): string {
  const inst = sanitizeToken(instanceId, 8);
  if (!inst) throw new Error("composeProjectName requires a non-empty alphanumeric instanceId");
  const scope = sanitizeToken(workspaceId, 12);
  return `ak-${inst}-ws-${scope}`;
}

/**
 * Precise matcher for names THIS INSTANCE generates: exactly `ak-<instanceId>-ws-` +
 * at least 6 lowercase alphanumerics and NOTHING ELSE. The startup reaper filters on
 * this BEFORE downing, so it can never touch:
 *  - another board instance's stacks (`ak-<otherId>-ws-…`) sharing the same daemon,
 *  - legacy pre-instance-scoped stacks (`ak-ws-…`) — left alone, never downed,
 *  - a user's unrelated compose project that merely resembles the shape.
 * Returns false (never a permissive fallback) when the instance id is unusable.
 */
export function isInstanceManagedComposeProject(name: string, instanceId: string): boolean {
  const inst = sanitizeToken(instanceId, 8);
  if (!inst) return false;
  return new RegExp(`^ak-${inst}-ws-[0-9a-z]{6,}$`).test(name);
}

/**
 * LEGACY matcher for the pre-instance-scoped shape (`ak-ws-<alnum6+>`). Retained only
 * so callers can RECOGNIZE old-format names (e.g. for display); the reaper must NOT
 * use it — legacy-named stacks may belong to ANY instance on the shared daemon and
 * are deliberately left alone (their normal merge/close/delete teardown still works
 * via the STORED name).
 */
const LEGACY_MANAGED_COMPOSE_RE = /^ak-ws-[0-9a-z]{6,}$/;

/** true if a compose project name matches the LEGACY unscoped shape (`ak-ws-<alnum>`). */
export function isManagedComposeProject(name: string): boolean {
  return LEGACY_MANAGED_COMPOSE_RE.test(name);
}
