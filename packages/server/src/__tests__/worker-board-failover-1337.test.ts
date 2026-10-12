// #1337 — a worker holds an ordered list of board URLs for ONE board: it pairs once (state keyed by
// the board's identity, not the URL), uses the first URL that answers, fails over when it drops,
// returns to the preferred one when it answers again, and builds the git URL from the connected one.

import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";
import { adoptBoardId, findIdentity, loadState, parseBoardList, saveIdentity } from "../worker/worker-state.js";
import { savedBoardUrls } from "../cli/commands/worker-board-default.js";

const BOARD_ID = "board1337";

interface FakeBoard {
  url: string;
  port: number;
  registrations: () => number;
  accepted: ServerSocket[];
  close(): Promise<void>;
}

/** A fake board URL. `shared` lets two URLs of the same board share one registration counter. */
async function startFakeBoard(opts: { port?: number; boardId?: string | null; shared?: { registrations: number } } = {}): Promise<FakeBoard> {
  const shared = opts.shared ?? { registrations: 0 };
  const boardId = opts.boardId === undefined ? BOARD_ID : opts.boardId;
  const accepted: ServerSocket[] = [];
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (s: ServerSocket) => { accepted.push(s); });
  const server: Server = createServer((req, res) => {
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return json({ ok: true, ...(boardId ? { boardId } : {}) });
    if (req.method === "POST" && req.url === "/api/workers/register") {
      shared.registrations += 1;
      return json({ workerId: `w-${randomUUID()}`, workerToken: "tok", ...(boardId ? { boardId } : {}) }, 201);
    }
    if (req.method === "POST" && /\/heartbeat$/.test(req.url ?? "")) return json({ ok: true });
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    registrations: () => shared.registrations,
    accepted,
    close: () => {
      for (const s of accepted) s.terminate();
      server.closeAllConnections?.();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("identity-keyed worker state (#1337)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const stateFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-worker-1337-"));
    dirs.push(dir);
    return join(dir, "worker-state.json");
  };

  it("parses repeated / comma-separated --board values in order, deduplicated", () => {
    expect(parseBoardList(["http://a:1/,http://b:2", "http://a:1", " http://c:3 "])).toEqual(["http://a:1", "http://b:2", "http://c:3"]);
  });

  it("migrates a URL-keyed pairing onto the board identity when the id is learned", () => {
    const file = stateFile();
    writeFileSync(file, JSON.stringify({ boards: { "http://lan:3003": { workerId: "w1", workerToken: "t1", name: "n" } } }));
    expect(findIdentity(loadState(file), "http://lan:3003")?.workerId).toBe("w1"); // legacy lookup still works

    expect(adoptBoardId(file, "http://lan:3003", "bX")).toBe(true);
    const state = loadState(file);
    expect(Object.keys(state.boards)).toEqual(["board:bX"]);
    expect(state.boards["board:bX"]).toMatchObject({ workerId: "w1", workerToken: "t1", boardId: "bX" });

    // A second URL of the same board resolves to the SAME pairing once it is mapped.
    expect(findIdentity(loadState(file), "http://tail:3003")).toBeUndefined();
    adoptBoardId(file, "http://tail:3003", "bX");
    expect(findIdentity(loadState(file), "http://tail:3003")?.workerId).toBe("w1");
    expect(adoptBoardId(file, "http://tail:3003", "bX")).toBe(false); // idempotent
  });

  it("lists one board once, however many URLs map to it", () => {
    const file = stateFile();
    saveIdentity(file, "http://lan:3003", { workerId: "w", workerToken: "t", name: "n", boardId: "bY" }, ["http://lan:3003", "http://tail:3003"]);
    expect(savedBoardUrls(file)).toEqual(["http://lan:3003"]);
  });
});

describe("worker board URL failover (#1337)", () => {
  let daemon: WorkerDaemonHandle | undefined;
  const boards: FakeBoard[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await daemon?.stop({ killAgents: true, drainTimeoutMs: 100 }).catch(() => {});
    daemon = undefined;
    for (const b of boards.splice(0)) await b.close().catch(() => {});
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const stateFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-worker-1337-"));
    dirs.push(dir);
    return join(dir, "worker-state.json");
  };

  it("pairs once over the first URL, fails over when it stops, and keeps the pairing", async () => {
    const shared = { registrations: 0 };
    const lan = await startFakeBoard({ shared });
    const tail = await startFakeBoard({ shared });
    boards.push(lan, tail);
    const file = stateFile();
    const logs: string[] = [];

    daemon = await startWorkerDaemon({
      boardUrl: lan.url,
      boardUrls: [lan.url, tail.url],
      pairingToken: "pair",
      name: "failover",
      stateFile: file,
      heartbeatIntervalMs: 60 * 60 * 1000,
      pingIntervalMs: 100,
      pongTimeoutMs: 300,
      log: (l) => logs.push(l),
    });
    await daemon.connected;
    expect(lan.accepted.length).toBe(1);
    expect(tail.accepted.length).toBe(0);
    expect(shared.registrations).toBe(1);

    const state = loadState(file);
    expect(Object.keys(state.boards)).toEqual([`board:${BOARD_ID}`]);
    expect(state.urls).toEqual({ [lan.url]: BOARD_ID, [tail.url]: BOARD_ID });

    // The LAN listener goes away: the worker fails over to the tailnet URL, same pairing.
    await lan.close();
    await vi.waitFor(() => expect(tail.accepted.length).toBeGreaterThanOrEqual(1), { timeout: 15000 });
    expect(shared.registrations).toBe(1);
    expect(logs.some((l) => l.includes("connected to " + tail.url))).toBe(true);
    expect(Object.keys(loadState(file).boards)).toEqual([`board:${BOARD_ID}`]);
  }, 30000);

  it("starts on the first URL that answers (order, then liveness) and registers there", async () => {
    const dead = await startFakeBoard();
    const deadUrl = dead.url;
    await dead.close();
    const live = await startFakeBoard();
    boards.push(live);

    daemon = await startWorkerDaemon({
      boardUrl: deadUrl,
      boardUrls: [deadUrl, live.url],
      pairingToken: "pair",
      name: "first-answering",
      stateFile: stateFile(),
      heartbeatIntervalMs: 60 * 60 * 1000,
      log: () => {},
    });
    await daemon.connected;
    expect(live.registrations()).toBe(1);
    expect(live.accepted.length).toBe(1);
  }, 30000);

  it("returns to the preferred URL once it answers again", async () => {
    const shared = { registrations: 0 };
    const lan = await startFakeBoard({ shared });
    const lanPort = lan.port;
    const tail = await startFakeBoard({ shared });
    boards.push(tail);
    const logs: string[] = [];

    daemon = await startWorkerDaemon({
      boardUrl: lan.url,
      boardUrls: [lan.url, tail.url],
      pairingToken: "pair",
      name: "return-to-preferred",
      stateFile: stateFile(),
      heartbeatIntervalMs: 250,
      pingIntervalMs: 100,
      pongTimeoutMs: 300,
      log: (l) => logs.push(l),
    });
    await daemon.connected;
    await lan.close();
    await vi.waitFor(() => expect(tail.accepted.length).toBeGreaterThanOrEqual(1), { timeout: 15000 });

    const lanAgain = await startFakeBoard({ port: lanPort, shared });
    boards.push(lanAgain);
    await vi.waitFor(() => expect(lanAgain.accepted.length).toBeGreaterThanOrEqual(1), { timeout: 20000 });
    expect(logs.some((l) => l.includes("preferred board URL") && l.includes("answers again"))).toBe(true);
    expect(shared.registrations).toBe(1);
  }, 40000);

  it("resumes the pairing of a legacy URL-keyed state file and migrates it", async () => {
    const board = await startFakeBoard();
    boards.push(board);
    const file = stateFile();
    writeFileSync(file, JSON.stringify({ boards: { [board.url]: { workerId: "w-legacy", workerToken: "tok", name: "legacy" } } }));

    daemon = await startWorkerDaemon({
      boardUrl: board.url,
      name: "legacy",
      stateFile: file,
      heartbeatIntervalMs: 60 * 60 * 1000,
      log: () => {},
    });
    await daemon.connected;
    expect(daemon.workerId).toBe("w-legacy");
    expect(board.registrations()).toBe(0); // resumed, not re-registered
    const state = JSON.parse(readFileSync(file, "utf8")) as { boards: Record<string, { workerId: string }>; urls: Record<string, string> };
    expect(Object.keys(state.boards)).toEqual([`board:${BOARD_ID}`]);
    expect(state.boards[`board:${BOARD_ID}`]?.workerId).toBe("w-legacy");
    expect(state.urls[board.url]).toBe(BOARD_ID);
  }, 30000);

  it("a second URL of an already-paired board reuses the pairing (no second registration)", async () => {
    const shared = { registrations: 0 };
    const lan = await startFakeBoard({ shared });
    const tail = await startFakeBoard({ shared });
    boards.push(lan, tail);
    const file = stateFile();
    const common = { pairingToken: "pair", name: "reuse", stateFile: file, heartbeatIntervalMs: 60 * 60 * 1000, log: () => {} };

    daemon = await startWorkerDaemon({ ...common, boardUrl: lan.url });
    await daemon.connected;
    const firstId = daemon.workerId;
    await daemon.stop({ killAgents: true, drainTimeoutMs: 100 });

    // Restart with only the OTHER url: same board id => same pairing.
    daemon = await startWorkerDaemon({ ...common, boardUrl: tail.url });
    await daemon.connected;
    expect(daemon.workerId).toBe(firstId);
    expect(shared.registrations).toBe(1);
  }, 30000);
});
