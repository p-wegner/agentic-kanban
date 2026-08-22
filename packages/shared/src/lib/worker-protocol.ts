// Wire protocol between the board and fleet workers (epic #1, phase 1b #4).
//
// Pure types + defensive parsers — no Node builtins, safe for any bundle. The
// board sends work over the worker's WebSocket; the worker streams agent
// output back as events shaped exactly like agent.service's AgentOutputEvent,
// so the board-side remote execution service can feed them straight into the
// normal session broadcast/exit machinery.

/**
 * A worker carrying this label shares the board's filesystem, so its assignments
 * skip git transport and run directly in the board-side worktree. Lives here —
 * in the dependency-free protocol module — because BOTH the board's placement
 * policy and the worker CLI need it, and the CLI must not pull in the server's
 * service graph (db/drizzle/hono) just to name a label.
 */
export const SHARES_FILESYSTEM_LABEL = "shares-filesystem";

/**
 * What the board WANTS launched, as opposed to how the board itself would launch it (#747).
 *
 * A launch config is built on the board, by board-side providers that resolve their
 * executable against the BOARD's platform: on Windows `claude-provider.ts` runs
 * `where claude.exe` and hands back an absolute `...\claude.exe`, and every provider
 * decides `useShell` from the board's own `process.platform`. Shipping those verbatim to a
 * worker meant only a same-OS fleet could ever run: a Windows board sent a Linux worker an
 * absolute `.exe` path (ENOENT), and a Linux board sent a Windows worker a bare `claude`
 * with `shell: false`, which cannot resolve the `.cmd` shim.
 *
 * So a cross-machine spec carries INTENT instead — which provider, which logical program —
 * and the worker resolves the executable and the shell decision on ITS OWN platform. The
 * board does not guess the worker's OS; resolution lives where the binary lives.
 *
 * When present, `intent` OUTRANKS `spec.command`/`spec.useShell` for command resolution.
 * `command` is still populated with the logical program name so an older worker (or one
 * that chooses not to resolve) has something usable, and `useShell` is left unset so no
 * board-shaped decision leaks in.
 */
export interface WorkerLaunchIntent {
  /** Agent provider this spec launches — "claude" | "codex" | "copilot" | "pi". */
  provider: string;
  /** Logical program to resolve on the worker's PATH: no directory, no `.exe`/`.cmd` suffix. */
  program: string;
}

/** Everything a worker needs to spawn one agent process. Fully serializable. */
export interface WorkerLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Initial prompt written to stdin after spawn (unless suppressStdinPrompt). */
  stdinPrompt?: string;
  /** Keep stdin open after the prompt for multi-turn follow-ups. */
  keepStdinOpen?: boolean;
  /** The prompt travels via argv; close stdin immediately without writing. */
  suppressStdinPrompt?: boolean;
  useShell?: boolean;
  /**
   * Platform-independent launch intent (#747). When set, the worker resolves the
   * executable and the shell decision itself and IGNORES `command`/`useShell`.
   */
  intent?: WorkerLaunchIntent;
  /**
   * Kill the agent after this many ms with no stdout/stderr. The BOARD decides
   * the policy (same rule as a host launch, 0 for mock agents) and the worker
   * enforces it, so a remote session keeps the hang protection a host session
   * has. Omitted = the worker falls back to its own default.
   */
  hangTimeoutMs?: number;
}

/**
 * Git-transport spec for TRUE remote execution (phase 2): the worker clones
 * the project from the board's git smart-HTTP listener, works in its own
 * checkout, and pushes the result to `incomingRef` (refs/kanban/incoming/*)
 * before reporting exit. The worker composes the full git URL from the board
 * host it already dials plus `gitPort`/`gitToken` — the board never needs to
 * know its own externally-visible hostname.
 */
export interface WorkerRepoTransport {
  projectId: string;
  gitPort: number;
  gitToken: string;
  branch: string;
  baseBranch: string;
  incomingRef: string;
  setupScript?: string;
  /** Agent skills to materialize into the checkout's .claude/skills/. */
  skills?: Array<{ name: string; description?: string; content: string }>;
  /**
   * Ticket-context files to write into the checkout ROOT, by BASENAME + CONTENT (#749).
   *
   * The board writes these (`TICKET_CONTEXT_FILENAME`, i.e. `CLAUDE.local.md`) into its
   * OWN worktree, where claude finds them as project memory and copilot attaches them by
   * path. A true-remote worker works in a checkout of its own, so neither happened there:
   * a claude/copilot builder on a fleet worker ran with no ticket context at all. Paths
   * cannot be shipped — they name nothing on the worker — so the CONTENT travels and the
   * worker materializes it next to the code, exactly where a board worktree has it.
   *
   * `name` is a bare filename; anything with a path separator is dropped on parse.
   */
  contextFiles?: Array<{ name: string; content: string }>;
}

/** Mirrors agent.service's AgentOutputEvent so events plug into broadcast as-is. */
export interface WorkerAgentEvent {
  type: "stdout" | "stderr" | "exit";
  sessionId: string;
  data?: string;
  exitCode?: number | null;
}

/**
 * The fleet wire protocol's version (#754).
 *
 * Before this, `hello` and `register` carried no version at all and an unknown message
 * type was dropped as "malformed" — so a board and a worker built from different commits
 * failed as a silence, and with the dev-tarball distribution model skew is the NORMAL
 * case, not an edge one. A version on both sides turns the whole class of future
 * mismatch bugs into one legible refusal at pairing time.
 *
 * Bump this when a message shape changes in a way an older peer cannot honour. Adding an
 * OPTIONAL field is not such a change (both parsers ignore what they do not know), so
 * this number is deliberately not a build stamp — `workerVersion` carries that.
 */
export const WORKER_PROTOCOL_VERSION = 1;

/** The oldest protocol a board will talk to. Raise this only with a real breaking change. */
export const MIN_SUPPORTED_WORKER_PROTOCOL_VERSION = 1;

/**
 * What a worker that reports NO version is assumed to speak (#754).
 *
 * This is the deliberate compatibility window, and the reasoning is factual rather than
 * generous: a pre-handshake build speaks *exactly* protocol 1, because protocol 1 IS the
 * wire format as it stood when the handshake was added. Refusing such a worker would
 * refuse a machine that works perfectly, on a fleet where the worker is on someone else's
 * computer and upgrades are not synchronised with the board's — the worst possible place
 * to make an upgrade mandatory for no gain.
 *
 * The handshake still earns its keep, just not today: the moment
 * WORKER_PROTOCOL_VERSION goes to 2 with a change an older peer cannot honour,
 * MIN_SUPPORTED is raised to 2 and every version-less worker is refused *then* — with a
 * message naming the fix. That is the difference between a version check that prevents a
 * class of bugs and one that only creates work.
 *
 * The assumption is NOT recorded as if the worker had claimed it: `worker list` shows `?`
 * for a worker that reported nothing, because "we assumed 1" and "it said 1" are
 * different facts and the first is the one that matters when diagnosing skew.
 */
export const PRE_HANDSHAKE_ASSUMED_PROTOCOL_VERSION = 1;

/** What a worker reports about itself when it registers and on every heartbeat. */
export interface WorkerIdentityInfo {
  /** Absent = a build older than the handshake. Treated as 0, i.e. incompatible. */
  protocolVersion?: number;
  /** The package version of the worker build, for the panel and `worker list`. */
  workerVersion?: string;
}

/**
 * What a worker machine can do. Sent at registration AND on every heartbeat (#754):
 * they used to travel only at first registration, so re-running
 * `start --labels docker --max-concurrency 4` changed nothing on the board while the
 * local runner enforced the NEW ceiling — board and worker silently disagreeing about
 * the same machine.
 */
export interface WorkerCapabilities {
  labels?: string[];
  providers?: string[];
  maxConcurrency?: number;
}

export type ProtocolCompatibility =
  | { ok: true; version: number }
  | { ok: false; reason: string };

/**
 * Is this peer's protocol one we can talk? Returns a reason written for a human, because
 * the failure it replaces was a worker that connected, was dropped, and reconnected
 * forever with nothing in any log explaining why.
 */
export function checkProtocolCompatibility(
  reported: number | undefined,
  opts: { min?: number; current?: number } = {},
): ProtocolCompatibility {
  const min = opts.min ?? MIN_SUPPORTED_WORKER_PROTOCOL_VERSION;
  const current = opts.current ?? WORKER_PROTOCOL_VERSION;
  // A missing or malformed version means a pre-handshake build, which speaks the protocol
  // as it stood when the handshake landed. See PRE_HANDSHAKE_ASSUMED_PROTOCOL_VERSION.
  const declared = reported !== undefined && Number.isInteger(reported) ? reported : undefined;
  const effective = declared ?? PRE_HANDSHAKE_ASSUMED_PROTOCOL_VERSION;
  if (effective < min) {
    const what = declared === undefined
      ? `worker reports no protocol version, so it predates the handshake and speaks ${effective}`
      : `worker speaks protocol ${declared}`;
    return {
      ok: false,
      reason:
        `${what}, which is older than this board supports (${min}..${current}). ` +
        `UPGRADE THE WORKER: on the board machine run 'node scripts/pack-worker.mjs', copy the ` +
        `tarball to the worker, reinstall it there, then re-pair with a fresh token from ` +
        `'agentic-kanban worker pair'`,
    };
  }
  if (effective > current) {
    return {
      ok: false,
      reason:
        `worker speaks protocol ${effective}, which is NEWER than this board (${min}..${current}). ` +
        `UPGRADE THE BOARD to match, or install a worker build made from this board's checkout ` +
        `('node scripts/pack-worker.mjs')`,
    };
  }
  return { ok: true, version: effective };
}

/** Shape-check a capabilities blob off the wire. Unknown/ill-typed fields are dropped. */
export function parseWorkerCapabilities(raw: unknown): WorkerCapabilities | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
  const labels = strings(rec.labels);
  const providers = strings(rec.providers);
  const maxConcurrency =
    typeof rec.maxConcurrency === "number" && Number.isInteger(rec.maxConcurrency) && rec.maxConcurrency > 0
      ? rec.maxConcurrency
      : undefined;
  if (labels === undefined && providers === undefined && maxConcurrency === undefined) return undefined;
  return {
    ...(labels ? { labels } : {}),
    ...(providers ? { providers } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
  };
}

export type BoardToWorkerMessage =
  | { type: "assign"; sessionId: string; spec: WorkerLaunchSpec; repo?: WorkerRepoTransport }
  | { type: "input"; sessionId: string; data: string }
  | { type: "close_stdin"; sessionId: string }
  | { type: "stop"; sessionId: string };

export type WorkerToBoardMessage =
  | {
      type: "hello";
      workerId: string;
      runningSessionIds: string[];
      /** #754: absent means a pre-handshake worker build. */
      protocolVersion?: number;
      workerVersion?: string;
      /** #754: re-declared on every connect, not frozen at first pairing. */
      capabilities?: WorkerCapabilities;
    }
  | { type: "event"; event: WorkerAgentEvent }
  | { type: "assign_failed"; sessionId: string; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return asRecord(raw);
}

/** Parse + shape-check a message arriving at the board. Null = drop it. */
export function parseWorkerToBoardMessage(raw: unknown): WorkerToBoardMessage | null {
  const msg = parseJson(raw);
  if (!msg) return null;
  switch (msg.type) {
    case "hello": {
      if (typeof msg.workerId !== "string") return null;
      const capabilities = parseWorkerCapabilities(msg.capabilities);
      return {
        type: "hello",
        workerId: msg.workerId,
        runningSessionIds: Array.isArray(msg.runningSessionIds)
          ? msg.runningSessionIds.filter((s): s is string => typeof s === "string")
          : [],
        // Optional on the wire on purpose: a pre-handshake worker must still PARSE, so
        // that the board can refuse it with a sentence instead of dropping it as
        // malformed — which is the failure mode #754 exists to remove.
        ...(typeof msg.protocolVersion === "number" ? { protocolVersion: msg.protocolVersion } : {}),
        ...(typeof msg.workerVersion === "string" ? { workerVersion: msg.workerVersion } : {}),
        ...(capabilities ? { capabilities } : {}),
      };
    }
    case "event": {
      const event = asRecord(msg.event);
      if (!event || typeof event.sessionId !== "string") return null;
      if (event.type !== "stdout" && event.type !== "stderr" && event.type !== "exit") return null;
      return {
        type: "event",
        event: {
          type: event.type,
          sessionId: event.sessionId,
          data: typeof event.data === "string" ? event.data : undefined,
          exitCode: typeof event.exitCode === "number" || event.exitCode === null ? event.exitCode : undefined,
        },
      };
    }
    case "assign_failed":
      if (typeof msg.sessionId !== "string" || typeof msg.error !== "string") return null;
      return { type: "assign_failed", sessionId: msg.sessionId, error: msg.error };
    default:
      return null;
  }
}

/**
 * A name that can only ever land directly in the directory it is written to: no path
 * separator, no drive letter, no `.`/`..`. Shared by the board (which builds these names
 * with `basename`) and the worker (which must not trust them).
 */
export function isBareFileName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (/[\/]/.test(name)) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  return true;
}

function parseLaunchIntent(raw: unknown): WorkerLaunchIntent | null {
  const intent = asRecord(raw);
  if (!intent) return null;
  if (typeof intent.provider !== "string" || typeof intent.program !== "string") return null;
  if (!intent.program.trim()) return null;
  return { provider: intent.provider, program: intent.program };
}

function parseRepoTransport(raw: unknown): WorkerRepoTransport | null {
  const repo = asRecord(raw);
  if (!repo) return null;
  if (
    typeof repo.projectId !== "string" ||
    typeof repo.gitPort !== "number" ||
    typeof repo.gitToken !== "string" ||
    typeof repo.branch !== "string" ||
    typeof repo.baseBranch !== "string" ||
    typeof repo.incomingRef !== "string"
  ) {
    return null;
  }
  const skills = Array.isArray(repo.skills)
    ? repo.skills
        .map((s) => asRecord(s))
        .filter((s): s is Record<string, unknown> => Boolean(s))
        .filter((s) => typeof s.name === "string" && typeof s.content === "string")
        .map((s) => ({
          name: s.name as string,
          // Optional on the wire: an older board sends none, and a skill without a
          // description still materializes (with an empty one) rather than being dropped.
          ...(typeof s.description === "string" ? { description: s.description } : {}),
          content: s.content as string,
        }))
    : undefined;
  const contextFiles = Array.isArray(repo.contextFiles)
    ? repo.contextFiles
        .map((f) => asRecord(f))
        .filter((f): f is Record<string, unknown> => Boolean(f))
        .filter((f) => typeof f.name === "string" && typeof f.content === "string")
        // A bare filename only: the board writes into the checkout ROOT, and a name
        // carrying a separator or `..` would escape it. Dropped, not sanitized — a
        // spec that asks for that is malformed, not merely untidy.
        .filter((f) => isBareFileName(f.name as string))
        .map((f) => ({ name: f.name as string, content: f.content as string }))
    : undefined;
  return {
    projectId: repo.projectId,
    gitPort: repo.gitPort,
    gitToken: repo.gitToken,
    branch: repo.branch,
    baseBranch: repo.baseBranch,
    incomingRef: repo.incomingRef,
    setupScript: typeof repo.setupScript === "string" ? repo.setupScript : undefined,
    ...(skills && skills.length > 0 ? { skills } : {}),
    ...(contextFiles && contextFiles.length > 0 ? { contextFiles } : {}),
  };
}

/** Parse + shape-check a message arriving at a worker. Null = drop it. */
export function parseBoardToWorkerMessage(raw: unknown): BoardToWorkerMessage | null {
  const msg = parseJson(raw);
  if (!msg || typeof msg.sessionId !== "string") return null;
  switch (msg.type) {
    case "assign": {
      const spec = asRecord(msg.spec);
      if (!spec) return null;
      if (typeof spec.command !== "string" || typeof spec.cwd !== "string") return null;
      if (!Array.isArray(spec.args)) return null;
      const repo = parseRepoTransport(msg.repo);
      const intent = parseLaunchIntent(spec.intent);
      return {
        type: "assign",
        sessionId: msg.sessionId,
        ...(repo ? { repo } : {}),
        spec: {
          command: spec.command,
          args: spec.args.filter((a): a is string => typeof a === "string"),
          env: asRecord(spec.env)
            ? Object.fromEntries(Object.entries(spec.env as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
            : {},
          cwd: spec.cwd,
          stdinPrompt: typeof spec.stdinPrompt === "string" ? spec.stdinPrompt : undefined,
          keepStdinOpen: spec.keepStdinOpen === true,
          suppressStdinPrompt: spec.suppressStdinPrompt === true,
          useShell: spec.useShell === true,
          ...(intent ? { intent } : {}),
          hangTimeoutMs: typeof spec.hangTimeoutMs === "number" && Number.isFinite(spec.hangTimeoutMs)
            ? spec.hangTimeoutMs
            : undefined,
        },
      };
    }
    case "input":
      if (typeof msg.data !== "string") return null;
      return { type: "input", sessionId: msg.sessionId, data: msg.data };
    case "close_stdin":
      return { type: "close_stdin", sessionId: msg.sessionId };
    case "stop":
      return { type: "stop", sessionId: msg.sessionId };
    default:
      return null;
  }
}
