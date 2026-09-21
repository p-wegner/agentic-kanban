/**
 * Live-refresh transport for `pnpm cli -- tracker` (#1142) — subscribes to the board's
 * WebSocket event stream (the same `/ws/board/:projectId` channel the browser client
 * uses, see `useBoardEvents.ts`) instead of a fixed polling interval, and falls back to
 * interval polling when the socket cannot connect or drops.
 *
 * Kept separate from the CLI wiring (`tracker.ts`) so a test can drive it against a fake
 * socket without a real server or a real terminal — same split as `tracker-render.ts`.
 */

export type TrackerConnectionStatus = "connecting" | "ws" | "polling";

/** Minimal shape of a board WebSocket frame this transport reacts to. */
interface BoardFrame {
  type?: string;
  reason?: string;
}

/** The subset of the `WebSocket` surface this transport drives — real or faked. */
export interface TrackerSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

export interface TrackerTransportOptions {
  /** Opens a new socket to the board's WS endpoint. Injectable so tests can fake it. */
  connect: () => TrackerSocketLike;
  /** Called on a relevant WS event, or on a poll tick — the signal to re-render. */
  onRefresh: () => void;
  /** Called whenever the connection status changes, for the frame's connection indicator. */
  onStatusChange: (status: TrackerConnectionStatus) => void;
  /** Polling cadence while the WS is unavailable. */
  pollIntervalMs: number;
  /** Initial reconnect delay; doubles on each failed attempt up to `reconnectMaxMs`. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export interface TrackerTransport {
  status: TrackerConnectionStatus;
  start(): void;
  stop(): void;
}

const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

/** WS message types that mean the tracker's snapshot may now be stale. */
const REFRESH_MESSAGE_TYPES = new Set(["board_changed", "projects_changed", "session_activity", "session_stats", "session_todos"]);

/**
 * Create the tracker's transport: WebSocket-driven refresh with a polling fallback,
 * reconnect-with-backoff, and a status callback for the connection indicator.
 *
 * Contract: while the socket is open, refreshes are event-driven and the poll timer is
 * off. The moment the socket fails to open, errors, or closes, polling starts immediately
 * (so the dashboard never goes silent) and a reconnect is scheduled with backoff; a
 * successful reconnect turns polling back off.
 */
export function createTrackerTransport(options: TrackerTransportOptions): TrackerTransport {
  const reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;

  let status: TrackerConnectionStatus = "connecting";
  let socket: TrackerSocketLike | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = reconnectBaseMs;
  let stopped = true;

  function setStatus(next: TrackerConnectionStatus) {
    if (status === next) return;
    status = next;
    options.onStatusChange(next);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => options.onRefresh(), options.pollIntervalMs);
    (pollTimer as unknown as { unref?: () => void }).unref?.();
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(delay * 2, reconnectMaxMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    (reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  function closeSocket() {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // already closing/closed
    }
    socket = null;
  }

  function handleDisconnect() {
    if (stopped) return;
    socket = null;
    // The socket is down — poll so the dashboard keeps refreshing while we retry.
    startPolling();
    setStatus("polling");
    scheduleReconnect();
  }

  function connect() {
    if (stopped) return;
    closeSocket();

    let opened = false;
    const ws = options.connect();
    socket = ws;

    ws.onopen = () => {
      if (stopped || socket !== ws) return;
      opened = true;
      reconnectDelayMs = reconnectBaseMs;
      stopPolling();
      setStatus("ws");
      // Pick up anything that changed while we were disconnected/polling.
      options.onRefresh();
    };

    ws.onmessage = (event: { data: unknown }) => {
      if (stopped || socket !== ws) return;
      let frame: BoardFrame;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as BoardFrame;
      } catch {
        return; // ignore malformed frames
      }
      if (!frame?.type || !REFRESH_MESSAGE_TYPES.has(frame.type)) return;
      options.onRefresh();
    };

    ws.onerror = () => {
      // Followed by onclose (or, if the connection never opened, may fire alone on some
      // implementations) — either way, let onclose drive the transition so it only
      // happens once.
    };

    ws.onclose = () => {
      if (socket !== ws) return; // stale close from a socket we already replaced
      const wasOpen = opened;
      handleDisconnect();
      void wasOpen; // no different handling today; named for clarity when reading a trace
    };
  }

  return {
    get status() {
      return status;
    },
    start() {
      if (!stopped) return;
      stopped = false;
      reconnectDelayMs = reconnectBaseMs;
      setStatus("connecting");
      // Poll immediately too — the WS may take a moment to open, or may never open, and
      // the dashboard should never sit blank waiting to find out which.
      startPolling();
      connect();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stopPolling();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      closeSocket();
    },
  };
}
