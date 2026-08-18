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
// bearer token. Git clients authenticate with URL-embedded basic auth
// (`http://x-token:<token>@host:port/...`); both Basic (password) and Bearer are
// accepted. `/health` is unauthenticated. No "localhost is trusted" shortcut —
// see http-transport.ts's module comment.
//
// TOKENS ARE PER-ASSIGNMENT AND SCOPED (#247). The first cut minted ONE
// board-wide token per boot: it granted a full clone of EVERY registered project
// to every git-transport worker and survived `revokeWorker`, so a worker paired
// for one fixture project could read every repo on the machine and a revoked
// worker kept working until the board restarted. A token now names exactly one
// worker, one project and (for pushes) one incoming ref, expires, and is dropped
// when its worker is revoked (`revokeGitTokensForWorker`).
//
// Push contract: workers push ONLY to the `refs/kanban/incoming/*` namespace,
// and only to the ONE ref their token was issued for (#246) — never to
// refs/heads/*, because feature branches are checked out in board-side worktrees
// and a direct push would be refused or, worse, desync a worktree. The
// board-side sync step fast-forwards the real branch from the incoming ref
// (worker-remote-sync service).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { gitStream } from "@agentic-kanban/shared/lib/git-exec";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectRepoPath } from "../repositories/project.repository.js";

export const KANBAN_INCOMING_REF_PREFIX = "refs/kanban/incoming/";

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/** How long an issued git token stays valid. A worker re-issues per assignment. */
export const DEFAULT_GIT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

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
  /** Test seam for expiry. */
  now?: number;
}

interface GitTokenScope {
  workerId: string;
  projectId: string;
  incomingRef?: string;
  expiresAtMs: number;
}

export interface GitHttpHandle {
  port: number;
  /** Mint a scoped, expiring token for one assignment. Returns the clear token once. */
  issueToken(input: IssueGitTokenInput): string;
  /** Drop every token held by a worker (called from revokeWorker). Returns the count. */
  revokeWorkerTokens(workerId: string): number;
  close(): Promise<void>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Token store: clear tokens are never kept, only their sha-256 digests (same
 * rule as the worker registry's bearer tokens). Lookup is by digest, so there is
 * no per-candidate comparison to leak timing.
 */
function createGitTokenStore() {
  const scopes = new Map<string, GitTokenScope>();

  function prune(nowMs: number): void {
    for (const [hash, scope] of scopes) {
      if (scope.expiresAtMs <= nowMs) scopes.delete(hash);
    }
  }

  function issue(input: IssueGitTokenInput): string {
    const nowMs = input.now ?? Date.now();
    prune(nowMs);
    const token = randomBytes(32).toString("hex");
    scopes.set(sha256Hex(token), {
      workerId: input.workerId,
      projectId: input.projectId,
      incomingRef: input.incomingRef,
      expiresAtMs: nowMs + (input.ttlMs ?? DEFAULT_GIT_TOKEN_TTL_MS),
    });
    return token;
  }

  function resolve(token: string, nowMs = Date.now()): GitTokenScope | null {
    const scope = scopes.get(sha256Hex(token));
    if (!scope) return null;
    if (scope.expiresAtMs <= nowMs) {
      scopes.delete(sha256Hex(token));
      return null;
    }
    return scope;
  }

  function revokeWorker(workerId: string): number {
    let removed = 0;
    for (const [hash, scope] of scopes) {
      if (scope.workerId === workerId) {
        scopes.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  return { issue, resolve, revokeWorker };
}

function extractToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (bearer) return bearer[1]!;
  const basic = /^Basic\s+(.+)$/i.exec(header.trim());
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      // Git sends user:password; the token rides in the password slot
      // (`http://x-token:<token>@...`), but accept it in either slot.
      const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      return pass || user || null;
    } catch {
      return null;
    }
  }
  return null;
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

/** GET /git/:id/info/refs — the ref advertisement that starts every fetch/push. */
function handleInfoRefs(res: ServerResponse, service: string, repoPath: string): void {
  const cmd = service.replace(/^git-/, "");
  res.writeHead(200, {
    "Content-Type": `application/x-${service}-advertisement`,
    "Cache-Control": "no-cache",
  });
  res.write(pktLine(`# service=${service}\n`));
  res.write("0000");
  const proc = gitStream([cmd, "--stateless-rpc", "--advertise-refs", repoPath]);
  proc.stdout!.pipe(res);
  proc.stderr!.on("data", (d: Buffer) => console.warn(`[git-http] ${cmd} advertise stderr: ${d.toString().trim()}`));
  proc.on("error", (err) => {
    console.error(`[git-http] ${cmd} advertise failed:`, err);
    res.destroy();
  });
}

/**
 * Strict pkt-line length: exactly four LOWERCASE hex digits, and never 1..3
 * (those are shorter than the header itself and would desync the offset).
 * `Number.parseInt(hex, 16)` was too permissive — it accepts `"+000"`, `" 000"`
 * and `"-000"` as 0 (a fake flush that would end the command section early) and
 * `"0abz"` as 10. Git's own parser rejects such streams first, so no bypass was
 * demonstrated, but a guard must not depend on the thing it guards.
 */
export function parsePktLineLength(lenHex: string): number | null {
  if (!/^[0-9a-f]{4}$/.test(lenHex)) return null;
  const len = Number.parseInt(lenHex, 16);
  if (len >= 1 && len <= 3) return null;
  return len;
}

/**
 * A Transform that parses the receive-pack COMMAND section (pkt-lines of
 * `<old-sha> <new-sha> <refname>[\0caps]` up to the `0000` flush) and destroys
 * the stream if any refname is outside `refs/kanban/incoming/` or outside the
 * ONE ref this token was issued for — after the flush it becomes a passthrough
 * for the packfile. Keeps worker pushes out of refs/heads/* (checked out in
 * board worktrees) and out of other workers' branches (#246).
 */
function createReceiveGuard(allowedRef: string | undefined, onViolation: (refname: string) => void): Transform {
  let buffered: Buffer = Buffer.alloc(0);
  let commandsDone = false;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      if (commandsDone) {
        callback(null, chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      let offset = 0;
      while (offset + 4 <= buffered.length) {
        const lenHex = buffered.subarray(offset, offset + 4).toString("latin1");
        const len = parsePktLineLength(lenHex);
        if (len === null) {
          onViolation(`<malformed pkt-line: ${lenHex}>`);
          callback(new Error("malformed receive-pack stream"));
          return;
        }
        if (len === 0) {
          // Flush-pkt: command section over; release everything and pass through.
          commandsDone = true;
          const out = buffered;
          buffered = Buffer.alloc(0);
          callback(null, out);
          return;
        }
        if (offset + len > buffered.length) break; // incomplete pkt — wait for more
        const line = buffered.subarray(offset + 4, offset + len).toString("utf8");
        const refname = (line.split("\0")[0] ?? "").trim().split(/\s+/)[2] ?? "";
        if (refname && (!refname.startsWith(KANBAN_INCOMING_REF_PREFIX) || refname !== allowedRef)) {
          onViolation(refname);
          callback(new Error(`push to ${refname} refused`));
          return;
        }
        offset += len;
      }
      callback(); // hold buffered bytes until the section completes
    },
    flush(callback) {
      callback(null, buffered.length > 0 ? buffered : undefined);
    },
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
  const proc = gitStream([cmd, "--stateless-rpc", repoPath]);
  let body: NodeJS.ReadableStream = req.headers["content-encoding"] === "gzip" ? req.pipe(createGunzip()) : req;
  if (cmd === "receive-pack") {
    const guard = createReceiveGuard(allowedRef, (refname) => {
      console.warn(
        `[git-http] refused push to ${refname}: token is scoped to ${allowedRef ?? "<no ref>"} (repo=${repoPath})`,
      );
    });
    guard.on("error", () => {
      try { proc.kill(); } catch { /* already gone */ }
      res.destroy();
    });
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
  const raw = env.KANBAN_GIT_HTTP_PORT;
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    console.warn(`[git-http] ignoring invalid KANBAN_GIT_HTTP_PORT=${raw}; using an OS-assigned port`);
    return 0;
  }
  return parsed;
}

/**
 * Which interface the git transport binds, from `KANBAN_GIT_HTTP_HOST` (#652).
 * Same contract and same rationale as `resolveFleetHost` — absent = `0.0.0.0`.
 */
export function resolveConfiguredGitHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.KANBAN_GIT_HTTP_HOST;
  if (raw === undefined || raw.trim() === "") return "0.0.0.0";
  return raw.trim();
}

export async function startGitHttpServer(opts?: {
  database?: Database;
  port?: number;
  host?: string;
}): Promise<GitHttpHandle> {
  const database = opts?.database ?? realDb;
  const tokens = createGitTokenStore();

  const http: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname.replace(/\/+$/, "") === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const provided = extractToken(req);
        const scope = provided ? tokens.resolve(provided) : null;
        if (!scope) {
          reject(res, 401, "unauthorized");
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

/** Lazily-started singleton for the board process (mirrors ensureMcpHttpBridge). */
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
export async function revokeGitTokensForWorker(workerId: string): Promise<number> {
  if (!activeServer) return 0;
  const handle = await activeServer.catch(() => null);
  const removed = handle?.revokeWorkerTokens(workerId) ?? 0;
  if (removed > 0) console.log(`[git-http] revoked ${removed} git token(s) for worker ${workerId}`);
  return removed;
}

export async function stopGitHttpServer(): Promise<void> {
  if (!activeServer) return;
  const handle = await activeServer.catch(() => null);
  activeServer = null;
  await handle?.close();
}
