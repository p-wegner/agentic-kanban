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

/** The `ws`-token a workspace id maps to inside its compose project name (first 12
 *  sanitized chars). The STABLE cross-instance identity of a workspace's stack: it
 *  survives an instance-id change (the `ak-<inst>-` prefix does not), so the wide sweep
 *  can tell "still belongs to a live workspace" from "orphan" even after the id rotates. */
export function serviceStackWsToken(workspaceId: string): string {
  return sanitizeToken(workspaceId, 12);
}

const INSTANCE_SCOPED_COMPOSE_RE = /^ak-([0-9a-z]{1,8})-ws-([0-9a-z]{6,})$/;
const LEGACY_PARSE_RE = /^ak-ws-([0-9a-z]{6,})$/;

/** A board-managed compose project name, decomposed. `instanceId` is null for the
 *  legacy pre-instance-scoped shape (`ak-ws-<token>`), whose owning instance is
 *  unknowable. */
export interface ManagedComposeName {
  instanceId: string | null;
  wsToken: string;
}

/**
 * Recognize ANY board-managed compose project name — this instance's, ANOTHER
 * instance's (`ak-<otherId>-ws-…`), or the legacy unscoped shape — and pull out its
 * instance id + ws-token. Returns null for a name the board never generated. This is
 * the cross-instance recognizer the wide GC sweep needs (#53); the reaper's
 * `isInstanceManagedComposeProject` deliberately matches ONLY the current instance.
 */
export function parseManagedComposeName(name: string): ManagedComposeName | null {
  const scoped = INSTANCE_SCOPED_COMPOSE_RE.exec(name);
  if (scoped) return { instanceId: scoped[1], wsToken: scoped[2] };
  const legacy = LEGACY_PARSE_RE.exec(name);
  if (legacy) return { instanceId: null, wsToken: legacy[1] };
  return null;
}

/** Which managed stacks a wide sweep is allowed to consider. */
export type StackSweepScope =
  | { kind: "current" } // only THIS instance's names (the safe default)
  | { kind: "instance"; id: string } // a specific (e.g. stranded) instance id
  | { kind: "all" }; // every managed name, any instance (dangerous — co-tenant risk)

export interface StackSweepCandidate {
  name: string;
  instanceId: string | null;
  wsToken: string;
}

export interface StackSweepPlan {
  /** Orphans safe to `down -v` under the given scope. */
  reap: StackSweepCandidate[];
  /** Names left alone, each with why (for the dry-run listing). */
  keep: { name: string; reason: string }[];
}

/**
 * PURE planner for the wide orphaned-stack sweep (#53). Given the daemon's compose
 * project names, this instance's id, the ws-tokens of every LIVE workspace row in the
 * current DB, and a scope, decide what to reap.
 *
 * SAFETY — the co-tenant guard: a name is reaped only when its ws-token matches NO live
 * workspace row. ws-token is the stable identity that survives an instance-id rotation
 * (DB reset/restore, home-fallback), so a still-live workspace's stack is KEPT even
 * after its `ak-<inst>-` prefix stopped matching the reaper's exact filter — which is
 * the whole point of #53. Scope bounds the blast radius: `current` touches only names
 * carrying this instance's id; `instance` a named id (the operator asserting ownership
 * of a stranded id); `all` any managed name (must be operator-confirmed — a co-tenant
 * board on the same daemon has its OWN DB whose live tokens this planner cannot see).
 */
export function planStackSweep(args: {
  composeProjectNames: string[];
  currentInstanceId: string;
  liveWsTokens: Set<string>;
  scope: StackSweepScope;
}): StackSweepPlan {
  const reap: StackSweepCandidate[] = [];
  const keep: { name: string; reason: string }[] = [];
  for (const name of args.composeProjectNames) {
    const parsed = parseManagedComposeName(name);
    if (!parsed) {
      keep.push({ name, reason: "not-board-managed" });
      continue;
    }
    const inScope =
      args.scope.kind === "all"
        ? true
        : args.scope.kind === "instance"
          ? parsed.instanceId === args.scope.id
          : parsed.instanceId === args.currentInstanceId;
    if (!inScope) {
      keep.push({ name, reason: "out-of-scope" });
      continue;
    }
    if (args.liveWsTokens.has(parsed.wsToken)) {
      keep.push({ name, reason: "matches-live-workspace" });
      continue;
    }
    reap.push({ name, instanceId: parsed.instanceId, wsToken: parsed.wsToken });
  }
  return { reap, keep };
}
