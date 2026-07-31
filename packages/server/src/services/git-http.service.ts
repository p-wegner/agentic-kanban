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
// be reachable off-loopback (that is its whole point), so every request needs
// the per-boot bearer token. Git clients authenticate with URL-embedded basic
// auth (`http://x-token:<token>@host:port/...`); both Basic (password) and
// Bearer are accepted, compared constant-time. `/health` is unauthenticated.
// No "localhost is trusted" shortcut — see http-transport.ts's module comment.
//
// Push contract: workers push ONLY to the `refs/kanban/incoming/*` namespace
// (enforced here), never to refs/heads/* — feature branches are checked out in
// board-side worktrees and a direct push would be refused or, worse, desync a
// worktree. The board-side sync step fast-forwards the real branch from the
// incoming ref (worker-remote-sync service).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { gitStream } from "@agentic-kanban/shared/lib/git-exec";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";

export const KANBAN_INCOMING_REF_PREFIX = "refs/kanban/incoming/";

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

export interface GitHttpHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
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
  const rows = await database.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0]?.repoPath ?? null;
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
 * A Transform that parses the receive-pack COMMAND section (pkt-lines of
 * `<old-sha> <new-sha> <refname>[\0caps]` up to the `0000` flush) and destroys
 * the stream if any refname is outside `refs/kanban/incoming/` — after the
 * flush it becomes a passthrough for the packfile. Keeps worker pushes out of
 * refs/heads/* (checked out in board worktrees).
 */
function createReceiveGuard(onViolation: (refname: string) => void): Transform {
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
        const len = Number.parseInt(lenHex, 16);
        if (Number.isNaN(len)) {
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
        if (refname && !refname.startsWith(KANBAN_INCOMING_REF_PREFIX)) {
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
function handleServiceRpc(req: IncomingMessage, res: ServerResponse, service: string, repoPath: string): void {
  const cmd = service.replace(/^git-/, "");
  res.writeHead(200, {
    "Content-Type": `application/x-${service}-result`,
    "Cache-Control": "no-cache",
  });
  const proc = gitStream([cmd, "--stateless-rpc", repoPath]);
  let body: NodeJS.ReadableStream = req.headers["content-encoding"] === "gzip" ? req.pipe(createGunzip()) : req;
  if (cmd === "receive-pack") {
    const guard = createReceiveGuard((refname) => {
      console.warn(`[git-http] refused push outside ${KANBAN_INCOMING_REF_PREFIX}: ${refname} (repo=${repoPath})`);
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

export async function startGitHttpServer(opts?: {
  database?: Database;
  port?: number;
  host?: string;
  token?: string;
}): Promise<GitHttpHandle> {
  const database = opts?.database ?? realDb;
  const token = opts?.token ?? randomBytes(32).toString("hex");

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
        if (!provided || !tokensMatch(provided, token)) {
          reject(res, 401, "unauthorized");
          return;
        }

        const match = /^\/git\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
        if (!match) {
          reject(res, 404, "not found");
          return;
        }
        const [, projectId, tail] = match;
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
        handleServiceRpc(req, res, tail!, repoPath);
      } catch (err) {
        console.error("[git-http] request failed:", err);
        try {
          reject(res, 500, "internal error");
        } catch { /* already streaming */ }
      }
    })();
  });

  const port = await new Promise<number>((resolve, rejectListen) => {
    http.once("error", rejectListen);
    http.listen(opts?.port ?? resolveConfiguredGitPort(), opts?.host ?? "0.0.0.0", () => {
      const address = http.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  console.log(`[git-http] serving project repos on port ${port} (token-authed)`);

  return {
    port,
    token,
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

export async function stopGitHttpServer(): Promise<void> {
  if (!activeServer) return;
  const handle = await activeServer.catch(() => null);
  activeServer = null;
  await handle?.close();
}
