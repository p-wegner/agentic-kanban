/**
 * CLI issue writes pick their transport: the running board server when it serves the SAME
 * database file (so the board broadcasts and an open UI shows the change), else the direct
 * DB path with one notice. Every server here is a fake on listen(0); no test touches a real
 * board or a real database.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolveIssueWriteTransport, boardServerWrite, directWriteNotice } from "../board-server-writes.js";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

let server: Server | null = null;

async function fakeBoard(handler: Handler): Promise<number> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return (server!.address() as AddressInfo).port;
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

const DB = "C:\\Users\\someone\\.agentic-kanban\\kanban.db";
const env = {} as Record<string, string | undefined>;

describe("resolveIssueWriteTransport", () => {
  it("uses the server when it answers and serves the same database file (case-insensitive on win32)", async () => {
    const port = await fakeBoard((_req, _b, res) => json(res, 200, { status: "ok", db: { path: DB.toUpperCase() } }));
    const t = await resolveIssueWriteTransport({ port, cliDbPath: DB, env, platform: "win32" });
    expect(t).toEqual({ mode: "server", baseUrl: `http://127.0.0.1:${port}` });
  });

  it("stays direct when the server serves a DIFFERENT database (temp/dev DB never writes into a live board)", async () => {
    const port = await fakeBoard((_req, _b, res) => json(res, 200, { status: "ok", db: { path: "/elsewhere/kanban.db" } }));
    const t = await resolveIssueWriteTransport({ port, cliDbPath: DB, env, platform: "win32" });
    expect(t.mode).toBe("direct");
    if (t.mode === "direct") expect(t.reason).toContain("serves a different database");
  });

  it("stays direct when the server does not report its database", async () => {
    const port = await fakeBoard((_req, _b, res) => json(res, 200, { status: "ok" }));
    const t = await resolveIssueWriteTransport({ port, cliDbPath: DB, env });
    expect(t.mode).toBe("direct");
  });

  it("stays direct when the server reports unhealthy", async () => {
    const port = await fakeBoard((_req, _b, res) => json(res, 503, { status: "degraded", db: { path: DB } }));
    const t = await resolveIssueWriteTransport({ port, cliDbPath: DB, env, platform: "win32" });
    expect(t).toEqual({ mode: "direct", reason: `the board server on 127.0.0.1:${port} reported unhealthy (HTTP 503)` });
  });

  it("stays direct when nothing answers, after ONE request", async () => {
    let calls = 0;
    const http = async () => { calls++; throw new Error("ECONNREFUSED"); };
    const t = await resolveIssueWriteTransport({ port: 4999, cliDbPath: DB, env, http });
    expect(t).toEqual({ mode: "direct", reason: "no board server answered on 127.0.0.1:4999" });
    expect(calls).toBe(1);
  });

  it("KANBAN_CLI_WRITE_TRANSPORT=direct skips the probe", async () => {
    let calls = 0;
    const http = async () => { calls++; throw new Error("must not be called"); };
    const t = await resolveIssueWriteTransport({ cliDbPath: DB, env: { KANBAN_CLI_WRITE_TRANSPORT: "direct" }, http });
    expect(t.mode).toBe("direct");
    expect(calls).toBe(0);
  });

  it("resolves the port from the shared ladder when none is passed", async () => {
    const seen: string[] = [];
    const http = async (url: string) => { seen.push(url); throw new Error("down"); };
    await resolveIssueWriteTransport({ cliDbPath: DB, env: { KANBAN_BOARD_SERVER_PORT: "4321" }, http });
    expect(seen).toEqual(["http://127.0.0.1:4321/api/health"]);
  });
});

describe("boardServerWrite", () => {
  it("sends the JSON body on a non-reused connection and returns the parsed answer", async () => {
    const seen: { method?: string; url?: string; body: string; connection?: string }[] = [];
    const port = await fakeBoard((req, body, res) => {
      seen.push({ method: req.method, url: req.url, body, connection: req.headers.connection });
      json(res, 201, { id: "i-1", issueNumber: 7 });
    });
    const out = await boardServerWrite<{ issueNumber: number }>({ baseUrl: `http://127.0.0.1:${port}` }, "POST", "/api/issues", { title: "T", tags: ["a"] });
    expect(out.issueNumber).toBe(7);
    expect(seen).toEqual([{ method: "POST", url: "/api/issues", body: JSON.stringify({ title: "T", tags: ["a"] }), connection: "close" }]);
  });

  it("throws the server's own error text on a refusal (e.g. the AK-535 409)", async () => {
    const port = await fakeBoard((_req, _b, res) => json(res, 409, { error: "Cannot move to Done: branch feature/x is unmerged" }));
    await expect(
      boardServerWrite({ baseUrl: `http://127.0.0.1:${port}` }, "PATCH", "/api/issues/x", { statusId: "s" }),
    ).rejects.toThrow("Cannot move to Done: branch feature/x is unmerged");
  });
});

describe("directWriteNotice", () => {
  it("is one line naming the reason and the reload consequence", () => {
    const line = directWriteNotice("no board server answered on 127.0.0.1:3001");
    expect(line).not.toContain("\n");
    expect(line).toContain("no board server answered on 127.0.0.1:3001");
    expect(line).toContain("will not show this change until it is reloaded");
  });
});
