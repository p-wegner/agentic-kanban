import { existsSync } from "node:fs";
import { basename } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getMcpServersConfig } from "./agent-provider/helpers.js";

export type McpProbeStatus = "ok" | "error" | "unknown";

export type McpProbeErrorCode =
  | "missing_binary"
  | "bad_cwd"
  | "timeout"
  | "malformed_json_rpc"
  | "process_error";

export interface McpServerProbeConfig {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpProbeError {
  code: McpProbeErrorCode;
  message: string;
  detail?: string;
}

export interface McpProbeResult {
  ok: boolean;
  status: McpProbeStatus;
  checkedAt: string;
  durationMs: number;
  toolCount: number | null;
  error: McpProbeError | null;
}

export interface McpHealthSummary {
  server: {
    name: string;
    command: string;
    args: string[];
    cwd: string | null;
    path: string | null;
  };
  lastProbe: McpProbeResult | null;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

interface ProbeDeps {
  now?: () => Date;
  spawn?: typeof spawn;
  timeoutMs?: number;
}

let lastProbe: McpProbeResult | null = null;

export function getDefaultMcpProbeConfig(): McpServerProbeConfig {
  const config = getMcpServersConfig()["agentic-kanban"];
  return {
    name: "agentic-kanban",
    command: config.command,
    args: config.args,
    cwd: process.cwd(),
    env: config.env,
  };
}

export function getMcpHealthSummary(config: McpServerProbeConfig = getDefaultMcpProbeConfig()): McpHealthSummary {
  return {
    server: {
      name: config.name,
      command: sanitizeCommand(config.command),
      args: config.args,
      cwd: config.cwd ?? null,
      path: detectServerPath(config.args),
    },
    lastProbe,
  };
}

export async function probeMcpHealth(
  config: McpServerProbeConfig = getDefaultMcpProbeConfig(),
  deps: ProbeDeps = {},
): Promise<McpHealthSummary> {
  const startedAt = Date.now();
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  const timeoutMs = deps.timeoutMs ?? 5000;
  const spawnImpl = deps.spawn ?? spawn;

  if (config.cwd && !existsSync(config.cwd)) {
    lastProbe = buildErrorProbe(checkedAt, startedAt, {
      code: "bad_cwd",
      message: `MCP server working directory does not exist: ${config.cwd}`,
    });
    return getMcpHealthSummary(config);
  }

  try {
    const child = spawnImpl(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: "pipe",
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    lastProbe = await runJsonRpcProbe(child, checkedAt, startedAt, timeoutMs);
  } catch (err) {
    lastProbe = buildErrorProbe(checkedAt, startedAt, mapSpawnException(err));
  }

  return getMcpHealthSummary(config);
}

function runJsonRpcProbe(
  child: ChildProcessWithoutNullStreams,
  checkedAt: string,
  startedAt: number,
  timeoutMs: number,
): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr = "";
    let initialized = false;
    let settled = false;

    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      if (!child.killed) child.kill();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(buildErrorProbe(checkedAt, startedAt, {
        code: "timeout",
        message: `MCP server did not respond to tools/list within ${timeoutMs}ms.`,
        detail: stderr.trim() || undefined,
      }));
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(buildErrorProbe(checkedAt, startedAt, mapSpawnException(err)));
    });

    child.on("exit", (code) => {
      if (settled) return;
      const hasOutput = stdout.length > 0;
      finish(buildErrorProbe(checkedAt, startedAt, hasOutput
        ? {
            code: "malformed_json_rpc",
            message: "MCP server exited before returning a valid tools/list JSON-RPC response.",
            detail: stderr.trim() || undefined,
          }
        : {
            code: "process_error",
            message: `MCP server exited before responding${typeof code === "number" ? ` (exit ${code})` : ""}.`,
            detail: stderr.trim() || undefined,
          }));
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      let parsed: JsonRpcMessage[];
      try {
        const result = parseStdioJsonRpc(stdout);
        stdout = result.remaining;
        parsed = result.messages;
      } catch (err) {
        finish(buildErrorProbe(checkedAt, startedAt, {
          code: "malformed_json_rpc",
          message: "MCP server returned malformed JSON-RPC.",
          detail: err instanceof Error ? err.message : String(err),
        }));
        return;
      }

      for (const message of parsed) {
        if (message.id === 1 && !initialized) {
          if (message.error) {
            finish(buildErrorProbe(checkedAt, startedAt, {
              code: "process_error",
              message: `MCP initialize failed: ${message.error.message ?? "unknown error"}`,
            }));
            return;
          }
          initialized = true;
          writeJsonRpc(child, { jsonrpc: "2.0", method: "notifications/initialized" });
          writeJsonRpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          continue;
        }

        if (message.id === 2) {
          if (message.error) {
            finish(buildErrorProbe(checkedAt, startedAt, {
              code: "process_error",
              message: `MCP tools/list failed: ${message.error.message ?? "unknown error"}`,
            }));
            return;
          }
          const tools = (message.result as { tools?: unknown[] } | undefined)?.tools;
          if (!Array.isArray(tools)) {
            finish(buildErrorProbe(checkedAt, startedAt, {
              code: "malformed_json_rpc",
              message: "MCP tools/list response did not include a tools array.",
            }));
            return;
          }
          finish({
            ok: true,
            status: "ok",
            checkedAt,
            durationMs: Date.now() - startedAt,
            toolCount: tools.length,
            error: null,
          });
        }
      }
    });

    writeJsonRpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentic-kanban-health-probe", version: "0.0.1" },
      },
    });
  });
}

function writeJsonRpc(child: ChildProcessWithoutNullStreams, payload: JsonRpcMessage) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function parseStdioJsonRpc(buffer: Buffer<ArrayBufferLike>): { messages: JsonRpcMessage[]; remaining: Buffer<ArrayBufferLike> } {
  const messages: JsonRpcMessage[] = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    const firstBytes = remaining.toString("utf8", 0, Math.min(32, remaining.length));
    if (!firstBytes.startsWith("Content-Length:")) {
      const lineEnd = remaining.indexOf("\n");
      if (lineEnd === -1) {
        if (remaining.length > 16 && !firstBytes.trimStart().startsWith("{")) {
          throw new Error("Expected newline-delimited JSON-RPC message.");
        }
        break;
      }
      const rawLine = remaining.toString("utf8", 0, lineEnd).replace(/\r$/, "").trim();
      remaining = remaining.subarray(lineEnd + 1);
      if (!rawLine) continue;
      const message = JSON.parse(rawLine) as JsonRpcMessage;
      if (message.jsonrpc !== "2.0") throw new Error("Response is not JSON-RPC 2.0.");
      messages.push(message);
      continue;
    }

    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      break;
    }

    const header = remaining.toString("utf8", 0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error("Missing Content-Length header.");

    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;

    const raw = remaining.toString("utf8", bodyStart, bodyEnd);
    const message = JSON.parse(raw) as JsonRpcMessage;
    if (message.jsonrpc !== "2.0") throw new Error("Response is not JSON-RPC 2.0.");
    messages.push(message);
    remaining = remaining.subarray(bodyEnd);
  }

  return { messages, remaining };
}

function buildErrorProbe(checkedAt: string, startedAt: number, error: McpProbeError): McpProbeResult {
  return {
    ok: false,
    status: "error",
    checkedAt,
    durationMs: Date.now() - startedAt,
    toolCount: null,
    error,
  };
}

function mapSpawnException(err: unknown): McpProbeError {
  const error = err as NodeJS.ErrnoException;
  if (error?.code === "ENOENT") {
    return {
      code: "missing_binary",
      message: "MCP server command could not be found. Check that the binary exists and is on PATH.",
      detail: error.message,
    };
  }
  return {
    code: "process_error",
    message: "MCP server process failed before responding.",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function sanitizeCommand(command: string): string {
  if (command.includes("\\") || command.includes("/")) return basename(command);
  return command;
}

function detectServerPath(args: string[]): string | null {
  return args.find((arg) => /mcp-server[\\/].*index\.(ts|js)$/i.test(arg)) ?? null;
}
