import net from "node:net";

/**
 * Host-port allocator for per-workspace Docker service stacks.
 *
 * Service HOST ports are allocated at CREATE time (rather than derived deterministically)
 * so that stacks from different projects/workspaces never collide. The deterministic bit
 * is only the COMPOSE_PROJECT_NAME (see `@agentic-kanban/shared/lib/service-ports`); the
 * ports come from here.
 *
 * Two modes (#51, #54):
 *  - **Ranged** (KANBAN_STACK_PORT_RANGE set, e.g. "31000-31099"): draw ports from that
 *    fixed block — the SAME block the DinD sidecar publishes to the host
 *    (docker-compose.dind.yml). A stack port published in the range is then reachable
 *    from the host browser (#54), and the allocation is correct-BY-CONSTRUCTION for the
 *    publishing namespace: the range is dedicated to this board's stacks, so drawing an
 *    unused number from it (tracked in the reservation registry + the DB's live-stack
 *    ports) needs no `listen()` probe of the board's own — possibly wrong — kernel
 *    (#51 flaw 1). This is the recommended mode for any containerized/DinD deployment.
 *  - **Legacy** (range unset — native board-on-host, no DinD): fall back to OS-assigned
 *    ephemeral ports (`listen(0)`), which is correct when the board shares the host
 *    namespace.
 *
 * BOTH modes go through the in-process reservation registry, which closes the TOCTOU
 * (#51 flaw 2): the old allocator freed each `listen(0)` port the instant it was found,
 * so a second provisionWorkspaceServices starting in the window before compose binds
 * could be handed the same number. Every port handed out is held in `reserved` until the
 * provisioning call releases it (see `releaseStackPorts`), so concurrent allocations in
 * this process never overlap.
 *
 * Node-only (`node:net`).
 */

/**
 * Ports this process has handed out for a stack but not yet released. A port lands here
 * at allocation and leaves when the provisioning call that owns it calls
 * `releaseStackPorts` (on success the daemon then holds the real binding; on failure the
 * stack was downed). Spans the allocate→compose-up window that `listen(0)`'s
 * free-immediately behavior left open. Process-local by design: concurrent provisions
 * live in ONE board process, and cross-INSTANCE isolation is handled by the DB (each
 * board has its own DB; a live stack's ports are excluded via `getInUsePorts`).
 */
const reserved = new Set<number>();

export interface StackPortRange {
  start: number;
  end: number;
}

/**
 * Parse KANBAN_STACK_PORT_RANGE ("<start>-<end>", e.g. "31000-31099") into a range, or
 * null when unset/malformed (→ legacy ephemeral mode). The range MUST match the block
 * published on the `dind` service in docker-compose.dind.yml, or DinD stack ports won't
 * reach the host. A malformed value is warned and treated as unset rather than throwing,
 * so a typo degrades to the (safe) legacy behavior instead of breaking provisioning.
 */
export function resolveStackPortRange(env: NodeJS.ProcessEnv = process.env): StackPortRange | null {
  const raw = env.KANBAN_STACK_PORT_RANGE?.trim();
  if (!raw) return null;
  const m = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(raw);
  if (!m) {
    console.warn(`[services] ignoring malformed KANBAN_STACK_PORT_RANGE=${JSON.stringify(raw)} (expected "<start>-<end>"); using ephemeral ports`);
    return null;
  }
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!(start >= 1 && end <= 65535 && start <= end)) {
    console.warn(`[services] ignoring out-of-bounds KANBAN_STACK_PORT_RANGE=${JSON.stringify(raw)} (need 1..65535, start<=end); using ephemeral ports`);
    return null;
  }
  return { start, end };
}

/** Bind :0 on 127.0.0.1 to find one free TCP port. The server stays open until closed. */
function reservePort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") {
        server.close();
        reject(new Error("failed to obtain a free port (no address)"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/** Best-effort: can THIS process bind `port` on 127.0.0.1 right now? Only meaningful when
 *  the board shares the publishing namespace (native/board-on-host); in DinD/DooD it tests
 *  the wrong kernel, so ranged mode does not require it. */
function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * Bind :0 on 127.0.0.1 to find N free TCP ports, returning a name->port map. All
 * reservation sockets are held open until every port has been collected, then closed
 * — so the OS cannot hand the same port out twice within a single call.
 *
 * Legacy primitive: distinct-within-a-call but frees before returning (the #51-flaw-2
 * window). Prefer `createStackPortAllocator`, which layers the reservation registry on
 * top. Kept as the no-range fallback and for direct callers/tests.
 */
export async function allocateFreePorts(names: string[]): Promise<Record<string, number>> {
  const reservations: { port: number; close: () => Promise<void> }[] = [];
  try {
    for (let i = 0; i < names.length; i++) {
      reservations.push(await reservePort());
    }
    const result: Record<string, number> = {};
    for (let i = 0; i < names.length; i++) {
      result[names[i]] = reservations[i].port;
    }
    return result;
  } finally {
    // Release the OS reservations only AFTER collecting every port, so distinct ports
    // are guaranteed within one call. Compose (or whoever) then binds them for real.
    await Promise.all(reservations.map((r) => r.close()));
  }
}

export interface StackPortAllocatorOptions {
  /** The stack-port range; defaults to `resolveStackPortRange()` at call time. */
  range?: StackPortRange | null;
  /** Ports already bound by this board's live stacks (from the DB) — excluded so a
   *  restart or a stack persisted since the last allocation is never reused. */
  getInUsePorts?: () => Promise<number[]>;
  /** Probe each ranged candidate with a real bind before handing it out. Defaults to
   *  false (in a containerized/DinD deployment the bind tests the wrong namespace). Set
   *  true only for a native board that shares the publishing namespace. */
  probe?: boolean;
}

/** A stack-port allocator: name[] → name→port, reserving each port in the registry. */
export type StackPortAllocator = (names: string[]) => Promise<Record<string, number>>;

/**
 * Build the default stack-port allocator. Draws from the configured range (or ephemeral
 * when none), excluding both the in-process reservation registry and the caller's live
 * DB ports, and reserves every port it returns until `releaseStackPorts` frees it.
 */
export function createStackPortAllocator(opts: StackPortAllocatorOptions = {}): StackPortAllocator {
  return async function allocate(names: string[]): Promise<Record<string, number>> {
    const wanted = names.filter((n) => n.trim().length > 0);
    if (wanted.length === 0) return {};
    const range = opts.range === undefined ? resolveStackPortRange() : opts.range;
    const inUse = new Set<number>(opts.getInUsePorts ? await opts.getInUsePorts() : []);
    const result: Record<string, number> = {};
    const takenThisCall: number[] = [];
    try {
      for (const name of wanted) {
        const port = range
          ? await pickFromRange(range, inUse, opts.probe ?? false)
          : await pickEphemeral(inUse);
        result[name] = port;
        reserved.add(port);
        inUse.add(port);
        takenThisCall.push(port);
      }
      return result;
    } catch (err) {
      // Don't leak partial reservations if the range is exhausted mid-allocation.
      releaseStackPorts(takenThisCall);
      throw err;
    }
  };
}

/** Lowest unused port in the range, skipping the registry, live DB ports, and (when
 *  asked) anything this process can't currently bind. Throws when the range is full. */
async function pickFromRange(range: StackPortRange, inUse: Set<number>, probe: boolean): Promise<number> {
  for (let p = range.start; p <= range.end; p++) {
    if (reserved.has(p) || inUse.has(p)) continue;
    if (probe && !(await tryBind(p))) continue;
    return p;
  }
  throw new Error(
    `no free stack host port in KANBAN_STACK_PORT_RANGE ${range.start}-${range.end} ` +
      `(${reserved.size} reserved in-flight, ${inUse.size} held by live stacks) — ` +
      `lower the WIP limit or widen the range`,
  );
}

/** An OS-assigned ephemeral port not already in the registry/live set (legacy mode). */
async function pickEphemeral(inUse: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { port, close } = await reservePort();
    await close();
    if (!reserved.has(port) && !inUse.has(port)) return port;
  }
  throw new Error("failed to obtain a distinct free ephemeral port after 50 attempts");
}

/** Release stack ports back to the registry. No-op for ports never reserved (e.g. a test
 *  fake allocator's numbers), so callers can release unconditionally. */
export function releaseStackPorts(ports: Iterable<number>): void {
  for (const p of ports) reserved.delete(p);
}
