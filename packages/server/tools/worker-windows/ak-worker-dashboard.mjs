/**
 * ak-worker-dashboard.mjs - a live, browser-based status view for the
 * agentic-kanban fleet worker on this machine.
 *
 *   node ak-worker-dashboard.mjs [--port N] [--open] [--host 127.0.0.1]
 *
 * Replaces the tray's old "Status in a window", which shelled out to
 * `ak-worker-service.ps1 -Status` in a PowerShell window: correct once, then
 * frozen. The worker's interesting states are all transitions - reconnect
 * backoff, a dispatch arriving, an agent exiting - so a snapshot is exactly the
 * wrong shape. This pushes state over SSE instead.
 *
 * DELIBERATELY NOT A SECOND SOURCE OF TRUTH. The snapshot is a port of
 * Get-State in ak-worker-tray.ps1, field for field: scheduled task presence,
 * supervisor process, daemon process, board from config.json, and
 * connection/sessions/since derived from the same log tail with the same
 * regexes. The tray dot and this page must never be able to disagree - this
 * tooling has already been bitten once by a worker that "looked registered and
 * healthy for an hour while every dispatch to it silently wedged", and two
 * independent state readers is how that bug comes back.
 *
 * LOOPBACK ONLY. Binds 127.0.0.1 and refuses cross-origin requests. The page
 * reveals the board URL, the worker name and the log, and the log carries
 * session ids and repo paths. There is no reason for it to be reachable off the
 * machine, and the fleet's own rule is that only the bearer-authed fleet and git
 * ports are ever exposed. Read-only: it starts nothing and stops nothing.
 *
 * Zero dependencies, Node stdlib only - matching the rest of worker-windows,
 * which a worker machine must be able to run without a repo install.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_FILE = join(HERE, "ui", "worker-dashboard.html");

const STATE_DIR = join(process.env.LOCALAPPDATA || process.env.HOME || ".", "agentic-kanban-worker");
const CONFIG_FILE = join(STATE_DIR, "config.json");
const LOG_FILE = join(STATE_DIR, "worker.log");
const INFO_FILE = join(STATE_DIR, "dashboard.json");
const TOKEN_FILE = join(STATE_DIR, "dashboard-token");
const TASK_NAME = "AgenticKanbanWorker";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DEFAULT_PORT = Number(process.env.AK_WORKER_DASHBOARD_PORT || flag("--port", 3009));
const HOST = flag("--host", "127.0.0.1");
const OPEN = args.includes("--open");

// How much of the log the state derivation reads. 400 lines matches the tray so
// the two agree on "sessions in flight" even during a burst of dispatches.
const STATE_TAIL_LINES = 400;
const LOG_VIEW_LINES = 300;
const TICK_MS = 2000;
// The board probe is the only network call, so it runs on its own slower cadence
// rather than per tick - same reason the tray probes every 10th tick.
const BOARD_PROBE_MS = 30000;

// ── token ─────────────────────────────────────────────────────────────────────
// Loopback binding is the real control; the token stops another *local* process
// (or a page in the browser that already has script execution) from reading the
// log by guessing the port. Written 0600-ish by virtue of living in LOCALAPPDATA.
function readToken() {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    const tok = randomBytes(24).toString("hex");
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(TOKEN_FILE, tok, "utf8");
    } catch { /* a read-only state dir just means a per-run token */ }
    return tok;
  }
}
const TOKEN = readToken();

// ── state, ported from Get-State in ak-worker-tray.ps1 ────────────────────────
function tailLines(file, n) {
  try {
    if (!existsSync(file)) return [];
    // The log is append-only and small (the supervisor rotates nothing today),
    // so a whole-file read is honest and avoids a partial-line seek bug. If it
    // ever grows unbounded that is a worker-windows problem, not a reader one.
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

async function scheduledTaskPresent() {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", `if (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`],
      { timeout: 8000 },
    );
    return stdout.trim() === "yes";
  } catch {
    return false;
  }
}

async function processes() {
  if (process.platform !== "win32") return { supervisor: false, daemon: false };
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='powershell.exe'\" | " +
          "Select-Object -ExpandProperty CommandLine",
      ],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
    );
    const lines = stdout.split(/\r?\n/);
    const supervisor = lines.some((l) => l.includes("ak-worker-run.ps1"));
    // Same three-part test the tray uses: an agentic-kanban worker process that
    // is NOT the supervisor script itself.
    const daemon = lines.some(
      (l) => l.includes("agentic-kanban") && l.includes("worker") && !l.includes("ak-worker-run.ps1"),
    );
    return { supervisor, daemon };
  } catch {
    return { supervisor: false, daemon: false };
  }
}

function fromConfig() {
  try {
    // STRIP THE BOM. ak-worker-service.ps1 writes config.json from PowerShell,
    // which emits UTF-8 *with* a BOM by default. PowerShell's own
    // ConvertFrom-Json tolerates it, so the tray never noticed - but JSON.parse
    // throws on it, and the catch below turned that into a silently empty board
    // and name rather than an error. Found exactly that way.
    const raw = readFileSync(CONFIG_FILE, "utf8").replace(/^﻿/, "");
    const cfg = JSON.parse(raw);
    return { board: cfg.board || null, name: cfg.name || null, labels: cfg.labels || null };
  } catch {
    return { board: null, name: null, labels: null };
  }
}

function fromLog(lines) {
  const out = { connection: "unknown", since: null, sessions: 0, lastLine: null, sessionIds: [] };
  if (!lines.length) return out;
  out.lastLine = lines[lines.length - 1];

  // In-flight count is launched-minus-exited over the window, floored at 0 -
  // identical to the tray. It is approximate by construction: a dispatch whose
  // launch line has aged out of the window reads as one fewer.
  const launched = lines.filter((l) => /launched agent/.test(l));
  const exited = lines.filter((l) => /agent exited/.test(l));
  out.sessions = Math.max(0, launched.length - exited.length);

  const idOf = (l) => (l.match(/sessionId=([0-9a-f-]{8,})/) || [])[1];
  const done = new Set(exited.map(idOf).filter(Boolean));
  out.sessionIds = launched.map(idOf).filter((id) => id && !done.has(id));

  const conn = [...lines].reverse().find((l) => /connected to|disconnected|socket error/.test(l));
  if (conn) {
    out.connection = /connected to/.test(conn) ? "connected" : "disconnected";
    const ts = conn.match(/(\d{4}-\d{2}-\d{2}T[\d:]+Z)/);
    if (ts) out.since = ts[1];
  }
  return out;
}

let boardOk = null;
let boardCheckedAt = null;
let boardUi = null;

/**
 * Find the board's UI, if this machine can reach it at all.
 *
 * The worker is never told the UI's port -- it only ever learns the FLEET port,
 * because the fleet channel is the only thing a worker legitimately needs. So
 * this probes the usual candidates on the board's host and reports whichever
 * answers: the Vite dev server, then the port the built client is served from.
 *
 * Only the ROOT is probed, and only the root is ever linked. The board API under
 * /api has no authentication, so this deliberately does not touch it, surface it,
 * or invite anyone else to -- a worker dashboard is not the place to make an
 * unauthenticated control plane one click closer.
 *
 * Reporting nothing when nothing answers is the correct outcome, not a failure:
 * a board whose UI is loopback-only is a board configured the way the docs say.
 */
const BOARD_UI_PORTS = (process.env.AK_BOARD_UI_PORTS || "5173,3001")
  .split(",").map((p) => Number(p.trim())).filter(Boolean);

async function probeBoardUi(board) {
  if (!board) return;
  let host;
  try { host = new URL(board).hostname; } catch { return; }
  for (const port of BOARD_UI_PORTS) {
    const url = `http://${host}:${port}/`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) { boardUi = url; return; }
    } catch { /* not reachable on this port; try the next */ }
  }
  boardUi = null;
}

async function probeBoard(board) {
  if (!board) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${board}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    boardOk = res.ok;
  } catch {
    boardOk = false;
  }
  boardCheckedAt = new Date().toISOString();
}

/**
 * The same five states the tray dot encodes, in the same precedence order.
 * Kept here rather than in the page so the verdict has one definition.
 */
function verdict(s) {
  if (!s.installed && !s.supervisor) return { key: "grey", text: "service not installed" };
  if (!s.daemon) return { key: "red", text: "daemon down (supervisor backoff)" };
  if (s.connection === "disconnected") return { key: "red", text: "disconnected from board" };
  if (s.sessions > 0) return { key: "blue", text: `running ${s.sessions} session(s)` };
  if (s.boardOk === false) return { key: "yellow", text: "board unreachable from here" };
  return { key: "green", text: "connected, idle" };
}

async function snapshot() {
  const lines = tailLines(LOG_FILE, STATE_TAIL_LINES);
  const [installed, procs] = await Promise.all([scheduledTaskPresent(), processes()]);
  const cfg = fromConfig();
  const log = fromLog(lines);
  const s = {
    at: new Date().toISOString(),
    installed,
    supervisor: procs.supervisor,
    daemon: procs.daemon,
    board: cfg.board,
    name: cfg.name,
    labels: cfg.labels,
    boardOk,
    boardCheckedAt,
    boardUi,
    logFile: LOG_FILE,
    logExists: existsSync(LOG_FILE),
    logSize: existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0,
    ...log,
  };
  s.verdict = verdict(s);
  return s;
}

// ── server ────────────────────────────────────────────────────────────────────
const clients = new Set();
let latest = null;

function broadcast(snap) {
  const payload = `data: ${JSON.stringify(snap)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function authed(url, req) {
  if (url.searchParams.get("token") === TOKEN) return true;
  const h = req.headers["x-dashboard-token"];
  return typeof h === "string" && h === TOKEN;
}

// A browser page on any origin can issue a GET to loopback. The Origin check is
// what stops a random site polling this port and reading the log.
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // same-origin fetches and EventSource send none
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const path = url.pathname;

  if (!originOk(req)) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("cross-origin refused");
  }

  if (path === "/" || path === "/index.html") {
    let html;
    try {
      html = readFileSync(UI_FILE, "utf8");
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end(`dashboard UI missing at ${UI_FILE}`);
    }
    // The token is injected rather than typed: this is a local convenience view,
    // and a copy-paste step would just train people to disable it.
    html = html.replace("__TOKEN__", TOKEN);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  }

  if (path === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, pid: process.pid }));
  }

  // Unauthenticated on purpose, and above the auth gate: the browser requests it
  // with no token and a 401 here is a console error on every load. It carries the
  // same colour as the tray dot, so a backgrounded tab shows worker state in its
  // favicon - which is most of why anyone leaves this page open.
  if (path === "/favicon.ico" || path === "/favicon.svg") {
    const colours = { grey: "#9aa2ad", red: "#dc4b3e", yellow: "#d99413", green: "#2e9e57", blue: "#3b7fd4" };
    const fill = colours[latest?.verdict?.key] || colours.grey;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${fill}"/></svg>`;
    res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
    return res.end(svg);
  }

  if (!authed(url, req)) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  if (path === "/api/snapshot") {
    const snap = latest || (await snapshot());
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(snap));
  }

  if (path === "/api/log") {
    const n = Math.min(2000, Number(url.searchParams.get("tail") || LOG_VIEW_LINES));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ lines: tailLines(LOG_FILE, n), file: LOG_FILE }));
  }

  if (path === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    if (latest) res.write(`data: ${JSON.stringify(latest)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

function listen(port, attempts = 10) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      // Another dashboard already owns the port. Stepping up rather than failing
      // matches the fleet daemon and keeps a second launch harmless.
      if (err.code === "EADDRINUSE" && attempts > 0) {
        server.removeListener("error", onErr);
        return resolve(listen(port + 1, attempts - 1));
      }
      reject(err);
    };
    server.once("error", onErr);
    server.listen(port, HOST, () => {
      server.removeListener("error", onErr);
      resolve(port);
    });
  });
}

const port = await listen(DEFAULT_PORT);
const urlStr = `http://${HOST}:${port}/`;

try {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(INFO_FILE, JSON.stringify({ port, pid: process.pid, url: urlStr }, null, 2));
} catch { /* discovery file is a convenience, not a requirement */ }

latest = await snapshot();
await probeBoard(latest.board);
await probeBoardUi(latest.board);

setInterval(async () => {
  try {
    latest = await snapshot();
    broadcast(latest);
  } catch { /* a bad tick must never kill the server */ }
}, TICK_MS);

setInterval(async () => {
  try {
    if (latest?.board) { await probeBoard(latest.board); await probeBoardUi(latest.board); }
  } catch { /* probe failures are a state, not an error */ }
}, BOARD_PROBE_MS);

console.log(`ak-worker dashboard on ${urlStr} (pid ${process.pid})`);

if (OPEN && process.platform === "win32") {
  execFile("cmd", ["/c", "start", "", `${urlStr}?token=${TOKEN}`], () => {});
}
