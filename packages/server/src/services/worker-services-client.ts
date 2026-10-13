// The board's end of workspace services on a worker + the port proxy (#1447, part b of #1432).
//
// Counterpart of `worker/worker-services.ts`. It owns three things, all over the EXISTING fleet
// socket (`WorkerConnectionManager`): request/response correlation for `service_start` /
// `service_stop`, the per-workspace record of what runs where (the card reads it), and the tunnel
// for HTTP and WebSocket traffic. A dropped worker connection fails everything in flight and marks
// that worker's services `unreachable` — the board cannot vouch for a process it can no longer see.
import { randomUUID } from "node:crypto";
import type {
  WorkerProxyHttp,
  WorkerProxyHttpResult,
  WorkerProxyWsOpen,
  WorkerServiceResult,
  WorkerServiceStart,
  WorkerServiceStop,
} from "@agentic-kanban/shared/lib/worker-protocol";
import type { WorkerConnectionManager } from "./worker-connection.service.js";

export type RemoteServiceStatus = "running" | "exited" | "unreachable";

export interface RemoteServiceRecord {
  workspaceId: string;
  workerId: string;
  sessionId: string;
  label: string;
  ports: number[];
  status: RemoteServiceStatus;
  startedAt: string;
  exitCode?: number | null;
}

export interface ProxySocketHandlers {
  onData: (data: Buffer, binary: boolean) => void;
  onClose: (code?: number, reason?: string) => void;
}

export interface ProxySocket {
  send: (data: Buffer, binary: boolean) => void;
  close: (code?: number, reason?: string) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;
const PROXY_TIMEOUT_MS = 90_000;

type FrameWithoutId<T> = Omit<T, "type" | "requestId" | "proxyId">;

export function createWorkerServicesClient(manager: WorkerConnectionManager) {
  const records = new Map<string, Map<string, RemoteServiceRecord>>();
  const pendingRequests = new Map<string, { workerId: string; resolve: (r: WorkerServiceResult) => void }>();
  const pendingHttp = new Map<string, { workerId: string; resolve: (r: WorkerProxyHttpResult) => void }>();
  const sockets = new Map<string, { workerId: string; opened: (ok: boolean, error?: string) => void; handlers: ProxySocketHandlers }>();

  const recordFor = (workspaceId: string, label: string): RemoteServiceRecord | undefined => records.get(workspaceId)?.get(label);

  manager.onMessage((workerId, message) => {
    switch (message.type) {
      case "service_result": {
        const pending = pendingRequests.get(message.requestId);
        if (pending?.workerId === workerId) { pendingRequests.delete(message.requestId); pending.resolve(message); }
        return;
      }
      case "service_state": {
        const rec = recordFor(message.workspaceId, message.label);
        if (rec?.workerId === workerId) { rec.status = message.status; rec.exitCode = message.exitCode ?? null; }
        return;
      }
      case "proxy_http_result": {
        const pending = pendingHttp.get(message.proxyId);
        if (pending?.workerId === workerId) { pendingHttp.delete(message.proxyId); pending.resolve(message); }
        return;
      }
      case "proxy_ws_opened": {
        const s = sockets.get(message.proxyId);
        if (s?.workerId === workerId) s.opened(message.ok, message.error);
        return;
      }
      case "proxy_ws_data": {
        const s = sockets.get(message.proxyId);
        if (s?.workerId === workerId) s.handlers.onData(Buffer.from(message.dataB64, "base64"), message.binary);
        return;
      }
      case "proxy_ws_close": {
        const s = sockets.get(message.proxyId);
        if (s?.workerId !== workerId) return;
        sockets.delete(message.proxyId);
        s.handlers.onClose(message.code, message.reason);
        return;
      }
      default:
    }
  });

  manager.onDisconnect((workerId) => {
    for (const byLabel of records.values()) {
      for (const rec of byLabel.values()) if (rec.workerId === workerId && rec.status === "running") rec.status = "unreachable";
    }
    const lost = (workerId_: string): string => `fleet worker ${workerId_} disconnected`;
    for (const [id, p] of pendingRequests) if (p.workerId === workerId) { pendingRequests.delete(id); p.resolve({ type: "service_result", requestId: id, ok: false, error: lost(workerId) }); }
    for (const [id, p] of pendingHttp) if (p.workerId === workerId) { pendingHttp.delete(id); p.resolve({ type: "proxy_http_result", proxyId: id, status: 502, headers: {}, error: lost(workerId) }); }
    for (const [id, s] of sockets) if (s.workerId === workerId) { sockets.delete(id); s.opened(false, lost(workerId)); s.handlers.onClose(1011, lost(workerId)); }
  });

  /** Send a service frame and wait for its `service_result`; a missing/stale worker answers `ok: false`. */
  function request(workerId: string, frame: FrameWithoutId<WorkerServiceStart> & { type: "service_start" } | FrameWithoutId<WorkerServiceStop> & { type: "service_stop" }, timeoutMs = REQUEST_TIMEOUT_MS): Promise<WorkerServiceResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve({ type: "service_result", requestId, ok: false, error: `fleet worker ${workerId} did not answer within ${timeoutMs}ms (an older worker build drops this frame)` });
      }, timeoutMs);
      pendingRequests.set(requestId, { workerId, resolve: (r) => { clearTimeout(timer); resolve(r); } });
      if (!manager.send(workerId, { ...frame, requestId } as Parameters<typeof manager.send>[1])) {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        resolve({ type: "service_result", requestId, ok: false, error: `fleet worker ${workerId} is not connected` });
      }
    });
  }

  async function startProcess(args: { workerId: string; sessionId: string; workspaceId: string; label: string; command: string; ports: number[]; cwdRel?: string; env?: Record<string, string> }): Promise<WorkerServiceResult> {
    const { workerId, ...rest } = args;
    const result = await request(workerId, { type: "service_start", kind: "process", ...rest });
    if (result.ok) {
      const byLabel = records.get(args.workspaceId) ?? new Map<string, RemoteServiceRecord>();
      records.set(args.workspaceId, byLabel);
      byLabel.set(args.label, { workspaceId: args.workspaceId, workerId, sessionId: args.sessionId, label: args.label, ports: args.ports, status: "running", startedAt: new Date().toISOString() });
    }
    return result;
  }

  /** Run to completion on the worker (shell `command` or `argv`); registers `ports` for the proxy. */
  function exec(args: { workerId: string; sessionId: string; workspaceId: string; label: string; command?: string; argv?: string[]; envFile?: string; ports?: number[]; cwdRel?: string; scratch?: boolean; timeoutMs?: number }): Promise<WorkerServiceResult> {
    const { workerId, ports, ...rest } = args;
    return request(workerId, { type: "service_start", kind: "exec", ports: ports ?? [], ...rest }, (args.timeoutMs ?? 600_000) + 15_000);
  }

  /** Stop one labelled service (or all of a workspace's) on its worker and forget the record. */
  async function stopServices(workerId: string, workspaceId: string, label?: string): Promise<WorkerServiceResult> {
    const result = await request(workerId, { type: "service_stop", workspaceId, ...(label ? { label } : {}) });
    const byLabel = records.get(workspaceId);
    if (byLabel) {
      if (label) byLabel.delete(label);
      else records.delete(workspaceId);
    }
    return result;
  }

  function proxyHttp(workerId: string, frame: FrameWithoutId<WorkerProxyHttp>): Promise<WorkerProxyHttpResult> {
    const proxyId = randomUUID();
    return new Promise((resolve) => {
      const fail = (error: string): void => resolve({ type: "proxy_http_result", proxyId, status: 502, headers: {}, error });
      const timer = setTimeout(() => { pendingHttp.delete(proxyId); fail(`fleet worker ${workerId} did not answer the proxied request within ${PROXY_TIMEOUT_MS}ms`); }, PROXY_TIMEOUT_MS);
      pendingHttp.set(proxyId, { workerId, resolve: (r) => { clearTimeout(timer); resolve(r); } });
      if (!manager.send(workerId, { type: "proxy_http", proxyId, ...frame })) {
        clearTimeout(timer);
        pendingHttp.delete(proxyId);
        fail(`fleet worker ${workerId} is not connected`);
      }
    });
  }

  /** Open a tunnelled WebSocket; resolves once the worker's upstream socket is open (or has failed). */
  function openProxySocket(workerId: string, frame: FrameWithoutId<WorkerProxyWsOpen>, handlers: ProxySocketHandlers): Promise<{ ok: true; socket: ProxySocket } | { ok: false; error: string }> {
    const proxyId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { sockets.delete(proxyId); resolve({ ok: false, error: "the worker did not open the upstream socket in time" }); }, 15_000);
      sockets.set(proxyId, {
        workerId, handlers,
        opened: (ok, error) => {
          clearTimeout(timer);
          if (!ok) { sockets.delete(proxyId); resolve({ ok: false, error: error ?? "upstream refused" }); return; }
          resolve({
            ok: true,
            socket: {
              send: (data, binary) => { manager.send(workerId, { type: "proxy_ws_data", proxyId, dataB64: data.toString("base64"), binary }); },
              close: (code, reason) => {
                if (sockets.delete(proxyId)) manager.send(workerId, { type: "proxy_ws_close", proxyId, ...(code ? { code } : {}), ...(reason ? { reason } : {}) });
              },
            },
          });
        },
      });
      if (!manager.send(workerId, { type: "proxy_ws_open", proxyId, ...frame })) {
        clearTimeout(timer);
        sockets.delete(proxyId);
        resolve({ ok: false, error: `fleet worker ${workerId} is not connected` });
      }
    });
  }

  return {
    startProcess,
    exec,
    stopServices,
    proxyHttp,
    openProxySocket,
    /** Every service the board believes a workspace has on a worker, with its live/unreachable status. */
    listServices: (workspaceId: string): RemoteServiceRecord[] => [...(records.get(workspaceId)?.values() ?? [])],
    /** The worker a registered port of this workspace lives on, or null (the proxy's allowlist, board side). */
    workerForPort: (workspaceId: string, port: number): string | null => {
      for (const rec of records.get(workspaceId)?.values() ?? []) if (rec.ports.includes(port)) return rec.workerId;
      return null;
    },
    /** Register ports a run-to-completion job (compose) opened, so the proxy may reach them. */
    registerPorts: (args: { workerId: string; sessionId: string; workspaceId: string; label: string; ports: number[] }): void => {
      const byLabel = records.get(args.workspaceId) ?? new Map<string, RemoteServiceRecord>();
      records.set(args.workspaceId, byLabel);
      byLabel.set(args.label, { ...args, status: "running", startedAt: new Date().toISOString() });
    },
  };
}

export type WorkerServicesClient = ReturnType<typeof createWorkerServicesClient>;

const clientByManager = new WeakMap<object, WorkerServicesClient>();

/** The one client per connection manager (it subscribes to the manager's messages exactly once). */
export function getWorkerServicesClient(manager: WorkerConnectionManager): WorkerServicesClient {
  let client = clientByManager.get(manager);
  if (!client) {
    client = createWorkerServicesClient(manager);
    clientByManager.set(manager, client);
  }
  return client;
}
