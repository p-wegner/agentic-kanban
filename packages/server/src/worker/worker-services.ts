// Worker-side workspace services + port proxy (#1447, part b of #1432).
//
// The board asks the worker that holds a workspace's session to run that workspace's dev server,
// script shortcuts and compose stack IN the session's checkout (the host's worktree for it has no
// installed dependencies, #1429), and then reaches the ports they open through this module: an HTTP
// request/response pair and a WebSocket bridge, both over the existing fleet socket. Nothing here
// listens on any interface. The proxy only dials 127.0.0.1 ports that a service of THAT workspace
// registered, so the board cannot be coaxed into using the worker as a general loopback relay.
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import WebSocket from "ws";
import type {
  BoardToWorkerMessage,
  WorkerProxyHttp,
  WorkerProxyWsOpen,
  WorkerServiceStart,
  WorkerServiceStop,
  WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
import { killProcessTree } from "../services/process-exec.js";
import { workerLog } from "./worker-updater.js";

const MAX_CAPTURE = 64 * 1024;
const MAX_PROXY_BODY = 64 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
/** Headers that describe one hop, not the message — never forwarded either way. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

export interface WorkerServicesOptions {
  send: (message: WorkerToBoardMessage) => void;
  /** The checkout the worker holds for a session, or undefined when it holds none. */
  cwdForSession: (sessionId: string) => string | undefined;
  isDraining?: () => boolean;
}

interface RunningService {
  label: string;
  pid: number | undefined;
  ports: number[];
  stop: () => Promise<void>;
}

const tail = (text: string, add: string): string => (text + sanitizeUtf8(add)).slice(-MAX_CAPTURE);

function forwardableHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())));
}

export function createWorkerServicesRunner(options: WorkerServicesOptions) {
  const { send } = options;
  const services = new Map<string, Map<string, RunningService>>();
  /** Ports a workspace's services declared: the proxy's allowlist. */
  const allowedPorts = new Map<string, Set<number>>();
  const sockets = new Map<string, WebSocket>();
  const reply = (message: WorkerToBoardMessage): void => {
    try { send(message); } catch (err) { workerLog(`[worker] services reply failed: ${errorMessage(err)}`); }
  };
  const allow = (workspaceId: string, ports: number[]): void => {
    const set = allowedPorts.get(workspaceId) ?? new Set<number>();
    for (const p of ports) set.add(p);
    allowedPorts.set(workspaceId, set);
  };

  /** The checkout root joined with the requested subdirectory, or null when that would leave the checkout. */
  function insideCheckout(root: string, rel: string | undefined): string | null {
    const target = resolve(root, rel ?? "");
    const back = relative(resolve(root), target);
    return back.startsWith("..") || isAbsolute(back) ? null : target;
  }

  function startProcess(m: WorkerServiceStart, cwd: string): void {
    const labels = services.get(m.workspaceId) ?? new Map<string, RunningService>();
    services.set(m.workspaceId, labels);
    const previous = labels.get(m.label);
    const begin = async (): Promise<void> => {
      if (previous) await previous.stop();
      let stderr = "";
      const proc = spawn(m.command!, {
        cwd, env: { ...process.env, ...m.env }, shell: true, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      const entry: RunningService = {
        label: m.label, pid: proc.pid, ports: m.ports,
        stop: async () => {
          if (labels.get(m.label) === entry) labels.delete(m.label);
          if (proc.pid && proc.exitCode === null) await killProcessTree(proc.pid, { timeout: 5000, signal: "SIGTERM", group: true }).catch(() => undefined);
        },
      };
      labels.set(m.label, entry);
      allow(m.workspaceId, m.ports);
      proc.stdout?.resume();
      proc.stderr?.on("data", (c: Buffer) => { stderr = tail(stderr, c.toString()); });
      proc.on("error", (err) => {
        if (labels.get(m.label) === entry) labels.delete(m.label);
        if (!settled) { settled = true; reply({ type: "service_result", requestId: m.requestId, ok: false, error: `could not start: ${err.message}` }); }
      });
      proc.on("spawn", () => {
        settled = true;
        workerLog(`[worker] workspace ${m.workspaceId} service '${m.label}' started in ${cwd} (pid ${proc.pid ?? "?"}, ports ${m.ports.join(",") || "none"})`);
        reply({ type: "service_result", requestId: m.requestId, ok: true, ...(proc.pid ? { pid: proc.pid } : {}) });
        reply({ type: "service_state", workspaceId: m.workspaceId, label: m.label, status: "running" });
      });
      proc.on("close", (code) => {
        const current = labels.get(m.label) === entry;
        if (current) labels.delete(m.label);
        workerLog(`[worker] workspace ${m.workspaceId} service '${m.label}' exited ${code}${code ? ` - ${stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}` : ""}`);
        if (current) reply({ type: "service_state", workspaceId: m.workspaceId, label: m.label, status: "exited", exitCode: code });
      });
    };
    void begin().catch((err) => reply({ type: "service_result", requestId: m.requestId, ok: false, error: errorMessage(err) }));
  }

  /** Run an argv to completion (compose up/down/restart/logs); the env file's content is materialised here. */
  function runExec(m: WorkerServiceStart, cwd: string): void {
    allow(m.workspaceId, m.ports);
    const dir = mkdtempSync(join(tmpdir(), "kanban-svc-"));
    let envPath: string | undefined;
    if (m.envFile !== undefined) { envPath = join(dir, "services.env"); writeFileSync(envPath, m.envFile); }
    const argv = (m.argv ?? []).map((a) => (a === "@ENVFILE" && envPath ? envPath : a));
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: { ok: boolean; code?: number | null; error?: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      reply({ type: "service_result", requestId: m.requestId, stdout, stderr, ...r });
    };
    const base = { cwd, env: { ...process.env, ...m.env }, windowsHide: true };
    const proc = m.command ? spawn(m.command, { ...base, shell: true }) : spawn(argv[0]!, argv.slice(1), base);
    const timer = setTimeout(() => {
      if (proc.pid) void killProcessTree(proc.pid, { timeout: 5000, signal: "SIGTERM" }).catch(() => undefined);
      finish({ ok: false, code: null, error: `timed out after ${m.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS}ms` });
    }, m.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
    proc.stdout?.on("data", (c: Buffer) => { stdout = tail(stdout, c.toString()); });
    proc.stderr?.on("data", (c: Buffer) => { stderr = tail(stderr, c.toString()); });
    proc.on("error", (err) => finish({ ok: false, code: null, error: `could not start: ${err.message}` }));
    proc.on("close", (code) => finish({ ok: code === 0, code }));
  }

  async function stop(m: WorkerServiceStop): Promise<void> {
    const labels = services.get(m.workspaceId);
    const targets = [...(labels?.values() ?? [])].filter((s) => !m.label || s.label === m.label);
    await Promise.all(targets.map((s) => s.stop()));
    if (!m.label) allowedPorts.delete(m.workspaceId);
    for (const t of targets) workerLog(`[worker] workspace ${m.workspaceId} service '${t.label}' stopped`);
    reply({ type: "service_result", requestId: m.requestId, ok: true });
  }

  function proxyHttp(m: WorkerProxyHttp): void {
    const fail = (status: number, error: string): void => reply({ type: "proxy_http_result", proxyId: m.proxyId, status, headers: {}, error });
    if (!allowedPorts.get(m.workspaceId)?.has(m.port)) return fail(403, `port ${m.port} is not registered by a service of workspace ${m.workspaceId} on this worker`);
    const body = m.bodyB64 ? Buffer.from(m.bodyB64, "base64") : undefined;
    const req = httpRequest({
      host: "127.0.0.1", port: m.port, path: m.path || "/", method: m.method, timeout: PROXY_TIMEOUT_MS,
      headers: { ...forwardableHeaders(m.headers), host: `127.0.0.1:${m.port}`, ...(body ? { "content-length": String(body.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size <= MAX_PROXY_BODY) chunks.push(c); });
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
          headers[k] = Array.isArray(v) ? v.join("\n") : v; // set-cookie: the board splits on \n
        }
        reply({ type: "proxy_http_result", proxyId: m.proxyId, status: size > MAX_PROXY_BODY ? 502 : (res.statusCode ?? 502), headers, bodyB64: Buffer.concat(chunks).toString("base64"), ...(size > MAX_PROXY_BODY ? { error: "response too large for the fleet proxy" } : {}) });
      });
    });
    req.on("timeout", () => req.destroy(new Error("upstream timed out")));
    req.on("error", (err) => fail(502, `worker could not reach 127.0.0.1:${m.port}: ${err.message}`));
    req.end(body);
  }

  function proxyWsOpen(m: WorkerProxyWsOpen): void {
    const opened = (ok: boolean, error?: string): void => reply({ type: "proxy_ws_opened", proxyId: m.proxyId, ok, ...(error ? { error } : {}) });
    if (!allowedPorts.get(m.workspaceId)?.has(m.port)) return opened(false, `port ${m.port} is not registered by a service of workspace ${m.workspaceId}`);
    const headers = forwardableHeaders(m.headers);
    for (const k of Object.keys(headers)) if (/^sec-websocket-/i.test(k)) delete headers[k];
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(`ws://127.0.0.1:${m.port}${m.path || "/"}`, m.protocols ?? [], { headers: { ...headers, host: `127.0.0.1:${m.port}` } });
    } catch (err) { return opened(false, errorMessage(err)); }
    sockets.set(m.proxyId, upstream);
    upstream.on("open", () => opened(true));
    upstream.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      reply({ type: "proxy_ws_data", proxyId: m.proxyId, dataB64: buf.toString("base64"), binary: isBinary });
    });
    upstream.on("error", (err) => { if (upstream.readyState !== WebSocket.OPEN) opened(false, err.message); });
    upstream.on("close", (code, reason) => {
      sockets.delete(m.proxyId);
      reply({ type: "proxy_ws_close", proxyId: m.proxyId, code, reason: reason.toString() });
    });
  }

  async function stopAll(): Promise<void> {
    for (const ws of sockets.values()) { try { ws.terminate(); } catch { /* gone */ } }
    sockets.clear();
    await Promise.all([...services.values()].flatMap((labels) => [...labels.values()].map((s) => s.stop())));
    allowedPorts.clear();
  }

  /** Handle a board frame; true when it was a services/proxy frame. */
  function handle(message: BoardToWorkerMessage): boolean {
    switch (message.type) {
      case "service_start": {
        const root = message.scratch ? tmpdir() : options.cwdForSession(message.sessionId);
        const cwd = root ? (message.scratch ? root : insideCheckout(root, message.cwdRel)) : null;
        if (options.isDraining?.()) reply({ type: "service_result", requestId: message.requestId, ok: false, error: "worker is draining" });
        else if (!root) reply({ type: "service_result", requestId: message.requestId, ok: false, error: `this worker holds no checkout for session ${message.sessionId}` });
        else if (!cwd) reply({ type: "service_result", requestId: message.requestId, ok: false, error: `'${message.cwdRel ?? ""}' is outside the session's checkout` });
        else if (message.kind === "process") startProcess(message, cwd);
        else runExec(message, cwd);
        return true;
      }
      case "service_stop": void stop(message); return true;
      case "proxy_http": proxyHttp(message); return true;
      case "proxy_ws_open": proxyWsOpen(message); return true;
      case "proxy_ws_data": {
        const ws = sockets.get(message.proxyId);
        const buf = Buffer.from(message.dataB64, "base64");
        if (ws?.readyState === WebSocket.OPEN) ws.send(message.binary ? buf : buf.toString("utf8"), { binary: message.binary });
        return true;
      }
      case "proxy_ws_close": {
        const ws = sockets.get(message.proxyId);
        sockets.delete(message.proxyId);
        try { ws?.close(message.code && message.code >= 1000 && message.code < 5000 && message.code !== 1005 && message.code !== 1006 ? message.code : 1000); } catch { /* gone */ }
        return true;
      }
      default: return false;
    }
  }

  return { handle, stopAll };
}
