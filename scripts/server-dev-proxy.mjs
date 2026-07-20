
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { resolvePnpmInvocation } from "./pnpm-exec.mjs";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_PUBLIC_PORT = 3001;
const DEFAULT_HOST = "127.0.0.1";

function parsePort(value) {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function resolvePublicServerPort(env = process.env) {
  return (
    parsePort(env.KANBAN_WORKTREE_SERVER_PORT) ??
    parsePort(env.KANBAN_SERVER_PORT) ??
    parsePort(env.SERVER_PORT) ??
    parsePort(env.PORT) ??
    DEFAULT_PUBLIC_PORT
  );
}

export function preferredInternalPort(publicPort) {
  if (publicPort <= 55535) return publicPort + 10000;
  if (publicPort > 10000) return publicPort - 10000;
  return publicPort + 20000;
}

export function buildBackendEnv(env, publicPort, internalPort) {
  const publicPortString = String(publicPort);
  const backendEnv = {
    ...env,
    KANBAN_INTERNAL_SERVER_PORT: String(internalPort),
    KANBAN_WORKTREE_SERVER_PORT: publicPortString,
    KANBAN_SERVER_PORT: publicPortString,
    SERVER_PORT: publicPortString,
    PORT: publicPortString,
  };
  if (!backendEnv.KANBAN_BOARD_SERVER_PORT) {
    backendEnv.KANBAN_BOARD_SERVER_PORT = backendEnv.KANBAN_SERVER_PORT;
  }
  return backendEnv;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Sentinel rejection meaning "the client hung up" — distinct from a backend
// failure, so proxyWithRetry knows not to retry or write an error response.
const CLIENT_GONE = Symbol("client-gone");

// One 'error'/'close' pair per RESPONSE, not per proxy attempt. proxyWithRetry
// can call proxyOnce ~retryTimeoutMs/retryDelayMs times (≈100 with the defaults)
// while the backend is restarting, so registering these inside proxyOnce leaked
// two listeners per attempt onto the same `res` — MaxListenersExceededWarning
// plus retained handles on every request that hit a backend restart window.
// Keeping them here also means `res` is never momentarily without an 'error'
// listener, which is the exact gap that crashed this process (#117).
function watchClient(res) {
  const state = { gone: false, onGone: null };
  const markGone = () => {
    if (state.gone) return;
    state.gone = true;
    const handler = state.onGone;
    state.onGone = null;
    handler?.();
  };
  res.on("error", markGone);
  res.on("close", () => {
    if (res.writableFinished) return;
    markGone();
  });
  return state;
}

function proxyOnce(req, res, body, opts, client) {
  return new Promise((resolveProxy, rejectProxy) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (client.onGone === onClientGone) client.onGone = null;
      fn(value);
    };

    // The client aborting mid-response is routine under load (page reloads, a
    // vite restart, a burst of board events). Writing to that dead socket fails
    // with ECONNABORTED/EPIPE; unhandled, it crashes the dev proxy and takes the
    // backend it supervises down with it (#117). Stop the backend leg too, so a
    // burst of aborts cannot leak sockets or hang this promise forever.
    function onClientGone() {
      backendReq.destroy();
      finish(rejectProxy, CLIENT_GONE);
    }

    if (client.gone) {
      finish(rejectProxy, CLIENT_GONE);
      return;
    }
    client.onGone = onClientGone;

    const headers = { ...req.headers, host: `${opts.backendHost}:${opts.backendPort}`, connection: "close" };
    const backendReq = httpRequest(
      {
        hostname: opts.backendHost,
        port: opts.backendPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (backendRes) => {
        res.writeHead(backendRes.statusCode ?? 502, backendRes.statusMessage, backendRes.headers);
        // Without this listener a mid-response read failure is an unhandled
        // stream error, i.e. an uncaught exception that kills this process.
        backendRes.on("error", () => {
          res.destroy();
          finish(rejectProxy, CLIENT_GONE);
        });
        backendRes.pipe(res);
        backendRes.on("end", () => finish(resolveProxy));
      },
    );

    backendReq.on("error", (err) => finish(rejectProxy, err));
    backendReq.end(body);
  });
}

async function proxyWithRetry(req, res, body, opts, client) {
  const deadline = Date.now() + opts.retryTimeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      await proxyOnce(req, res, body, opts, client);
      return;
    } catch (err) {
      // Nobody is waiting for this response any more — retrying would only burn
      // backend connections during exactly the bursts that trigger the aborts.
      if (err === CLIENT_GONE) return;
      lastError = err;
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      await wait(opts.retryDelayMs);
    }
  }

  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "backend unavailable");
  res.writeHead(503, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "dev_server_backend_unavailable", message }));
}

// Mirrors watchClient() for a raw upgrade socket: one 'error'/'close' pair for
// the lifetime of the client connection, not one per retry attempt (retrying
// would otherwise leak a listener pair onto `socket` per attempt, same trap as
// #117 fixed for the HTTP leg above).
function watchSocket(socket) {
  const state = { gone: false, onGone: null };
  const markGone = () => {
    if (state.gone) return;
    state.gone = true;
    const handler = state.onGone;
    state.onGone = null;
    handler?.();
  };
  socket.on("error", markGone);
  socket.on("close", markGone);
  return state;
}

function proxyUpgradeOnce(req, socket, head, opts, client) {
  return new Promise((resolveUpgrade, rejectUpgrade) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (client.onGone === onClientGone) client.onGone = null;
      fn(value);
    };

    function onClientGone() {
      backendSocket.destroy();
      finish(rejectUpgrade, CLIENT_GONE);
    }

    if (client.gone) {
      finish(rejectUpgrade, CLIENT_GONE);
      return;
    }
    client.onGone = onClientGone;

    const backendSocket = netConnect(opts.backendPort, opts.backendHost);

    backendSocket.on("connect", () => {
      backendSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const value = req.rawHeaders[i + 1];
        if (name.toLowerCase() === "host") {
          backendSocket.write(`Host: ${opts.backendHost}:${opts.backendPort}\r\n`);
        } else {
          backendSocket.write(`${name}: ${value}\r\n`);
        }
      }
      backendSocket.write("\r\n");
      if (head.length > 0) backendSocket.write(head);
      socket.pipe(backendSocket);
      backendSocket.pipe(socket);
      // Once the pipe is up, `finish` above is a one-shot settled promise and
      // stops reacting to further events — without these, a backend restart or
      // client disconnect mid-session (not just mid-upgrade) leaked the other
      // side of the pipe forever instead of tearing it down.
      socket.on("error", () => backendSocket.destroy());
      backendSocket.on("error", () => socket.destroy());
      finish(resolveUpgrade);
    });
    backendSocket.on("error", (err) => finish(rejectUpgrade, err));
  });
}

// A WS upgrade caught mid tsx-watch restart (e.g. a self-hosted auto-merge that
// touches watched server/shared source — #144) used to fail instantly with a 503
// instead of riding out the restart window like the HTTP leg does. Retrying here
// the same way proxyWithRetry does for HTTP means a board-event/session-stream
// socket opened during the ~restart window waits for the backend to come back
// instead of dying immediately and flooding reconnect/error noise.
async function proxyUpgradeWithRetry(req, socket, head, opts, client) {
  const deadline = Date.now() + opts.retryTimeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      await proxyUpgradeOnce(req, socket, head, opts, client);
      return;
    } catch (err) {
      if (err === CLIENT_GONE) return;
      lastError = err;
      if (socket.destroyed) return;
      await wait(opts.retryDelayMs);
    }
  }

  if (socket.destroyed) return;
  try {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
  } catch {
    // client socket already gone — nothing to respond to
  }
  socket.destroy();
}

export function createStableDevProxy(options) {
  const opts = {
    publicHost: options.publicHost ?? DEFAULT_HOST,
    backendHost: options.backendHost ?? DEFAULT_HOST,
    publicPort: options.publicPort,
    backendPort: options.backendPort,
    retryTimeoutMs: options.retryTimeoutMs ?? 10_000,
    retryDelayMs: options.retryDelayMs ?? 100,
  };

  const server = createHttpServer(async (req, res) => {
    // Install before reading the body: a client that aborts mid-upload must not
    // leave `res` without an 'error' listener either.
    const client = watchClient(res);
    try {
      const body = await readRequestBody(req);
      await proxyWithRetry(req, res, body, opts, client);
    } catch (err) {
      if (client.gone || res.destroyed || res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "dev_server_proxy_error", message: err instanceof Error ? err.message : String(err) }));
    }
  });
  server.on("upgrade", (req, socket, head) => {
    const client = watchSocket(socket);
    proxyUpgradeWithRetry(req, socket, head, opts, client).catch(() => {
      if (!socket.destroyed) socket.destroy();
    });
  });
  // Malformed/aborted requests must not become uncaught errors on the server.
  server.on("clientError", (_err, socket) => {
    if (!socket.destroyed) socket.destroy();
  });
  return server;
}

export function listen(server, port, host = DEFAULT_HOST) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

async function canListen(port, host) {
  const probe = createNetServer();
  try {
    await listen(probe, port, host);
    return true;
  } catch {
    return false;
  } finally {
    if (probe.listening) {
      await new Promise((resolveClose) => probe.close(resolveClose));
    }
  }
}

export async function findAvailableInternalPort(preferredPort, host = DEFAULT_HOST) {
  for (let port = preferredPort; port <= Math.min(preferredPort + 100, 65535); port += 1) {
    if (await canListen(port, host)) return port;
  }
  for (let port = Math.max(preferredPort - 100, 1); port < preferredPort; port += 1) {
    if (await canListen(port, host)) return port;
  }
  throw new Error(`No available internal dev-server port near ${preferredPort}`);
}

function resolveServerPackageDir() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, "../packages/server");
}

function resolveTsxEntry(serverDir) {
  const candidates = [
    resolve(serverDir, "node_modules/tsx/dist/cli.mjs"),
    resolve(serverDir, "../../node_modules/tsx/dist/cli.mjs"),
  ];
  return candidates.find((p) => existsSync(p));
}

export function spawnWatchedBackend({ serverDir, publicPort, internalPort, env = process.env }) {
  const tsxArgs = ["watch", "--conditions", "development", "src/index.ts"];
  // Invoke tsx's JS entry through the current Node binary — no PATH/shim lookup,
  // so this works regardless of how (or whether) pnpm is on PATH. Fall back to
  // pnpm exec only if the local install is missing.
  const tsxEntry = resolveTsxEntry(serverDir);
  const inv = tsxEntry
    ? { cmd: process.execPath, args: [tsxEntry, ...tsxArgs], shell: false }
    : resolvePnpmInvocation(["exec", "tsx", ...tsxArgs]);
  return spawn(inv.cmd, inv.args, {
    cwd: serverDir,
    env: buildBackendEnv(env, publicPort, internalPort),
    stdio: "inherit",
    shell: inv.shell,
    windowsHide: true,
  });
}

// Socket-level errnos that mean "the peer went away". These are expected during
// a burst and must never be fatal here: this process supervises the backend, so
// dying on one takes the API down with it (#117).
const SURVIVABLE_SOCKET_ERRNOS = new Set(["ECONNABORTED", "ECONNRESET", "EPIPE", "ERR_STREAM_DESTROYED"]);

export function installSocketErrorGuard(proc = process) {
  proc.on("uncaughtException", (err) => {
    if (err && SURVIVABLE_SOCKET_ERRNOS.has(err.code)) {
      console.warn(`[dev-proxy] ignoring transient socket error: ${err.code}`);
      return;
    }
    // Anything else is a real bug — preserve the default crash behaviour.
    throw err;
  });
}

async function main() {
  installSocketErrorGuard();
  const publicPort = resolvePublicServerPort();
  const publicHost = process.env.KANBAN_HOST || DEFAULT_HOST;
  const backendHost = publicHost === "0.0.0.0" ? DEFAULT_HOST : publicHost;
  const internalPort = await findAvailableInternalPort(preferredInternalPort(publicPort), publicHost);
  const serverDir = resolveServerPackageDir();

  const proxy = createStableDevProxy({ publicPort, publicHost, backendPort: internalPort, backendHost });
  await listen(proxy, publicPort, publicHost);
  console.log(`[dev-proxy] API proxy listening at http://${publicHost}:${publicPort} -> ${internalPort}`);

  const backend = spawnWatchedBackend({ serverDir, publicPort, internalPort });
  let shuttingDown = false;

  function shutdown() {
    shuttingDown = true;
    backend.kill();
    proxy.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }

  backend.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const exitCode = code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
    proxy.close(() => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 1000).unref();
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
