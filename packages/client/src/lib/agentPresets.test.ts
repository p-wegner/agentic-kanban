import { describe, it, expect } from "vitest";
import {
  agentPresetsKey,
  sanitizeAgentPresets,
  upsertAgentPreset,
  deleteAgentPreset,
  presetProfileToken,
  type AgentPreset,
} from "./agentPresets.js";

const NOW = "2026-06-08T00:00:00.000Z";

function preset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: "ap-1",
    name: "Claude Opus",
    provider: "claude",
    profile: "anth",
    model: "opus",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("agentPresetsKey", () => {
  it("namespaces by project id", () => {
    expect(agentPresetsKey("proj-123")).toBe("agent_presets_proj-123");
  });
});

describe("sanitizeAgentPresets", () => {
  it("returns [] for empty/invalid input", () => {
    expect(sanitizeAgentPresets(undefined)).toEqual([]);
    expect(sanitizeAgentPresets("not json")).toEqual([]);
    expect(sanitizeAgentPresets(JSON.stringify({ not: "array" }))).toEqual([]);
  });

  it("drops entries missing id or name", () => {
    const raw = JSON.stringify([
      { name: "no id", provider: "claude" },
      { id: "x", provider: "claude" },
      preset(),
    ]);
    const result = sanitizeAgentPresets(raw);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Claude Opus");
  });

  it("defaults unknown providers to claude and trims optional fields", () => {
    const raw = JSON.stringify([
      { id: "a", name: "Weird", provider: "bogus", profile: "", model: "  " },
    ]);
    const [p] = sanitizeAgentPresets(raw);
    expect(p.provider).toBe("claude");
    expect(p.profile).toBeUndefined();
    expect(p.model).toBeUndefined();
  });

  it("sorts by name", () => {
    const raw = JSON.stringify([
      preset({ id: "b", name: "Zebra" }),
      preset({ id: "a", name: "Alpha" }),
    ]);
    expect(sanitizeAgentPresets(raw).map((p) => p.name)).toEqual(["Alpha", "Zebra"]);
  });
});

describe("upsertAgentPreset", () => {
  it("adds a new preset", () => {
    const next = upsertAgentPreset([], "Codex Fast", { provider: "codex", profile: "default", model: "gpt-5.5" }, NOW);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ name: "Codex Fast", provider: "codex", profile: "default", model: "gpt-5.5" });
  });

  it("updates an existing preset by name (case-insensitive), keeping id + createdAt", () => {
    const existing = [preset({ id: "ap-keep", name: "Claude Opus", createdAt: "2020-01-01T00:00:00.000Z" })];
    const next = upsertAgentPreset(existing, "claude opus", { provider: "claude", profile: "anth", model: "sonnet" }, NOW);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("ap-keep");
    expect(next[0].createdAt).toBe("2020-01-01T00:00:00.000Z");
    expect(next[0].updatedAt).toBe(NOW);
    expect(next[0].model).toBe("sonnet");
  });

  it("ignores blank names and drops empty profile/model to undefined", () => {
    expect(upsertAgentPreset([], "   ", { provider: "claude" }, NOW)).toEqual([]);
    const [p] = upsertAgentPreset([], "Bare", { provider: "claude", profile: "", model: "" }, NOW);
    expect(p.profile).toBeUndefined();
    expect(p.model).toBeUndefined();
  });
});

describe("deleteAgentPreset", () => {
  it("removes the preset with the given id", () => {
    const presets = [preset({ id: "a" }), preset({ id: "b" })];
    expect(deleteAgentPreset(presets, "a").map((p) => p.id)).toEqual(["b"]);
  });
});

describe("presetProfileToken", () => {
  it("claude with profile -> claude:<name>", () => {
    expect(presetProfileToken(preset({ provider: "claude", profile: "anth" }))).toBe("claude:anth");
  });
  it("claude without profile -> empty (server default)", () => {
    expect(presetProfileToken(preset({ provider: "claude", profile: undefined }))).toBe("");
  });
  it("codex/copilot fall back to default profile name", () => {
    expect(presetProfileToken(preset({ provider: "codex", profile: undefined }))).toBe("codex:default");
    expect(presetProfileToken(preset({ provider: "copilot", profile: undefined }))).toBe("copilot:default");
  });
});
