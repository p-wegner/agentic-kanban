import { describe, expect, it } from "vitest";
import type { workspaces } from "@agentic-kanban/shared/schema";
import { applyWorkspaceAgentSelection } from "../services/workspace-internals.js";
import type { AgentSettings } from "../services/agent-settings.service.js";

/**
 * `applyWorkspaceAgentSelection` used to overwrite the resolved profile with the workspace
 * row's own `claudeProfile` unconditionally. Since nothing normally pins a profile on the
 * record, that null erased the board's configured default, `profile` became undefined, and
 * `resolveProviderRotation` (which keys off `profile`) never set CLAUDE_CONFIG_DIR — so the
 * agent silently ran under whatever subscription the SERVER process had inherited.
 *
 * Measured: with `claude_profile` set to a profile that had quota, a relaunched builder still
 * ran under a different, exhausted one, and the setting appeared to do nothing.
 */
function settings(over: Partial<AgentSettings> = {}): AgentSettings {
  return {
    agentCommand: undefined,
    agentArgs: undefined,
    profile: { provider: "claude", name: "board_default" },
    provider: "claude",
    resumeWithNewModel: false,
    permissionPromptTool: undefined,
    ...over,
  } as AgentSettings;
}

function workspace(over: Partial<typeof workspaces.$inferSelect> = {}): typeof workspaces.$inferSelect {
  return {
    provider: "claude",
    claudeProfile: null,
    agentArgs: null,
    ...over,
  } as unknown as typeof workspaces.$inferSelect;
}

describe("applyWorkspaceAgentSelection — board default profile", () => {
  it("inherits the board's default profile when the workspace pins none", () => {
    const out = applyWorkspaceAgentSelection(settings(), workspace({ claudeProfile: null }));

    expect(out.profile).toEqual({ provider: "claude", name: "board_default" });
  });

  it("still lets a profile pinned on the workspace win over the board default", () => {
    const out = applyWorkspaceAgentSelection(settings(), workspace({ claudeProfile: "pinned_one" }));

    expect(out.profile).toEqual({ provider: "claude", name: "pinned_one" });
  });

  it("does not leak a claude profile into a different provider's launch", () => {
    // The workspace is codex but the resolved default is a claude profile — inheriting it
    // would hand `--profile board_default` to a CLI that has no such profile.
    const out = applyWorkspaceAgentSelection(settings(), workspace({ provider: "codex", claudeProfile: null }));

    expect(out.provider).toBe("codex");
    expect(out.profile).toBeUndefined();
  });

  it("leaves a non-agent provider's settings untouched", () => {
    const input = settings();
    const out = applyWorkspaceAgentSelection(input, workspace({ provider: "unknown-provider" }));

    expect(out).toBe(input);
  });

  // #1048: the row pin is absolute for a REASON (#762 — erasing it once disabled OAuth
  // selection entirely), so a cooling pin must fall through to the board default rather
  // than being dropped outright. Without this a default relaunch (monitor auto-relaunch,
  // the UI button, `workspace resume` with no flag) launches straight back into the same
  // exhausted account it just failed on.
  describe("a pinned profile the roster reports as cooling", () => {
    const nowMs = Date.parse("2026-09-06T00:00:00.000Z");

    it("falls through to the board default instead of relaunching on the cooling pin", () => {
      const prefMap = new Map([["claude_cooldown_pinned_one", "2026-09-06T01:00:00.000Z"]]);
      const out = applyWorkspaceAgentSelection(settings(), workspace({ claudeProfile: "pinned_one" }), prefMap, nowMs);

      expect(out.profile).toEqual({ provider: "claude", name: "board_default" });
    });

    it("still honors the pin once its cooldown has elapsed", () => {
      const prefMap = new Map([["claude_cooldown_pinned_one", "2026-09-05T23:00:00.000Z"]]);
      const out = applyWorkspaceAgentSelection(settings(), workspace({ claudeProfile: "pinned_one" }), prefMap, nowMs);

      expect(out.profile).toEqual({ provider: "claude", name: "pinned_one" });
    });

    it("still honors the pin when no prefMap is supplied at all (back-compat)", () => {
      const out = applyWorkspaceAgentSelection(settings(), workspace({ claudeProfile: "pinned_one" }));

      expect(out.profile).toEqual({ provider: "claude", name: "pinned_one" });
    });
  });
});
