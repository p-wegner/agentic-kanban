
import { spawn } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
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

function proxyOnce(req, res, body, opts) {
  return new Promise((resolveProxy, rejectProxy) => {
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
        backendRes.pipe(res);
        backendRes.on("end", () => resolveProxy());
      },
    );
    backendReq.on("error", rejectProxy);
    backendReq.end(body);
  });
}

async function proxyWithRetry(req, res, body, opts) {
  const deadline = Date.now() + opts.retryTimeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      await proxyOnce(req, res, body, opts);
      return;
    } catch (err) {
      lastError = err;
      if (res.headersSent || res.writableEnded) return;
      await wait(opts.retryDelayMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "backend unavailable");
  res.writeHead(503, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "dev_server_backend_unavailable", message }));
}

function proxyUpgrade(req, socket, head, opts) {
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
  });
  backendSocket.on("error", () => {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
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
    try {
      const body = await readRequestBody(req);
      await proxyWithRetry(req, res, body, opts);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "dev_server_proxy_error", message: err instanceof Error ? err.message : String(err) }));
    }
  });
  server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, opts));
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

export function spawnWatchedBackend({ serverDir, publicPort, internalPort, env = process.env }) {
  return spawn(
    "pnpm",
    ["exec", "tsx", "watch", "--conditions", "development", "src/index.ts"],
    {
      cwd: serverDir,
      env: buildBackendEnv(env, publicPort, internalPort),
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    },
  );
}

async function main() {
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
