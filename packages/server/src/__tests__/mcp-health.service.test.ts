import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeMcpHealth, type McpServerProbeConfig } from "../services/mcp-health.service.js";

function tempScript(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-mcp-health-"));
  const path = join(dir, `${name}.cjs`);
  writeFileSync(path, content, "utf8");
  return path;
}

// A probe budget has to cover a real `node` cold start, and this box runs several agents plus
// the merge gate at once — 1000ms was routinely lost to process spawn, so BOTH happy paths
// reported `timeout` instead of what they assert (measured: the ok-probe on one run, the
// malformed-output probe on the next). The budget is generous on purpose: nothing here asserts
// speed, and every probe that reaches its assertion resolves as soon as the child writes, so a
// green run does not pay it.
const PROBE_TIMEOUT_MS = 15_000;

function configFor(script: string): McpServerProbeConfig {
  return {
    name: "agentic-kanban",
    command: process.execPath,
    args: [script],
    cwd: process.cwd(),
  };
}

describe("MCP health service", () => {
  it("maps a successful tools/list probe to an ok status and tool count", { timeout: 30_000 }, async () => {
    const script = tempScript("healthy", `
function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (true) {
    const lineEnd = buffer.indexOf("\\n");
    if (lineEnd === -1) return;
    const line = buffer.slice(0, lineEnd).trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    }
    if (message.id === 2) {
      send({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "list_issues" }, { name: "get_board_status" }] } });
    }
  }
});
setInterval(() => {}, 1000);
`);

    const result = await probeMcpHealth(configFor(script), { timeoutMs: PROBE_TIMEOUT_MS });

    expect(result.lastProbe).toMatchObject({
      ok: true,
      status: "ok",
      toolCount: 2,
      error: null,
    });
    expect(result.server.command).toBe(process.execPath.split(/[\\/]/).pop());
  });

  it("maps an unresponsive MCP process to timeout", async () => {
    const script = tempScript("timeout", `setInterval(() => {}, 1000);`);

    const result = await probeMcpHealth(configFor(script), { timeoutMs: 50 });

    expect(result.lastProbe?.ok).toBe(false);
    expect(result.lastProbe?.error?.code).toBe("timeout");
  });

  it("maps malformed stdio output to malformed_json_rpc", { timeout: 30_000 }, async () => {
    const script = tempScript("malformed", `
process.stdout.write("this is not framed json-rpc");
setInterval(() => {}, 1000);
`);

    const result = await probeMcpHealth(configFor(script), { timeoutMs: PROBE_TIMEOUT_MS });

    expect(result.lastProbe?.ok).toBe(false);
    expect(result.lastProbe?.error?.code).toBe("malformed_json_rpc");
  });
});
