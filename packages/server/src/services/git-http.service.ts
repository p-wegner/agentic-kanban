// Git smart-HTTP serving for the worker fleet (epic #184, phase 2 #188).
//
// True remote workers cannot share the board's filesystem, so the board serves
// each registered project's repo over the git smart-HTTP protocol — the same
// stateless-rpc plumbing `git http-backend` fronts, without the CGI:
//   GET  /git/:projectId/info/refs?service=git-(upload|receive)-pack
//   POST /git/:projectId/git-upload-pack     (fetch/clone)
//   POST /git/:projectId/git-receive-pack    (push)
//
// SECURITY — mirrors mcp-http-bridge/http-transport exactly: the listener must
// be reachable off-loopback (that is its whole point), so every request needs a
// bearer token. Git clients authenticate with an `Authorization: Basic` header
// carrying the token in the PASSWORD slot; Bearer is accepted too. `/health` is
// unauthenticated. No "localhost is trusted" shortcut — see http-transport.ts's
// module comment.
//
// TOKENS ARE PER-ASSIGNMENT AND SCOPED (#247). The first cut minted ONE
// board-wide token per boot: it granted a full clone of EVERY registered project
// to every git-transport worker and survived `revokeWorker`, so a worker paired
// for one fixture project could read every repo on the machine and a revoked
// worker kept working until the board restarted. A token now names exactly one
// worker, one project and (for pushes) one incoming ref, expires, and is dropped
// when its worker is revoked (`revokeGitTokensForWorker`).
//
// TOKENS ARE ALSO BOUND TO A LIVE ASSIGNMENT (#753). That scoping was complete
// in SPACE and not in TIME: the only bounds were a 24h TTL and `revokeWorker`,
// and nothing at all happened when the session ENDED. So a token holder could
// still clone the project and force-push a descendant of master to the branch's
// incoming ref hours after review and merge had finished. Authority is now
// re-derived from the DB on EVERY request (`authorizeAssignment`): the dispatch
// behind the token must still be current — running, or ended inside
// `WORKER_RESULT_LANDABLE_AFTER_END_MS` — and a token whose assignment is over
// is dropped from the store on the spot rather than left to age out. The TTL is
// now only an upper ceiling, not the bound that matters.
//
// TOKEN SCOPES ARE PERSISTED (#775). The store above was memory-only, so a board
// restart made the board FORGET every token it had issued: a worker finishing its
// run pushed with a token nobody recognised, got a 401 on every retry, and its work
// survived only as the orphan `kanban/<sessionId>` branch in its cache clone. That
// is what made #745's recovery promise partial — the board keeps the session and
// waits for the worker's exit, but the worker could not deliver its push. The DIGEST
// and the scope now live in `worker_git_tokens`; the clear token still never leaves
// the `assign` frame, and the assignment check above still gates every request, so
// the table can only make the board REMEMBER, never let a token do more.
//
// Push contract: workers push ONLY to the `refs/kanban/incoming/*` namespace,
// and only to the ONE ref their token was issued for (#246) — never to
// refs/heads/*, because feature branches are checked out in board-side worktrees
// and a direct push would be refused or, worse, desync a worktree. The
// board-side sync step fast-forwards the real branch from the incoming ref
// (worker-remote-sync service).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createExpiringDigestStore,
  envPort,
  extractBearer,
  resolveConfiguredFleetPort,
  resolveListenHost,
  sha256Hex,
} from "../lib/bearer-token.js";
import { createGunzip } from "node:zlib";
import { gitStream } from "@agentic-kanban/shared/lib/git-exec";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectRepoPath } from "../repositories/project.repository.js";
import {
  findCurrentWorkerAssignment,
  WORKER_RESULT_LANDABLE_AFTER_END_MS,
} from "../repositories/worker.repository.js";
import {
  deleteGitToken,
  deleteGitTokensForWorker,
  findGitTokenByHash,
  insertGitToken,
  pruneExpiredGitTokens,
} from "../repositories/git-token.repository.js";
import {
  createBodyLimit,
  createReceiveGuard,
  KANBAN_INCOMING_REF_PREFIX,
  parsePktLineLength,
  resolveMaxRpcBodyBytes,
  type ReceiveViolation,
} from "../lib/git-receive-guard.js";

// Re-exported from their new home so existing importers (the sweep, the sync
// service, tests) keep one import site for the transport's vocabulary.
export { KANBAN_INCOMING_REF_PREFIX, parsePktLineLength };

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/**
 * Absolute ceiling on an issued git token, whatever the assignment does.
 *
 * No longer the bound that matters: an assignment-liveness check runs on every request
 * (#753), so a token dies with its session. This is the backstop for the one case that
 * check cannot see — a token issued for an assignment whose session row never appeared.
 */
export const DEFAULT_GIT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a token works before its assignment shows up in the DB.
 *
 * `updateSessionWorkerId` is fire-and-forget on the dispatch path and runs after the
 * `assign` frame goes out, so a worker that clones very fast can legitimately arrive
 * before the row it will be checked against exists. Failing closed on that race would
 * break every remote launch, so an unmatched token is honoured for this long and then
 * refused. It is the one window in which a token has no assignment behind it, and it is
 * minutes rather than the day it used to be.
 */
export const ASSIGNMENT_SETTLE_MS = 5 * 60 * 1000;

/** Headers must arrive quickly; a body may be a large packfile over a slow link. */
const HEADERS_TIMEOUT_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

export interface IssueGitTokenInput {
  /** The worker the token is for — revoking that worker invalidates it. */
  workerId: string;
  /** The ONLY project this token may read/write. */
  projectId: string;
  /**
   * The ONLY ref a receive-pack under this token may update. Omitted = read-only
   * scope in practice: any push is refused because no ref can match.
   */
  incomingRef?: string;
  ttlMs?: number;
  /** Test seam for expiry. Epoch ms (#614: `nowMs` for arithmetic). */
  nowMs?: number;
}

interface GitTokenScope {
  workerId: string;
  projectId: string;
  incomingRef?: string;
  /** When this token was minted — the clock the settle window above is measured from. */
  issuedAtMs: number;
}

/**
 * Whether the dispatch behind a token is still current. Injectable so the transport can be
 * tested without a sessions/workspaces/issues fixture, and so a caller with no database at
 * all (none today) could supply its own source of truth.
 */
export type AssignmentLookup = (params: {
  workerId: string;
  projectId: string;
  branch: string;
  nowMs: number;
}) => Promise<boolean>;

export interface GitHttpHandle {
  port: number;
  /** Mint a scoped, expiring token for one assignment. Returns the clear token once. */
  issueToken(input: IssueGitTokenInput): string;
  /**
   * Drop every token held by a worker (called from revokeWorker), in memory AND in the
   * persisted table. Async since #775: forgetting only this process's copy would let a
   * restart resurrect a revoked worker's credential straight out of the row.
   */
  revokeWorkerTokens(workerId: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Token store: clear tokens are never kept, only their sha-256 digests (same rule as the
 * worker registry's bearer tokens). Lookup is by digest, so there is no per-candidate
 * comparison to leak timing. #556: the map, the mint, the prune and the digest helper are the
 * shared `createExpiringDigestStore`; what stays here is the SCOPE — which worker, which
 * project, which incoming ref — because that is the part git transport actually decides.
 *
 * #775 makes the in-memory store a CACHE in front of `worker_git_tokens`: writes go to both,
 * a read falls through to the table on a miss (which is what a restart looks like), and every
 * delete removes the row as well as the entry. Digests only, in both halves.
 */
function createGitTokenStore(database: Database) {
  const store = createExpiringDigestStore<GitTokenScope>({ ttlMs: DEFAULT_GIT_TOKEN_TTL_MS });

  /**
   * In-flight persistence (#775).
   *
   * `issueToken` is SYNCHRONOUS — its caller puts the clear token straight into the
   * `assign` frame — so the row is written fire-and-forget. Every reader that must not see a
   * stale table awaits this barrier first. Revocation above all: a revoke racing an issue
   * would otherwise clear memory and leave the row behind, which is exactly resurrecting the
   * credential the operator just killed.
   */
  const pending = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>): void {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }
  async function persistenceSettled(): Promise<void> {
    // A loop, not one await: settling a batch can start another (two dispatches in the same
    // turn), and `allSettled` only covers the snapshot it was handed.
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  return {
    issue: (input: IssueGitTokenInput): string => {
      const issuedAtMs = input.nowMs ?? Date.now();
      const scope: GitTokenScope = {
        workerId: input.workerId,
        projectId: input.projectId,
        incomingRef: input.incomingRef,
        issuedAtMs,
      };
      const token = store.issue(scope, { nowMs: input.nowMs, ttlMs: input.ttlMs });
      // The DIGEST, never the token: the row is a scope record, not a credential store.
      track(
        insertGitToken(
          sha256Hex(token),
          { ...scope, expiresAtMs: issuedAtMs + (input.ttlMs ?? DEFAULT_GIT_TOKEN_TTL_MS) },
          database,
        ).catch((err) =>
          console.error(`[git-http] failed to persist token scope for worker ${input.workerId}:`, err),
        ),
      );
      return token;
    },
    /**
     * The scope for a token. A memory hit answers immediately; a MISS falls through to the
     * table, which is the whole point of #775 — after a board restart the store is empty, so
     * a worker still holding a live assignment's token got a 401 it could not recover from,
     * and its work survived only as an orphan `kanban/<sessionId>` branch nothing enumerates.
     *
     * This does NOT widen authority: `authorizeAssignment` still re-derives the dispatch from
     * `sessions` on every request (#753), so a surviving row for a finished session authorises
     * nothing — it is dropped on the spot instead.
     */
    resolve: async (token: string, nowMs: number = Date.now()): Promise<GitTokenScope | null> => {
      const cached = store.resolve(token, nowMs);
      if (cached) return cached;
      await persistenceSettled();
      const hash = sha256Hex(token);
      const row = await findGitTokenByHash(hash, database).catch((err) => {
        // Fail CLOSED, same reasoning as the assignment lookup below: a lookup that throws
        // leaves us unable to tell a live token from an unknown one, and what is on the line
        // is repo contents.
        console.error("[git-http] persisted token lookup failed:", err);
        return null;
      });
      if (!row) return null;
      if (row.expiresAtMs <= nowMs) {
        await deleteGitToken(hash, database).catch(() => { /* the boot prune gets it */ });
        return null;
      }
      return {
        workerId: row.workerId,
        projectId: row.projectId,
        incomingRef: row.incomingRef ?? undefined,
        issuedAtMs: row.issuedAtMs,
      };
    },
    /**
     * Drop THIS token — used when its assignment turns out to be over (#753). `consume` with
     * `nowMs: 0` because we want the entry GONE regardless of whether it had also expired;
     * the ROW goes too, or the next request would resolve it straight back out of the table.
     */
    drop: async (token: string): Promise<boolean> => {
      await persistenceSettled();
      const hadEntry = store.consume(token, 0) !== null;
      await deleteGitToken(sha256Hex(token), database).catch((err) =>
        console.error("[git-http] failed to delete a persisted token scope:", err),
      );
      return hadEntry;
    },
    revokeWorker: async (workerId: string): Promise<number> => {
      await persistenceSettled();
      const fromMemory = store.revokeWhere((scope) => scope.workerId === workerId);
      const fromTable = await deleteGitTokensForWorker(workerId, database).catch((err) => {
        console.error(`[git-http] failed to delete persisted token scopes for worker ${workerId}:`, err);
        return 0;
      });
      // The table is the superset — it also holds tokens issued by a PREVIOUS board process,
      // which memory cannot know about — so it is the count worth reporting.
      return Math.max(fromMemory, fromTable);
    },
  };
}

/** The branch an incoming ref stages, or null when the scope carries no ref at all. */
export function branchFromIncomingRef(incomingRef: string | undefined): string | null {
  if (!incomingRef || !incomingRef.startsWith(KANBAN_INCOMING_REF_PREFIX)) return null;
  const branch = incomingRef.slice(KANBAN_INCOMING_REF_PREFIX.length);
  return branch.length > 0 ? branch : null;
}

export type AuthorizeOutcome =
  | { ok: true; reason: "assignment-current" | "settling" }
  | { ok: false; reason: string };

/**
 * Is this token's assignment still current (#753)?
 *
 * Three answers, and the middle one is the whole subtlety:
 *  - a current dispatch for (worker, project, branch) exists → allowed;
 *  - none exists but the token was minted less than {@link ASSIGNMENT_SETTLE_MS} ago →
 *    allowed, because the board stamps `sessions.workerId` asynchronously after it sends
 *    the assignment and a fast clone can beat that write;
 *  - anything else → refused, and the caller drops the token.
 *
 * A scope with no incoming ref has no branch to check, so it gets the settle window and
 * nothing more — which is the correct authority for a token that cannot push anywhere.
 */
export async function authorizeAssignment(
  scope: { workerId: string; projectId: string; incomingRef?: string; issuedAtMs: number },
  lookup: AssignmentLookup,
  nowMs: number = Date.now(),
): Promise<AuthorizeOutcome> {
  const branch = branchFromIncomingRef(scope.incomingRef);
  if (branch) {
    let current = false;
    try {
      current = await lookup({ workerId: scope.workerId, projectId: scope.projectId, branch, nowMs });
    } catch (err) {
      // Fail CLOSED. A lookup that throws leaves us unable to tell a live worker from a
      // token holder whose session ended, and this transport's job is handing out repo
      // contents — the wrong answer here is not a degraded feature.
      console.error(`[git-http] assignment lookup failed for worker ${scope.workerId}:`, err);
      return { ok: false, reason: "assignment lookup failed" };
    }
    if (current) return { ok: true, reason: "assignment-current" };
  }
  if (nowMs - scope.issuedAtMs <= ASSIGNMENT_SETTLE_MS) return { ok: true, reason: "settling" };
  const window = Math.round(WORKER_RESULT_LANDABLE_AFTER_END_MS / 60_000);
  return {
    ok: false,
    reason: branch
      ? `no current dispatch of ${branch} to worker ${scope.workerId} ` +
        `(a session must be running, or have ended within ${window} min)`
      : `token carries no incoming ref and is past the ${Math.round(ASSIGNMENT_SETTLE_MS / 60_000)} min settle window`,
  };
}

/** The DB-backed lookup used in production. */
export function createAssignmentLookup(database: Database): AssignmentLookup {
  return async ({ workerId, projectId, branch, nowMs }) =>
    (await findCurrentWorkerAssignment({ workerId, projectId, branch, nowMs }, database)) !== null;
}

function pktLine(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain", "WWW-Authenticate": 'Basic realm="agentic-kanban-git"' });
  res.end(message);
}

async function resolveRepoPath(projectId: string, database: Database): Promise<string | null> {
  return getProjectRepoPath(projectId, database);
}

/**
 * Args that hide the staging namespace from the READ side (#753).
 *
 * A token authorised a full `upload-pack`, which advertises every ref in the repo —
 * including `refs/kanban/incoming/*`, i.e. every OTHER worker's unlanded result. A worker
 * has no business reading those, and it never asks for them (it fetches
 * `+refs/heads/*`), so hiding them costs nothing. Only upload-pack: hiding a ref from
 * receive-pack would take the target of the worker's own push out of the advertisement.
 */
function hiddenRefArgs(cmd: string): string[] {
  return cmd === "upload-pack" ? ["-c", `uploadpack.hideRefs=${KANBAN_INCOMING_REF_PREFIX}`] : [];
}

/** GET /git/:id/info/refs — the ref advertisement that starts every fetch/push. */
function handleInfoRefs(res: ServerResponse, service: string, repoPath: string): void {
  const cmd = service.replace(/^git-/, "");
  res.writeHead(200, {
    "Content-Type": `application/x-${service}-advertisement`,
    "Cache-Control": "no-cache",
  });
  res.write(pktLine(`# service=${service}\n`));
  res.write("0000");
  const proc = gitStream([...hiddenRefArgs(cmd), cmd, "--stateless-rpc", "--advertise-refs", repoPath]);
  proc.stdout!.pipe(res);
  proc.stderr!.on("data", (d: Buffer) => console.warn(`[git-http] ${cmd} advertise stderr: ${d.toString().trim()}`));
  proc.on("error", (err) => {
    console.error(`[git-http] ${cmd} advertise failed:`, err);
    res.destroy();
  });
}

/** POST /git/:id/git-(upload|receive)-pack — the actual pack exchange. */
function handleServiceRpc(
  req: IncomingMessage,
  res: ServerResponse,
  service: string,
  repoPath: string,
  allowedRef: string | undefined,
): void {
  const cmd = service.replace(/^git-/, "");
  res.writeHead(200, {
    "Content-Type": `application/x-${service}-result`,
    "Cache-Control": "no-cache",
  });
  const proc = gitStream([...hiddenRefArgs(cmd), cmd, "--stateless-rpc", repoPath]);
  let settled = false;
  const abortGit = (why: string) => {
    if (settled) return;
    settled = true;
    console.warn(`[git-http] ${cmd} aborted: ${why}; killing git (repo=${repoPath})`);
    try { proc.kill(); } catch { /* already gone */ }
    res.destroy();
  };
  // #753: a client that disconnects mid-push used to leave `git receive-pack` running with
  // a stdin nobody would ever close — one orphaned index-pack per abandoned request, which
  // is a resource-exhaustion primitive on its own.
  req.on("aborted", () => abortGit("client aborted"));
  res.on("close", () => { if (!res.writableFinished) abortGit("response closed early"); });
  proc.on("exit", () => { settled = true; });

  const maxBody = resolveMaxRpcBodyBytes();
  let body: NodeJS.ReadableStream = req.headers["content-encoding"] === "gzip" ? req.pipe(createGunzip()) : req;
  // Counted after any gunzip, so this bounds DECOMPRESSED bytes and a compression bomb is
  // bounded by the same number.
  const limit = createBodyLimit(maxBody, (seen) =>
    console.warn(`[git-http] refused ${cmd}: body exceeded ${maxBody} bytes (saw ${seen}; repo=${repoPath})`),
  );
  limit.on("error", () => abortGit(`body over ${maxBody} bytes`));
  body = body.pipe(limit);
  if (cmd === "receive-pack") {
    const guard = createReceiveGuard(allowedRef, (violation: ReceiveViolation) => {
      if (violation.kind === "refname") {
        console.warn(
          `[git-http] refused push to ${violation.refname || "<empty refname>"}: ` +
          `token is scoped to ${allowedRef ?? "<no ref>"} (repo=${repoPath})`,
        );
      } else {
        console.warn(`[git-http] refused push: ${violation.detail} (repo=${repoPath})`);
      }
    });
    guard.on("error", () => abortGit("receive guard refused the stream"));
    body = body.pipe(guard);
  }
  body.pipe(proc.stdin!);
  proc.stdout!.pipe(res);
  proc.stderr!.on("data", (d: Buffer) => console.warn(`[git-http] ${cmd} stderr: ${d.toString().trim()}`));
  proc.on("error", (err) => {
    console.error(`[git-http] ${cmd} failed:`, err);
    res.destroy();
  });
}

/**
 * Fixed port for the git listener, from `KANBAN_GIT_HTTP_PORT`.
 *
 * Default is an OS-assigned port (0), which is right for a same-host fleet.
 * A worker on ANOTHER machine has to reach this port through a firewall/NAT
 * rule, and you cannot open a rule for a port that changes every board boot —
 * so a cross-machine deployment pins it. Invalid values fall back to 0 with a
 * warning rather than crashing the board on a typo.
 */
export function resolveConfiguredGitPort(env: NodeJS.ProcessEnv = process.env): number {
  // Fallback 0 = OS-assigned; the fleet listener's identical parse falls back to null =
  // disabled. That difference is the whole reason they are two call sites and not one (#556).
  return envPort("KANBAN_GIT_HTTP_PORT", {
    fallback: 0,
    logPrefix: "[git-http]",
    onInvalid: "using an OS-assigned port",
  }, env);
}

/**
 * Why an OS-assigned git port is not allowed once a fleet listener exists (#776).
 *
 * THE INVARIANT: while `KANBAN_FLEET_PORT` is set, the git transport must be on a PINNED
 * port. A worker receives `gitPort` once, in its `assign` frame, and rebuilds every clone and
 * push URL as `scheme://<host>:<gitPort>/git/<projectId>` for the life of that assignment.
 * With `KANBAN_GIT_HTTP_PORT` unset the port is OS-assigned on every boot, so a board restart
 * (or any relisten) silently invalidates a value a worker is still using: its push lands on
 * some unrelated service, or on nothing, and neither side can say why.
 *
 * REFUSED rather than re-announced. #776 offered the alternative of broadcasting the current
 * git port to connected workers on listener start and having the worker prefer the announced
 * value over its assignment. That fixes the STALE-VALUE symptom and not the cause: a remote
 * worker reaches this listener through a firewall/NAT rule, and no rule can match a port that
 * moves every boot — so the re-announced number would be accurate and still unreachable. It
 * would also need a new protocol frame plus worker-side precedence logic to paper over a
 * misconfiguration that one environment variable fixes. Failing closed with a named cause is
 * the smaller mechanism, and "the failure has no visible cause on either side" was the actual
 * defect.
 *
 * Scope of the refusal: the git TRANSPORT only, and only when it is started without an
 * explicit port. A same-filesystem worker (`--shares-filesystem`) never reaches the transport.
 * Since #855 a fleet-configured board binds the transport eagerly at STARTUP (server-start.ts)
 * — where this refusal is caught and logged, never fatal — and the dispatch-time call sites
 * remain as the lazy fallback, so this surfaces as one legible warning or failed dispatch,
 * not a board that will not boot.
 *
 * @returns the operator-facing reason to refuse, or null when the configuration is sound.
 */
export function gitPortStabilityViolation(env: NodeJS.ProcessEnv = process.env): string | null {
  const fleetPort = resolveConfiguredFleetPort(env);
  if (fleetPort === null) return null;
  // The RESOLVED git port, deliberately: an invalid KANBAN_GIT_HTTP_PORT falls back to 0 and
  // is therefore not pinned, which is the right answer — a typo is not a promise.
  if (resolveConfiguredGitPort(env) !== 0) return null;
  return (
    "refusing to start the git transport on an OS-assigned port while a fleet listener is " +
    `configured (KANBAN_FLEET_PORT=${fleetPort}). A worker holds the gitPort from its assign ` +
    "and rebuilds every clone/push URL from it, so an ephemeral port breaks after any board " +
    "restart or relisten with no visible cause. Set KANBAN_GIT_HTTP_PORT to a pinned port " +
    "(see docs/worker-fleet.md section 6)."
  );
}

/**
 * Which interface the git transport binds, from `KANBAN_GIT_HTTP_HOST` (#652, #753).
 * Absent no longer means `0.0.0.0` — see {@link resolveListenHost}.
 */
export function resolveConfiguredGitHost(env: NodeJS.ProcessEnv = process.env): string {
  return resolveListenHost({
    raw: env.KANBAN_GIT_HTTP_HOST,
    insecure: env.KANBAN_FLEET_INSECURE,
    logPrefix: "[git-http]",
  });
}

export async function startGitHttpServer(opts?: {
  database?: Database;
  port?: number;
  host?: string;
  /** Injectable for tests; defaults to the DB-backed dispatch check. */
  assignmentLookup?: AssignmentLookup;
}): Promise<GitHttpHandle> {
  const database = opts?.database ?? realDb;
  // #776: checked only when no explicit port was passed — an explicit port is the test /
  // embedding seam, and its caller has already decided what it wants.
  if (opts?.port === undefined) {
    const violation = gitPortStabilityViolation();
    if (violation) throw new Error(`[git-http] ${violation}`);
  }
  const tokens = createGitTokenStore(database);
  // #775: the in-memory store pruned on every issue; the table needs one sweep per boot,
  // or a board that issues nothing for a month keeps a month of dead rows.
  void pruneExpiredGitTokens(Date.now(), database).catch((err) =>
    console.error("[git-http] failed to prune expired token scopes:", err),
  );
  const assignmentLookup = opts?.assignmentLookup ?? createAssignmentLookup(database);

  const http: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname.replace(/\/+$/, "") === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const provided = extractBearer(req.headers.authorization, { allowBasic: true });
        const scope = provided ? await tokens.resolve(provided) : null;
        if (!scope || !provided) {
          reject(res, 401, "unauthorized");
          return;
        }

        // #753: the token proves WHO, the assignment proves STILL. Checked before the path
        // is even parsed, so no request of any shape outlives its session.
        const authorized = await authorizeAssignment(scope, assignmentLookup);
        if (!authorized.ok) {
          await tokens.drop(provided);
          console.warn(`[git-http] refused and revoked a token for worker ${scope.workerId}: ${authorized.reason}`);
          reject(res, 403, "assignment is no longer current");
          return;
        }

        const match = /^\/git\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
        if (!match) {
          reject(res, 404, "not found");
          return;
        }
        const [, projectId, tail] = match;
        // #247: a token is scoped to ONE project. Answering for another project
        // would hand every registered repo to any paired worker.
        if (scope.projectId !== projectId) {
          console.warn(
            `[git-http] refused ${tail} for project ${projectId}: token is scoped to ${scope.projectId} (worker=${scope.workerId})`,
          );
          reject(res, 403, "token is not scoped to this project");
          return;
        }
        const repoPath = await resolveRepoPath(projectId!, database);
        if (!repoPath) {
          reject(res, 404, "unknown project");
          return;
        }

        if (tail === "info/refs") {
          const service = url.searchParams.get("service") ?? "";
          if (req.method !== "GET" || !SERVICES.has(service)) {
            reject(res, 400, "smart protocol required");
            return;
          }
          handleInfoRefs(res, service, repoPath);
          return;
        }

        if (req.method !== "POST" || !SERVICES.has(tail!)) {
          reject(res, 400, "bad request");
          return;
        }
        handleServiceRpc(req, res, tail!, repoPath, scope.incomingRef);
      } catch (err) {
        console.error("[git-http] request failed:", err);
        try {
          reject(res, 500, "internal error");
        } catch { /* already streaming */ }
      }
    })();
  });
  // #753: a slowloris on this listener is a board-wide outage, not a slow clone. Bounded
  // explicitly rather than left to whatever the Node major happens to default to.
  http.headersTimeout = HEADERS_TIMEOUT_MS;
  http.requestTimeout = REQUEST_TIMEOUT_MS;

  const host = opts?.host ?? resolveConfiguredGitHost();
  const port = await new Promise<number>((resolve, rejectListen) => {
    http.once("error", rejectListen);
    http.listen(opts?.port ?? resolveConfiguredGitPort(), host, () => {
      const address = http.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  // The interface is part of the exposure, so log it: "port 3002" alone does not tell an
  // operator whether the transport is on the tailnet only or on every interface.
  console.log(`[git-http] serving project repos on ${host}:${port} (per-assignment scoped tokens)`);

  return {
    port,
    issueToken: (input) => tokens.issue(input),
    revokeWorkerTokens: (workerId) => tokens.revokeWorker(workerId),
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

/**
 * Started-once singleton for the board process (mirrors ensureMcpHttpBridge). Bound EAGERLY
 * at startup on a fleet-configured board (#855, server-start.ts) and lazily by the first
 * git-transport dispatch otherwise; idempotent either way — the memoized promise makes every
 * later call a no-op, and a failed start resets it so the next caller retries.
 */
let activeServer: Promise<GitHttpHandle> | null = null;

export function ensureGitHttpServer(database?: Database): Promise<GitHttpHandle> {
  if (!activeServer) {
    activeServer = startGitHttpServer({ database }).catch((err) => {
      activeServer = null;
      throw err;
    });
  }
  return activeServer;
}

/**
 * Invalidate every git token held by a worker (#247). Called from
 * `revokeWorker` so "revoked" really means revoked — before this, a revoked
 * machine kept a working clone/push credential until the board restarted, while
 * the UI told the operator the token stopped working immediately. A no-op when
 * the git listener was never started (nothing was ever issued).
 */
export async function revokeGitTokensForWorker(
  workerId: string,
  database: Database = realDb,
): Promise<number> {
  // #775: NOT a no-op when the listener was never started in this process. That early return
  // was correct while tokens lived only in memory (nothing had been issued, so nothing could
  // be revoked) and became a hole the moment they were persisted: the transport starts lazily
  // on the first git-transport dispatch, so an operator revoking a worker right after a board
  // restart would have cleared nothing, and the next dispatch would resolve the revoked
  // worker's surviving row straight out of the table.
  if (activeServer) {
    const handle = await activeServer.catch(() => null);
    if (handle) {
      const removed = await handle.revokeWorkerTokens(workerId);
      if (removed > 0) console.log(`[git-http] revoked ${removed} git token(s) for worker ${workerId}`);
      return removed;
    }
  }
  const removed = await deleteGitTokensForWorker(workerId, database);
  if (removed > 0) {
    console.log(`[git-http] revoked ${removed} persisted git token scope(s) for worker ${workerId} (listener not running)`);
  }
  return removed;
}

export async function stopGitHttpServer(): Promise<void> {
  if (!activeServer) return;
  const handle = await activeServer.catch(() => null);
  activeServer = null;
  await handle?.close();
}
