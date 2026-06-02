import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CapabilityMatrixTable,
  CAPABILITY_DEFS,
  getProviderCapabilities,
} from "./SettingsPanel.js";

describe("getProviderCapabilities", () => {
  it("returns all capabilities supported for claude", () => {
    const caps = getProviderCapabilities("claude", "default", ["--permission-prompt-tool", "mcp__kanban__permission_prompt"]);
    expect(caps.planMode).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.mcpTools).toBe(true);
    expect(caps.visualVerify).toBe(true);
    expect(caps.permissionPrompts).toBe(true);
  });

  it("reports permissionPrompts false for claude without the flag", () => {
    const caps = getProviderCapabilities("claude", "default", []);
    expect(caps.permissionPrompts).toBe(false);
  });

  it("returns capabilities for codex", () => {
    const caps = getProviderCapabilities("codex", "default", []);
    expect(caps.planMode).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.mcpTools).toBe(true);
    expect(caps.visualVerify).toBe(true);
    expect(caps.permissionPrompts).toBe(false);
  });

  it("returns capabilities for copilot", () => {
    const caps = getProviderCapabilities("copilot", "default", []);
    expect(caps.planMode).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.mcpTools).toBe(true);
    expect(caps.visualVerify).toBe(true);
    expect(caps.permissionPrompts).toBe(false);
  });

  it("returns capabilities for mock profile", () => {
    const caps = getProviderCapabilities("claude", "mock", []);
    expect(caps.planMode).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.mcpTools).toBe(true);
    expect(caps.visualVerify).toBe(true);
    expect(caps.permissionPrompts).toBe(false);
  });
});

describe("CapabilityMatrixTable", () => {
  it("renders capability rows for claude with permission prompt tool", () => {
    const html = renderToStaticMarkup(
      <CapabilityMatrixTable
        provider="claude"
        profileName="default"
        flags={["--permission-prompt-tool", "mcp__kanban__permission_prompt"]}
      />,
    );
    expect(html).toContain("data-testid=\"capability-matrix\"");
    for (const def of CAPABILITY_DEFS) {
      expect(html).toContain(def.label);
    }
    // All capabilities supported — should have checkmarks, no dashes
    expect(html).toContain("✓");
    expect(html).not.toContain("–");
  });

  it("renders capability rows for codex", () => {
    const html = renderToStaticMarkup(
      <CapabilityMatrixTable provider="codex" profileName="default" flags={[]} />,
    );
    expect(html).toContain("data-testid=\"capability-matrix\"");
    expect(html).toContain("Plan mode");
    expect(html).toContain("Resume");
    expect(html).toContain("MCP tools");
  });

  it("renders capability rows for copilot", () => {
    const html = renderToStaticMarkup(
      <CapabilityMatrixTable provider="copilot" profileName="default" flags={[]} />,
    );
    expect(html).toContain("data-testid=\"capability-matrix\"");
    expect(html).toContain("Visual verify");
    expect(html).toContain("Permission prompts");
  });

  it("renders capability rows for mock profile", () => {
    const html = renderToStaticMarkup(
      <CapabilityMatrixTable provider="claude" profileName="mock" flags={[]} />,
    );
    expect(html).toContain("data-testid=\"capability-matrix\"");
    expect(html).toContain("Plan mode");
  });

  it("shows dash for unsupported permissions capability without flag", () => {
    const html = renderToStaticMarkup(
      <CapabilityMatrixTable provider="claude" profileName="default" flags={[]} />,
    );
    // permissionPrompts not supported without the flag
    expect(html).toContain("–");
  });
});
