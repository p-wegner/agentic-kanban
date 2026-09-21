import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTrackerTransport, type TrackerSocketLike, type TrackerConnectionStatus } from "./tracker-transport.js";

/**
 * A fake socket the test controls directly: `open()`/`message()`/`close()` invoke the
 * handlers the transport wired up, mirroring how a real `WebSocket` calls `onopen` /
 * `onmessage` / `onclose`. `close()` on the instance itself (called BY the transport,
 * e.g. on `stop()` or reconnect) is recorded separately from the test-driven `close()`.
 */
function createFakeSocket(): TrackerSocketLike & { open(): void; message(data: unknown): void; remoteClose(): void; closeCallCount: number } {
  let closeCallCount = 0;
  const socket: TrackerSocketLike & { open(): void; message(data: unknown): void; remoteClose(): void; closeCallCount: number } = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    close() {
      closeCallCount++;
    },
    get closeCallCount() {
      return closeCallCount;
    },
    open() {
      socket.onopen?.();
    },
    message(data: unknown) {
      socket.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
    },
    remoteClose() {
      socket.onclose?.();
    },
  };
  return socket;
}

describe("createTrackerTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes on a relevant board WS event once connected", () => {
    const sockets: ReturnType<typeof createFakeSocket>[] = [];
    const onRefresh = vi.fn();
    const statuses: TrackerConnectionStatus[] = [];

    const transport = createTrackerTransport({
      connect: () => {
        const s = createFakeSocket();
        sockets.push(s);
        return s;
      },
      onRefresh,
      onStatusChange: (s) => statuses.push(s),
      pollIntervalMs: 5000,
    });

    transport.start();
    expect(sockets).toHaveLength(1);

    sockets[0].open();
    expect(transport.status).toBe("ws");
    expect(onRefresh).toHaveBeenCalledTimes(1); // the connect-time catch-up refresh

    sockets[0].message({ type: "board_changed", projectId: "p1", reason: "workspace_created" });
    expect(onRefresh).toHaveBeenCalledTimes(2);

    sockets[0].message({ type: "board_changed", projectId: "p1", reason: "issue_updated" });
    expect(onRefresh).toHaveBeenCalledTimes(3);

    // An irrelevant/unknown frame type is ignored.
    sockets[0].message({ type: "approval_requested" });
    expect(onRefresh).toHaveBeenCalledTimes(3);

    transport.stop();
  });

  it("falls back to polling when the socket errors/closes before ever opening", () => {
    const sockets: ReturnType<typeof createFakeSocket>[] = [];
    const onRefresh = vi.fn();

    const transport = createTrackerTransport({
      connect: () => {
        const s = createFakeSocket();
        sockets.push(s);
        return s;
      },
      onRefresh,
      onStatusChange: () => {},
      pollIntervalMs: 5000,
      reconnectBaseMs: 1000,
      reconnectMaxMs: 8000,
    });

    transport.start();
    expect(transport.status).toBe("connecting");

    // The connection never opens — it fails outright.
    sockets[0].remoteClose();
    expect(transport.status).toBe("polling");
    onRefresh.mockClear();

    // No WS traffic arrives; the poll timer alone drives refreshes now.
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(2);

    transport.stop();
  });

  it("stops polling and returns to ws status once a reconnect succeeds", () => {
    const sockets: ReturnType<typeof createFakeSocket>[] = [];
    const onRefresh = vi.fn();

    const transport = createTrackerTransport({
      connect: () => {
        const s = createFakeSocket();
        sockets.push(s);
        return s;
      },
      onRefresh,
      onStatusChange: () => {},
      pollIntervalMs: 5000,
      reconnectBaseMs: 1000,
      reconnectMaxMs: 8000,
    });

    transport.start();
    sockets[0].remoteClose(); // first attempt fails -> polling + reconnect scheduled
    expect(transport.status).toBe("polling");

    onRefresh.mockClear();
    vi.advanceTimersByTime(1000); // fires the scheduled reconnect
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    expect(transport.status).toBe("ws");

    // Polling must have stopped — advancing well past the poll interval produces no
    // further poll-driven refreshes beyond the single connect-time catch-up refresh.
    onRefresh.mockClear();
    vi.advanceTimersByTime(20_000);
    expect(onRefresh).toHaveBeenCalledTimes(0);

    transport.stop();
  });

  it("backs off exponentially between reconnect attempts, capped at reconnectMaxMs", () => {
    const sockets: ReturnType<typeof createFakeSocket>[] = [];

    const transport = createTrackerTransport({
      connect: () => {
        const s = createFakeSocket();
        sockets.push(s);
        return s;
      },
      onRefresh: () => {},
      onStatusChange: () => {},
      pollIntervalMs: 60_000, // large, so it doesn't interfere with the reconnect timing assertions
      reconnectBaseMs: 1000,
      reconnectMaxMs: 4000,
    });

    transport.start();
    sockets[0].remoteClose(); // attempt 1 fails

    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1); // not yet — base delay is 1000ms
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2); // attempt 2 at +1000ms

    sockets[1].remoteClose(); // attempt 2 fails
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3); // attempt 3 at +2000ms (doubled)

    sockets[2].remoteClose(); // attempt 3 fails
    vi.advanceTimersByTime(3999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4); // attempt 4 at +4000ms (doubled again, would be 4000 uncapped too)

    sockets[3].remoteClose(); // attempt 4 fails
    vi.advanceTimersByTime(3999);
    expect(sockets).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(5); // attempt 5 at +4000ms — capped, not 8000ms

    transport.stop();
  });

  it("drops a stale close from a socket already replaced by a newer connection", () => {
    const sockets: ReturnType<typeof createFakeSocket>[] = [];
    const statuses: TrackerConnectionStatus[] = [];

    const transport = createTrackerTransport({
      connect: () => {
        const s = createFakeSocket();
        sockets.push(s);
        return s;
      },
      onRefresh: () => {},
      onStatusChange: (s) => statuses.push(s),
      pollIntervalMs: 5000,
      reconnectBaseMs: 1000,
    });

    transport.start();
    sockets[0].remoteClose();
    vi.advanceTimersByTime(1000);
    sockets[1].open();
    expect(transport.status).toBe("ws");

    statuses.length = 0;
    // A belated close event from the now-discarded FIRST socket must not flip status.
    sockets[0].remoteClose();
    expect(statuses).toHaveLength(0);
    expect(transport.status).toBe("ws");

    transport.stop();
  });

  it("stop() tears down the socket and cancels any pending reconnect/poll timers", () => {
    const sockets: ReturnType<typeof createFakeSocket>[] = [];
    const onRefresh = vi.fn();

    const transport = createTrackerTransport({
      connect: () => {
        const s = createFakeSocket();
        sockets.push(s);
        return s;
      },
      onRefresh,
      onStatusChange: () => {},
      pollIntervalMs: 1000,
      reconnectBaseMs: 1000,
    });

    transport.start();
    sockets[0].open();
    transport.stop();
    expect(sockets[0].closeCallCount).toBe(1);

    onRefresh.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(onRefresh).not.toHaveBeenCalled();
    // No new reconnect attempts either.
    expect(sockets).toHaveLength(1);
  });
});
