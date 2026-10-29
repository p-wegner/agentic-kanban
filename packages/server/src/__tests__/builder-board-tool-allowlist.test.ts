import { describe, expect, it } from "vitest";
import { BUILDER_BOARD_TOOLS, REMOTE_BOARD_TOOLS, REVIEW_BOARD_TOOLS } from "@agentic-kanban/shared/lib/board-tool-allowlist";
import { REMOTE_BOARD_TOOLS as BRIDGE_TOOLS } from "../services/fleet-mcp-bridge.service.js";
import { codexIsolationConfigArgs } from "../services/agent-provider/builder-context.js";
import { getMcpConfigPath } from "../services/agent-provider/helpers.js";
import fs from "node:fs";
import path from "node:path";

describe("builder board tool allowlist (#1761)", () => {
  it("the bridge and host builders share ONE remote constant", () => {
    expect(BRIDGE_TOOLS).toBe(REMOTE_BOARD_TOOLS);
    for (const t of REMOTE_BOARD_TOOLS) expect(BUILDER_BOARD_TOOLS).toContain(t);
    for (const t of BUILDER_BOARD_TOOLS) expect(REVIEW_BOARD_TOOLS).toContain(t);
  });

  it("keeps the board-owned decisions out of a builder's reach", () => {
    for (const t of ["merge_workspace", "delete_issue", "delete_workspace", "set_preference", "relocate_project", "cleanup_project", "update_workflow_template", "move_issue"]) {
      expect(BUILDER_BOARD_TOOLS).not.toContain(t);
    }
    expect(BUILDER_BOARD_TOOLS).toContain("propose_transition");
  });

  it("Codex gets an enabled_tools override, shell-safe (no double quotes or whitespace)", () => {
    const args = codexIsolationConfigArgs(undefined, BUILDER_BOARD_TOOLS);
    const v = args.find((a) => a.startsWith("mcp_servers.agentic-kanban.enabled_tools="))!;
    expect(v).toContain("'propose_transition'");
    expect(v).not.toMatch(/["\s]/);
    expect(codexIsolationConfigArgs()).not.toContain(v);
  });

  it("Claude's MCP config carries the allowlist in env, and stays unfiltered without one", () => {
    const fsStub = { existsSync: () => true, readFileSync: () => "", writeFileSync: () => {} } as never;
    const filtered = getMcpConfigPath(fsStub, BUILDER_BOARD_TOOLS);
    const open = getMcpConfigPath(fsStub);
    expect(filtered).not.toBe(open);
  });

  it("the builder prompt sources only name allowlisted board tools", () => {
    const root = path.join(import.meta.dirname!, "..", "..", "..", "..");
    for (const rel of ["packages/shared/src/lib/ticket-context.ts", "packages/server/src/services/workspace-provision.service.ts"]) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      for (const m of text.matchAll(/mcp__agentic-kanban__([a-z][a-z_]*)/g)) {
        expect(REVIEW_BOARD_TOOLS, `${rel} names ${m[1]}`).toContain(m[1]);
      }
    }
  });
});
