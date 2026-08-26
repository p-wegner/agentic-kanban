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
/**
 * The environment variable a worker exports {@link WorkerRepoTransport.boardMcpToken} as (#799).
 *
 * Lives in the PROTOCOL rather than in the board's bridge service because both ends need it and
 * they may not import each other: the worker binary is deliberately isolated from `services/`
 * (the `worker-cli-isolation` guard), so a shared constant is the only honest home for a name
 * that appears in the board's argv AND in the worker's spawn env.
 */
export const FLEET_MCP_TOKEN_ENV_VAR = "AGENTIC_KANBAN_MCP_TOKEN";

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
  /**
   * Bearer token for the board's MCP bridge, for a provider that takes it through the
   * ENVIRONMENT rather than a config file (#799 — today that is codex).
   *
   * WHY A DEDICATED FIELD AND NOT `spec.env`. The launch spec's env is projected through
   * `REMOTE_SPEC_ENV_ALLOWLIST` plus a `looksSecretEnvKey` check that drops anything containing
   * `TOKEN` — the rule that keeps the BOARD's credentials off a worker (decision 012, #244).
   * Widening it for this would weaken exactly the guard it exists to be. So this rides its own
   * purpose-named field, the same way `gitToken` does, and the WORKER puts it into its child's
   * environment (`CODEX_MCP_TOKEN_ENV_VAR`). The board's env projection stays credential-free.
   *
   * WHY NOT ARGV. A token in argv is visible in any process listing on the worker; that is why
   * the git token left the clone URL and why the claude/copilot config travels as a file. The
   * codex flags carry the bridge URL and the NAME of this variable, never its value.
   *
   * Absent for claude/copilot (their token is in `.mcp-kanban.json`) and for pi, which has no
   * MCP client to configure at all.
   */
  boardMcpToken?: string;
}

/**
 * What a worker needs to talk to the board's git transport for ONE repo operation
 * on an ALREADY-PROVISIONED session checkout (#783, #784).
 *
 * A deliberate subset of {@link WorkerRepoTransport}: no setup script, no skills, no
 * context files — none of that is re-applied by a sync or a push — and above all a FRESH
 * `gitToken`. The token the assignment carried is per-assignment and expires (and a board
 * restart invalidates it, #775), so a mid-session operation cannot reuse it; the board
 * issues a new one through the same `issueToken({workerId, projectId, incomingRef})` seam
 * and it travels here. `baseBranch` is absent on purpose: both operations are relative to
 * the session's own branch, and nothing may re-derive a start point mid-session.
 */
export interface WorkerRepoOpAuth {
  projectId: string;
  gitPort: number;
  gitToken: string;
  branch: string;
  incomingRef: string;
}

/** Which repo operation a {@link WorkerRepoOpResult} answers. */
export type WorkerRepoOpKind = "sync" | "push";

/**
 * How a worker-side repo operation ended.
 *
 * `diverged` and `dirty-held` are the two outcomes that must NEVER be resolved
 * automatically: the first means the worker's checkout and the board's branch both moved,
 * the second that a fast-forward would have had to overwrite the agent's uncommitted work.
 * Both are HELD and reported, exactly as `worker-remote-sync.service.ts` holds a divergence
 * board-side — never a `reset --hard`, never a force.
 */
export type WorkerRepoOpStatus =
  | "updated"
  | "unchanged"
  | "pushed"
  | "missing"
  | "diverged"
  | "dirty-held"
  | "no-session"
  | "error";

/**
 * A worker's answer to one `sync_repo` / `push_head` request, correlated by `requestId`.
 *
 * Correlated rather than fire-and-forget because the board BLOCKS on it: a follow-up turn
 * is refused when the sync did not complete (#783), which is only a meaningful contract if
 * "did not complete" is observable.
 */
export interface WorkerRepoOpResult {
  requestId: string;
  op: WorkerRepoOpKind;
  ok: boolean;
  status: WorkerRepoOpStatus;
  /** The commit the checkout (sync) or the incoming ref (push) now points at. */
  sha?: string;
  error?: string;
}

/**
 * What a worker knows about one session it was asked about (#887).
 *
 * `unknown` is the load-bearing one: the worker remembers every id it was ever assigned,
 * so it means the assignment was LOST IN TRANSIT — a fact, not a timeout's guess. It is
 * only authoritative from the worker the session was assigned TO; a different worker not
 * knowing an id means nothing.
 */
export type WorkerSessionProbeState = "unknown" | "running" | "exited";

/** A worker's answer to one `probe_session` (#887), by `requestId`. */
export interface WorkerSessionProbe {
  requestId: string;
  state: WorkerSessionProbeState;
  /** `running`: the agent's pid on the worker, when it has one (absent while provisioning). */
  pid?: number;
  /** Epoch ms on the WORKER's clock — for the operator's report, never for arithmetic here. */
  startedAtMs?: number;
  lastOutputAtMs?: number;
  /** `exited`: what the agent returned, and when. The board finalizes on this. */
  exitCode?: number | null;
  exitedAtMs?: number;
  /**
   * `running` only (#900): can this session's stdin still receive a follow-up turn RIGHT
   * NOW? A board process that ADOPTED this session after a restart has no memory of
   * whether the launch kept stdin open — `state.turnStates` and the launch-time
   * `keepStdinOpen` flag both die with the process that launched it. Only the worker,
   * which actually holds the child's stdin, can answer. Absent on an older worker build;
   * absence must never be read as `true` (same rule as `unknown` vs. silence above).
   */
  stdinOpen?: boolean;
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
 * The manual steps that bring a stale worker install up to the board's build (#880).
 *
 * ONE copy on purpose: this text used to live only inside the 409 protocol-refusal
 * message below, and `worker update-check` needs the same steps for the far more common
 * case of a compatible-but-old build — a second hand-written copy is exactly the kind
 * that drifts. Deliberately DESCRIBES and never performs: there is no update mechanism
 * (docs/fleet-version-freshness.md §2.2), and the process printing this may be running
 * on the very worker it would update.
 */
export const WORKER_UPDATE_REMEDIATION =
  "on the board machine run 'node scripts/pack-worker.mjs', copy the tarball to the worker " +
  "machine and reinstall it there (npm i -g <path-to-tarball>), then restart the worker " +
  "daemon (ak-worker-service.ps1 -Restart on a Windows service install, or re-run " +
  "'worker start')";

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
        // The steps are the shared constant so `worker update-check` prints the same ones
        // (#880); the re-pair tail is refusal-specific — a refused registration consumed
        // its single-use pairing token, a merely-stale worker keeps its pairing.
        `UPGRADE THE WORKER: ${WORKER_UPDATE_REMEDIATION}, and re-pair with a fresh token from ` +
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
  | { type: "stop"; sessionId: string }
  /**
   * #783: pull the BOARD's current branch tip into the worker's live checkout, so a
   * follow-up turn does not run against the tree the session cloned. Fast-forward only.
   */
  | { type: "sync_repo"; sessionId: string; requestId: string; auth: WorkerRepoOpAuth }
  /**
   * #784: push the worker's current HEAD to the incoming ref NOW, mid-session, so the
   * board can show a diff before the agent exits. On demand — the board asks when a diff
   * is actually wanted; the worker runs no timer of its own.
   */
  | { type: "push_head"; sessionId: string; requestId: string; auth: WorkerRepoOpAuth }
  /**
   * #887: ask the worker whether it has ever heard of this session at all.
   *
   * The board cannot tell "the assignment never arrived" from "the agent is working
   * silently" — measured, it held a session that never existed for 100 minutes. Zero
   * output is not evidence either way, which is exactly why it waits. But the WORKER
   * knows every `sessionId` it was ever told about, so its `unknown` is an AUTHORITATIVE
   * never-started answer in a way "no output" can never be.
   *
   * Correlated by `requestId` like the repo ops, and for the same reason: the board acts
   * on the answer, so a stale reply must not be mistaken for a fresh one.
   */
  | { type: "probe_session"; sessionId: string; requestId: string };

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
  | { type: "assign_failed"; sessionId: string; error: string }
  /** The answer to one `sync_repo`/`push_head` (#783, #784), by `requestId`. */
  | { type: "repo_op_result"; sessionId: string; result: WorkerRepoOpResult }
  /**
   * A completed session whose result the worker STILL cannot push (#871).
   *
   * Sent after the reconnect retry fails: the session's exit has long been delivered
   * (downgraded), so without this message the only record of the finished work is a log
   * line on the worker's own disk. The board logs it loudly and stamps the session's
   * transcript so the undelivered state is visible, not silently missing. `lastError`
   * is free text from the worker's git transport; `checkoutPath` names where the work
   * sits ON THE WORKER, which is the one machine the board cannot inspect itself.
   *
   * An OPTIONAL message: an older board drops it as malformed (with a warn), which is
   * a degraded report, not a broken session — so it does not bump the protocol version.
   */
  /**
   * The answer to one `probe_session` (#887).
   *
   * OPTIONAL on the wire, like `undelivered_result`: a worker built before this drops the
   * request as unknown and never answers, and the board's probe then times out. That
   * timeout must fall back to today's behaviour (hold, and let #883's TTL be the backstop)
   * — silence is NOT `unknown`, and treating it as one would fail live sessions on every
   * stale worker in a fleet. So this adds no protocol-version bump.
   */
  | { type: "session_probe_result"; sessionId: string; probe: WorkerSessionProbe }
  | {
      type: "undelivered_result";
      sessionId: string;
      branch: string;
      incomingRef: string;
      checkoutPath: string;
      attempts: number;
      lastError: string;
    };

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
    case "repo_op_result": {
      if (typeof msg.sessionId !== "string") return null;
      const result = parseWorkerRepoOpResult(msg.result);
      if (!result) return null;
      return { type: "repo_op_result", sessionId: msg.sessionId, result };
    }
    case "session_probe_result": {
      if (typeof msg.sessionId !== "string") return null;
      const probe = parseWorkerSessionProbe(msg.probe);
      if (!probe) return null;
      return { type: "session_probe_result", sessionId: msg.sessionId, probe };
    }
    case "undelivered_result": {
      if (
        typeof msg.sessionId !== "string" ||
        typeof msg.branch !== "string" ||
        typeof msg.incomingRef !== "string" ||
        typeof msg.checkoutPath !== "string" ||
        typeof msg.lastError !== "string"
      ) {
        return null;
      }
      return {
        type: "undelivered_result",
        sessionId: msg.sessionId,
        branch: msg.branch,
        incomingRef: msg.incomingRef,
        checkoutPath: msg.checkoutPath,
        attempts: typeof msg.attempts === "number" && Number.isFinite(msg.attempts) ? msg.attempts : 0,
        lastError: msg.lastError,
      };
    }
    default:
      return null;
  }
}

/**
 * Shape-check a repo-op auth blob. Null = drop the whole message: a sync or push with a
 * missing port/token/ref cannot be attempted, and attempting it with defaults would aim a
 * force-push at a ref the board did not name.
 */
export function parseWorkerRepoOpAuth(raw: unknown): WorkerRepoOpAuth | null {
  const auth = asRecord(raw);
  if (!auth) return null;
  if (
    typeof auth.projectId !== "string" ||
    typeof auth.gitPort !== "number" ||
    typeof auth.gitToken !== "string" ||
    typeof auth.branch !== "string" ||
    typeof auth.incomingRef !== "string"
  ) {
    return null;
  }
  return {
    projectId: auth.projectId,
    gitPort: auth.gitPort,
    gitToken: auth.gitToken,
    branch: auth.branch,
    incomingRef: auth.incomingRef,
  };
}

const REPO_OP_STATUSES = new Set<string>([
  "updated", "unchanged", "pushed", "missing", "diverged", "dirty-held", "no-session", "error",
]);

/** Shape-check a repo-op result off the wire. Null = drop it (the board then times out). */
export function parseWorkerRepoOpResult(raw: unknown): WorkerRepoOpResult | null {
  const result = asRecord(raw);
  if (!result) return null;
  if (typeof result.requestId !== "string" || typeof result.ok !== "boolean") return null;
  if (result.op !== "sync" && result.op !== "push") return null;
  if (typeof result.status !== "string" || !REPO_OP_STATUSES.has(result.status)) return null;
  return {
    requestId: result.requestId,
    op: result.op,
    ok: result.ok,
    status: result.status as WorkerRepoOpStatus,
    ...(typeof result.sha === "string" ? { sha: result.sha } : {}),
    ...(typeof result.error === "string" ? { error: result.error } : {}),
  };
}

const PROBE_STATES = new Set<string>(["unknown", "running", "exited"]);

/**
 * Shape-check a session probe off the wire (#887). Null = drop it, and the board then
 * times out — which is the same outcome as an older worker that never answers, and is
 * deliberately NOT the same as `unknown`.
 */
export function parseWorkerSessionProbe(raw: unknown): WorkerSessionProbe | null {
  const probe = asRecord(raw);
  if (!probe) return null;
  if (typeof probe.requestId !== "string" || !probe.requestId) return null;
  if (typeof probe.state !== "string" || !PROBE_STATES.has(probe.state)) return null;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const pid = num(probe.pid);
  const startedAtMs = num(probe.startedAtMs);
  const lastOutputAtMs = num(probe.lastOutputAtMs);
  const exitedAtMs = num(probe.exitedAtMs);
  return {
    requestId: probe.requestId,
    state: probe.state as WorkerSessionProbeState,
    ...(pid !== undefined ? { pid } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(lastOutputAtMs !== undefined ? { lastOutputAtMs } : {}),
    // `null` is meaningful here (killed by signal), so it is kept while `undefined` is not.
    ...(probe.exitCode === null || num(probe.exitCode) !== undefined ? { exitCode: probe.exitCode as number | null } : {}),
    ...(exitedAtMs !== undefined ? { exitedAtMs } : {}),
    ...(typeof probe.stdinOpen === "boolean" ? { stdinOpen: probe.stdinOpen } : {}),
  };
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
    ...(typeof repo.boardMcpToken === "string" && repo.boardMcpToken.length > 0
      ? { boardMcpToken: repo.boardMcpToken }
      : {}),
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
    case "probe_session":
      if (typeof msg.requestId !== "string" || !msg.requestId) return null;
      return { type: "probe_session", sessionId: msg.sessionId, requestId: msg.requestId };
    case "sync_repo":
    case "push_head": {
      if (typeof msg.requestId !== "string" || !msg.requestId) return null;
      const auth = parseWorkerRepoOpAuth(msg.auth);
      if (!auth) return null;
      return { type: msg.type, sessionId: msg.sessionId, requestId: msg.requestId, auth };
    }
    default:
      return null;
  }
}
