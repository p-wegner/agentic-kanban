import { describe, it, expect, vi } from "vitest";
import { ClaudeProvider } from "../services/agent-provider/claude-provider.js";
import {
  parseBuilderContextPolicy,
  builderContextPref,
  BUILDER_CONTEXT_SUPPORT,
} from "../services/agent-provider/builder-context.js";
import { isProjectScopedDynamicKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { PROVIDER_NAMES } from "../services/agent-provider/types.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execSync: vi.fn() }));

const fakeFs = { existsSync: () => false, readFileSync: () => "", writeFileSync: () => {} };

describe("builder context policy (#1302)", () => {
  const provider = new ClaudeProvider(fakeFs);
  const base = { agentCommand: "claude", prompt: "hi" };

  it("isolated adds --setting-sources project,local", () => {
    const { args } = provider.buildLaunchConfig({ ...base, builderContext: "isolated" });
    const i = args.indexOf("--setting-sources");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("project,local");
  });

  it("inherit reproduces today's launch args exactly", () => {
    const today = provider.buildLaunchConfig({ ...base });
    const inherit = provider.buildLaunchConfig({ ...base, builderContext: "inherit" });
    expect(inherit.args).toEqual(today.args);
    expect(inherit.args).not.toContain("--setting-sources");
  });

  it("parses unset and unknown values to the isolated default", () => {
    expect(parseBuilderContextPolicy(undefined)).toBe("isolated");
    expect(parseBuilderContextPolicy("bogus")).toBe("isolated");
    expect(parseBuilderContextPolicy(" Inherit ")).toBe("inherit");
  });

  it("the per-project key is an accepted dynamic preference key", () => {
    const key = builderContextPref.key("0a1b2c3d-0000-4000-8000-000000000001");
    expect(isProjectScopedDynamicKey(key)).toBe(true);
  });

  it("every provider is declared supported or unsupported with a reason", () => {
    for (const name of PROVIDER_NAMES) expect(BUILDER_CONTEXT_SUPPORT[name]).toBeTruthy();
  });
});
