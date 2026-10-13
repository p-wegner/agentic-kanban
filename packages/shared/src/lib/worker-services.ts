// Workspace services on a worker + the board's port proxy to them (#1447, part b of #1432).
//
// A workspace whose builder runs on a fleet worker has its dev server, script shortcuts and compose
// stack there too: the host's worktree for it has no installed dependencies (#1429). These frames
// start/stop those processes inside the worker's checkout of the workspace branch, and tunnel HTTP
// and WebSocket traffic to the ports they open over the EXISTING fleet socket — nothing listens on
// the LAN, the board stays the only door (`/api/workspaces/:id/proxy/<port>/...`).
//
// Pure types + defensive parsers, no Node builtins (same rule as worker-protocol.ts). Bodies travel
// base64 so a binary asset survives the JSON frame.

/** What a started thing is: a long-running shell command, or a run-to-completion compose argv. */
export type WorkerServiceKind = "process" | "exec";

export interface WorkerServiceStart {
  type: "service_start";
  requestId: string;
  /** The workspace's session on this worker: names the checkout the command runs in. */
  sessionId: string;
  workspaceId: string;
  /** Stable name within the workspace (`devserver`, `script:<id>`); a restart replaces the same label. */
  label: string;
  /** `process`: run `command` through the shell and keep it. `exec`: run `argv` (or a shell `command`) to completion. */
  kind: WorkerServiceKind;
  command?: string;
  argv?: string[];
  /** `exec` only: needs no checkout (compose `down` by project name after the session ended) — runs in a scratch directory. */
  scratch?: boolean;
  /** Directory inside the session's checkout to run in ("" = its root). Must not leave it. */
  cwdRel?: string;
  /** `exec` only: written to a worker-side file whose path replaces the `@ENVFILE` argv entry. */
  envFile?: string;
  /** Ports the thing is expected to open; the proxy only reaches ports registered here. */
  ports: number[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface WorkerServiceStop {
  type: "service_stop";
  requestId: string;
  workspaceId: string;
  /** Absent = every service of the workspace. */
  label?: string;
}

/** The outcome of one `service_start` (`process`: it spawned; `exec`: it finished) or `service_stop`. */
export interface WorkerServiceResult {
  type: "service_result";
  requestId: string;
  ok: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  pid?: number;
}

/** A long-running service changed state on the worker (it exited on its own, or was stopped). */
export interface WorkerServiceState {
  type: "service_state";
  workspaceId: string;
  label: string;
  status: "running" | "exited";
  exitCode?: number | null;
}

export interface WorkerProxyHttp {
  type: "proxy_http";
  proxyId: string;
  workspaceId: string;
  port: number;
  method: string;
  /** Path + query, already stripped of the `/api/workspaces/:id/proxy/<port>` prefix. */
  path: string;
  headers: Record<string, string>;
  bodyB64?: string;
}

export interface WorkerProxyHttpResult {
  type: "proxy_http_result";
  proxyId: string;
  status: number;
  headers: Record<string, string>;
  bodyB64?: string;
  error?: string;
}

export interface WorkerProxyWsOpen {
  type: "proxy_ws_open";
  proxyId: string;
  workspaceId: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  protocols?: string[];
}

/** A WebSocket payload, either direction. */
export interface WorkerProxyWsData {
  type: "proxy_ws_data";
  proxyId: string;
  dataB64: string;
  binary: boolean;
}

/** Either side closing the tunnelled socket (board -> worker: client left; worker -> board: app closed). */
export interface WorkerProxyWsClose {
  type: "proxy_ws_close";
  proxyId: string;
  code?: number;
  reason?: string;
}

/** Worker -> board: the upstream socket is open (`ok`) or could not be (`error`). */
export interface WorkerProxyWsOpened {
  type: "proxy_ws_opened";
  proxyId: string;
  ok: boolean;
  error?: string;
}

export type WorkerServiceBoardFrame =
  | WorkerServiceStart
  | WorkerServiceStop
  | WorkerProxyHttp
  | WorkerProxyWsOpen
  | WorkerProxyWsData
  | WorkerProxyWsClose;

export type WorkerServiceWorkerFrame =
  | WorkerServiceResult
  | WorkerServiceState
  | WorkerProxyHttpResult
  | WorkerProxyWsOpened
  | WorkerProxyWsData
  | WorkerProxyWsClose;

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const validPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536;

function stringMap(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>;
}

function parseStart(m: Record<string, unknown>): WorkerServiceStart | null {
  if (!str(m.requestId) || !str(m.sessionId) || !str(m.workspaceId) || !str(m.label)) return null;
  if (m.kind !== "process" && m.kind !== "exec") return null;
  const argv = Array.isArray(m.argv) ? m.argv.filter((a): a is string => typeof a === "string") : undefined;
  if (m.kind === "process" ? !str(m.command) : !str(m.command) && (!argv || argv.length === 0)) return null;
  return {
    type: "service_start", requestId: m.requestId, sessionId: m.sessionId, workspaceId: m.workspaceId, label: m.label, kind: m.kind,
    ports: Array.isArray(m.ports) ? m.ports.filter(validPort) : [],
    env: stringMap(m.env),
    ...(str(m.command) ? { command: m.command } : {}),
    ...(argv ? { argv } : {}),
    ...(typeof m.cwdRel === "string" ? { cwdRel: m.cwdRel } : {}),
    ...(m.scratch === true && m.kind === "exec" ? { scratch: true } : {}),
    ...(typeof m.envFile === "string" ? { envFile: m.envFile } : {}),
    ...(typeof m.timeoutMs === "number" && m.timeoutMs > 0 ? { timeoutMs: m.timeoutMs } : {}),
  };
}

function parseProxyHttp(m: Record<string, unknown>): WorkerProxyHttp | null {
  if (!str(m.proxyId) || !str(m.workspaceId) || !validPort(m.port) || !str(m.method) || typeof m.path !== "string") return null;
  return {
    type: "proxy_http", proxyId: m.proxyId, workspaceId: m.workspaceId, port: m.port, method: m.method, path: m.path,
    headers: stringMap(m.headers), ...(typeof m.bodyB64 === "string" && m.bodyB64 ? { bodyB64: m.bodyB64 } : {}),
  };
}

function parseWsFrame(m: Record<string, unknown>): WorkerServiceBoardFrame & WorkerServiceWorkerFrame | null {
  if (!str(m.proxyId)) return null;
  if (m.type === "proxy_ws_data") {
    return typeof m.dataB64 === "string" ? { type: "proxy_ws_data", proxyId: m.proxyId, dataB64: m.dataB64, binary: m.binary === true } : null;
  }
  return {
    type: "proxy_ws_close", proxyId: m.proxyId,
    ...(typeof m.code === "number" ? { code: m.code } : {}), ...(typeof m.reason === "string" ? { reason: m.reason } : {}),
  };
}

/** Shape-check a board -> worker services/proxy frame. Null = not one of these, or malformed. */
export function parseServiceBoardFrame(m: Record<string, unknown>): WorkerServiceBoardFrame | null {
  switch (m.type) {
    case "service_start": return parseStart(m);
    case "service_stop":
      return str(m.requestId) && str(m.workspaceId) ? { type: "service_stop", requestId: m.requestId, workspaceId: m.workspaceId, ...(str(m.label) ? { label: m.label } : {}) } : null;
    case "proxy_http": return parseProxyHttp(m);
    case "proxy_ws_open":
      return str(m.proxyId) && str(m.workspaceId) && validPort(m.port) && typeof m.path === "string"
        ? { type: "proxy_ws_open", proxyId: m.proxyId, workspaceId: m.workspaceId, port: m.port, path: m.path, headers: stringMap(m.headers), ...(Array.isArray(m.protocols) ? { protocols: m.protocols.filter((p): p is string => typeof p === "string") } : {}) }
        : null;
    case "proxy_ws_data":
    case "proxy_ws_close": return parseWsFrame(m) as WorkerServiceBoardFrame | null;
    default: return null;
  }
}

/** Shape-check a worker -> board services/proxy frame. Null = not one of these, or malformed. */
export function parseServiceWorkerFrame(m: Record<string, unknown>): WorkerServiceWorkerFrame | null {
  switch (m.type) {
    case "service_result":
      if (!str(m.requestId) || typeof m.ok !== "boolean") return null;
      return {
        type: "service_result", requestId: m.requestId, ok: m.ok,
        ...(typeof m.error === "string" ? { error: m.error } : {}), ...(typeof m.stdout === "string" ? { stdout: m.stdout } : {}),
        ...(typeof m.stderr === "string" ? { stderr: m.stderr } : {}), ...(typeof m.code === "number" || m.code === null ? { code: m.code as number | null } : {}),
        ...(typeof m.pid === "number" ? { pid: m.pid } : {}),
      };
    case "service_state":
      if (!str(m.workspaceId) || !str(m.label) || (m.status !== "running" && m.status !== "exited")) return null;
      return { type: "service_state", workspaceId: m.workspaceId, label: m.label, status: m.status, ...(typeof m.exitCode === "number" || m.exitCode === null ? { exitCode: m.exitCode as number | null } : {}) };
    case "proxy_http_result":
      if (!str(m.proxyId) || typeof m.status !== "number") return null;
      return { type: "proxy_http_result", proxyId: m.proxyId, status: m.status, headers: stringMap(m.headers), ...(typeof m.bodyB64 === "string" ? { bodyB64: m.bodyB64 } : {}), ...(typeof m.error === "string" ? { error: m.error } : {}) };
    case "proxy_ws_opened":
      return str(m.proxyId) && typeof m.ok === "boolean" ? { type: "proxy_ws_opened", proxyId: m.proxyId, ok: m.ok, ...(typeof m.error === "string" ? { error: m.error } : {}) } : null;
    case "proxy_ws_data":
    case "proxy_ws_close": return parseWsFrame(m) as WorkerServiceWorkerFrame | null;
    default: return null;
  }
}

/** True for any frame type this module owns (board -> worker or worker -> board). */
export function isServiceFrameType(type: unknown): boolean {
  return typeof type === "string" && (type.startsWith("service_") || type.startsWith("proxy_"));
}
