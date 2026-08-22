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

export type BoardToWorkerMessage =
  | { type: "assign"; sessionId: string; spec: WorkerLaunchSpec; repo?: WorkerRepoTransport }
  | { type: "input"; sessionId: string; data: string }
  | { type: "close_stdin"; sessionId: string }
  | { type: "stop"; sessionId: string };

export type WorkerToBoardMessage =
  | { type: "hello"; workerId: string; runningSessionIds: string[] }
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
    case "hello":
      if (typeof msg.workerId !== "string") return null;
      return {
        type: "hello",
        workerId: msg.workerId,
        runningSessionIds: Array.isArray(msg.runningSessionIds)
          ? msg.runningSessionIds.filter((s): s is string => typeof s === "string")
          : [],
      };
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
