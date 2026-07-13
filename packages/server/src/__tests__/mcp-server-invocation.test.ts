// @covers agent-providers.mcp.bundledInvocation [config]
//
// Bundled-install MCP wiring. `resolveMcpServerInvocation` (services/agent-provider/helpers.ts)
// decides how spawned agents (and the butler) reach the agentic-kanban MCP server. In a
// bundled install (published npm package, Docker image) only the compiled `dist/mcp.js`
// exists — the old hardcoded `mcp-server/src/index.ts` + tsx invocation pointed at source
// paths that are NOT shipped, so every bundled agent silently lost its kanban MCP tools.
// helpers.ts is inlined into BOTH `dist/server.js` (mcp.js is a sibling) and
// `dist/cli/index.js` (mcp.js is one level up), so both locations must be probed.

import { describe, it, expect } from "vitest";
import { resolveMcpServerInvocation } from "../services/agent-provider/helpers.js";
import type { FileSystem } from "../services/agent-provider/types.js";

/** A FileSystem fake where exactly the given path suffixes exist. */
function fsWith(...existingSuffixes: string[]): FileSystem {
  const normalize = (p: string) => p.replace(/\\/g, "/");
  return {
    existsSync: (p: string) => existingSuffixes.some((s) => normalize(p).endsWith(normalize(s))),
    readFileSync: () => {
      throw new Error("not used");
    },
    writeFileSync: () => undefined,
  };
}

describe("resolveMcpServerInvocation — bundled vs dev checkout", () => {
  it("prefers a sibling mcp.js (dist/server.js layout): plain node, no tsx", () => {
    const invocation = resolveMcpServerInvocation(fsWith("agent-provider/mcp.js"));
    expect(invocation.command).toBe("node");
    expect(invocation.args).toHaveLength(1);
    expect(invocation.args[0].replace(/\\/g, "/")).toMatch(/mcp\.js$/);
    expect(invocation.args.join(" ")).not.toContain("tsx");
  });

  it("falls back to ../mcp.js (dist/cli/index.js layout)", () => {
    const invocation = resolveMcpServerInvocation(fsWith("services/mcp.js"));
    expect(invocation.command).toBe("node");
    expect(invocation.args).toHaveLength(1);
    expect(invocation.args[0].replace(/\\/g, "/")).toMatch(/mcp\.js$/);
  });

  it("uses tsx + the TypeScript source in a dev checkout (no bundled mcp.js)", () => {
    const invocation = resolveMcpServerInvocation(fsWith("mcp-server/src/index.ts"));
    expect(invocation.command).toBe("node");
    expect(invocation.args[0]).toBe("--import");
    expect(invocation.args[2].replace(/\\/g, "/")).toMatch(/mcp-server\/src\/index\.ts$/);
  });

  it("fails loudly, naming all probed paths, when neither bundle nor source exists", () => {
    expect(() => resolveMcpServerInvocation(fsWith())).toThrow(/MCP server not found.*mcp\.js/s);
  });
});
