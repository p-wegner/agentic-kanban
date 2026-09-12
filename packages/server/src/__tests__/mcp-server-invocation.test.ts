// @covers agent-providers.mcp.bundledInvocation [config]
//
// Bundled-install MCP wiring. `resolveMcpServerInvocation` (services/agent-provider/helpers.ts)
// decides how spawned agents (and the butler) reach the agentic-kanban MCP server. In a
// bundled install (published npm package, Docker image) only the compiled `dist/mcp.js`
// exists — the old hardcoded `mcp-server/src/index.ts` + tsx invocation pointed at source
// paths that are NOT shipped, so every bundled agent silently lost its kanban MCP tools.
// helpers.ts is inlined into BOTH `dist/server.js` (mcp.js is a sibling) and
// `dist/cli/index.js` (mcp.js is one level up), so both locations must be probed.

import { describe, it, expect, vi } from "vitest";
import { getMcpConfigPath, resolveMcpServerInvocation } from "../services/agent-provider/helpers.js";
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

/** An in-memory FileSystem fake that actually persists writes, for round-trip tests. */
function inMemoryFs(initialFiles: Record<string, string> = {}): FileSystem & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initialFiles };
  return {
    files,
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    writeFileSync: (p: string, data: string) => {
      files[p] = data;
    },
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

  it("still returns the source invocation when nothing exists (providers embed it unconditionally), warning loudly", () => {
    // Pre-fix behavior preserved: an injected/fake FS with no matches (unit tests,
    // broken installs) must not throw — the Copilot provider embeds this config
    // without probing, and a throw would silently strip its --additional-mcp-config.
    const invocation = resolveMcpServerInvocation(fsWith());
    expect(invocation.command).toBe("node");
    expect(invocation.args[0]).toBe("--import");
  });
});

describe("getMcpConfigPath — self-healing against a poisoned shared config (#1106)", () => {
  it("writes a fresh config when none exists yet", () => {
    const fs = inMemoryFs();
    const path = getMcpConfigPath(fs);
    expect(fs.files[path]).toBeDefined();
    const written = JSON.parse(fs.files[path]);
    expect(written.mcpServers["agentic-kanban"].command).toBe("node");
  });

  it("does not rewrite when the existing content already matches (idempotent)", () => {
    const fs = inMemoryFs();
    const path = getMcpConfigPath(fs);
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    getMcpConfigPath(fs);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("repairs a config whose CONTENT was written by a different install, not just a missing file", () => {
    // Reproduces #1106: another process on this box (a different checkout's test run, a
    // throwaway base-health-probe clone) wrote this same machine-global path with an
    // invocation pointing at ITS OWN (now-deleted) directory. The old check only asked
    // `existsSync(path)` — true here — so it trusted the poisoned content forever.
    const path = getMcpConfigPath(inMemoryFs()); // discover the real shared path
    const poisoned = JSON.stringify({
      mcpServers: {
        "agentic-kanban": {
          command: "node",
          args: ["C:\\tmp\\kanban-base-health-master-yaOcfA\\repo\\packages\\mcp-server\\dist\\mcp.js"],
        },
      },
    }, null, 2);
    const fs = inMemoryFs({ [path]: poisoned });

    const healedPath = getMcpConfigPath(fs);

    expect(healedPath).toBe(path);
    const healed = JSON.parse(fs.files[path]);
    expect(healed.mcpServers["agentic-kanban"].args.join(" ")).not.toContain("kanban-base-health-master-yaOcfA");
  });

  it("repairs a config file that exists but cannot be read", () => {
    const path = getMcpConfigPath(inMemoryFs());
    const fs = inMemoryFs({ [path]: "irrelevant" });
    fs.readFileSync = () => {
      throw new Error("EACCES: permission denied");
    };

    expect(() => getMcpConfigPath(fs)).not.toThrow();
    const repaired = JSON.parse(fs.files[path]);
    expect(repaired.mcpServers["agentic-kanban"].command).toBe("node");
  });
});
