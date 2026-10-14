// #1376: half-open board socket detection for the worker daemon. A board restart whose RST never
// reaches the worker leaves the socket "open" and silent forever; two detectors catch it.
import WebSocket from "ws";

/** Worker-side WS ping; no pong within the deadline means a dead link (detected within ~35s). */
const PING_INTERVAL_MS = 15 * 1000;
const PONG_TIMEOUT_MS = 20 * 1000;
/** A `socket:false` heartbeat answer is ignored this long after connect: the board may not have processed `hello` yet. */
const BOARD_PING_GAP_WARN_MS = 20 * 1000;
const SOCKET_FALSE_GRACE_MS = 10 * 1000;

const startedAt = new WeakMap<WebSocket, number>();

/**
 * Ping on an interval; no pong within the deadline => terminate, which fires `close` and the
 * daemon's normal reconnect path. Stops itself when the socket closes.
 */
export function startSocketKeepalive(
  socket: WebSocket,
  opts: { pingIntervalMs?: number; pongTimeoutMs?: number },
  log: (line: string) => void,
): void {
  const intervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
  const deadlineMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
  startedAt.set(socket, Date.now());
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPong = () => { if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; } };
  const pingTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN || pongTimer) return;
    try { socket.ping(); } catch { /* a dead socket is caught by the deadline below */ }
    pongTimer = setTimeout(() => {
      pongTimer = null;
      log(`[worker] board socket dead (no pong in ${Math.round(deadlineMs / 1000)}s) - reconnecting`);
      socket.terminate();
    }, deadlineMs);
    pongTimer.unref?.();
  }, intervalMs);
  pingTimer.unref?.();
  socket.on("pong", clearPong);
  // #1480: which side stops answering? Log a gap between board pings far above its cadence — it means
  // THIS worker's event loop (or the link) held them back, and says so in the worker's own log.
  let lastBoardPingAt = Date.now();
  socket.on("ping", () => {
    const now = Date.now();
    const gap = now - lastBoardPingAt;
    lastBoardPingAt = now;
    if (gap > BOARD_PING_GAP_WARN_MS) log(`[worker] board ping arrived ${Math.round(gap / 1000)}s after the previous one (expected ~10s) - link or worker event loop stalled`);
  });
  socket.on("close", () => { clearInterval(pingTimer); clearPong(); });
}

/**
 * The heartbeat response said the board holds no socket for us (`socket:false`) while ours looks
 * open: drop it so the daemon reconnects. Returns `body` unchanged so it can sit in a call chain.
 */
export function dropSocketIfBoardHasNone(
  body: unknown, ws: WebSocket | null, heartbeatMs: number, log: (line: string) => void,
): unknown {
  if (typeof body !== "object" || body === null || (body as { socket?: unknown }).socket !== false) return body;
  const age = Date.now() - (ws ? startedAt.get(ws) ?? 0 : 0);
  if (!ws || ws.readyState !== WebSocket.OPEN || age <= Math.min(SOCKET_FALSE_GRACE_MS, heartbeatMs)) return body;
  log("[worker] board reports no socket for this worker - dropping ours and reconnecting");
  ws.terminate();
  return body;
}
