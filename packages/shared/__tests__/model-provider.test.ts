import { describe, expect, it } from "vitest";
import { modelBelongsToProvider } from "../src/types/api.js";

describe("modelBelongsToProvider", () => {
  // The bug (#696): a leftover Codex model id (e.g. gpt-5.5) in the provider-agnostic
  // `default_model` pref survives a switch to Claude and is passed as `--model gpt-5.5`
  // to claude.exe, killing every Claude launch. This guard must reject the mismatch.
  it("rejects a codex model id for the claude provider", () => {
    expect(modelBelongsToProvider("gpt-5.5", "claude")).toBe(false);
    expect(modelBelongsToProvider("gpt-5.3-codex", "claude")).toBe(false);
    expect(modelBelongsToProvider("GPT-5.5", "claude")).toBe(false);
  });

  it("rejects a claude model id for the codex provider", () => {
    expect(modelBelongsToProvider("opus", "codex")).toBe(false);
    expect(modelBelongsToProvider("sonnet", "codex")).toBe(false);
    expect(modelBelongsToProvider("claude-opus-4-8", "codex")).toBe(false);
  });

  it("accepts a matching claude model id", () => {
    expect(modelBelongsToProvider("opus", "claude")).toBe(true);
    expect(modelBelongsToProvider("sonnet", "claude")).toBe(true);
    expect(modelBelongsToProvider("haiku", "claude")).toBe(true);
    expect(modelBelongsToProvider("claude-opus-4-8", "claude")).toBe(true);
  });

  it("accepts a matching codex model id", () => {
    expect(modelBelongsToProvider("gpt-5.5", "codex")).toBe(true);
    expect(modelBelongsToProvider("gpt-5.3-codex-spark", "codex")).toBe(true);
  });

  it("passes through empty/undefined (use provider default, never strip nothing)", () => {
    expect(modelBelongsToProvider("", "claude")).toBe(true);
    expect(modelBelongsToProvider(undefined, "claude")).toBe(true);
    expect(modelBelongsToProvider(null, "codex")).toBe(true);
    expect(modelBelongsToProvider("   ", "claude")).toBe(true);
  });

  it("passes through unknown/custom ids (don't strip what we don't recognize)", () => {
    expect(modelBelongsToProvider("glm-4.6", "claude")).toBe(true);
    expect(modelBelongsToProvider("some-custom-model", "codex")).toBe(true);
  });

  it("never strips for copilot (no model flag)", () => {
    expect(modelBelongsToProvider("gpt-5.5", "copilot")).toBe(true);
    expect(modelBelongsToProvider("opus", "copilot")).toBe(true);
  });

  it("never strips for pi because profiles select the concrete upstream provider", () => {
    expect(modelBelongsToProvider("gpt-5.5", "pi")).toBe(true);
    expect(modelBelongsToProvider("claude-sonnet-4-6", "pi")).toBe(true);
    expect(modelBelongsToProvider("custom-pi-model", "pi")).toBe(true);
  });
});
