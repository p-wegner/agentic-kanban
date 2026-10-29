import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderName } from "./types.js";

/**
 * Per-provider safety-hook (tool-call guard) wiring (#1758). Exhaustive over `ProviderName`
 * so a provider is either guarded or DECLARED unguarded, never just missing.
 */
export const SAFETY_HOOKS: Record<ProviderName, { guarded: boolean; wiring: string }> = {
  claude: { guarded: true, wiring: ".claude/settings.json PreToolUse/Stop/PostToolUse hooks" },
  codex: { guarded: true, wiring: ".codex/hooks.json PreToolUse + 3 Stop checks (no nested CLAUDE.md disclosure)" },
  pi: { guarded: true, wiring: ".pi/plugin/agentic-kanban-hooks.ts via --extension (PreToolUse only; no Stop checks)" },
  copilot: { guarded: false, wiring: "none: Copilot CLI launch carries no hook wiring" },
  herdr: { guarded: false, wiring: "none: hosts another provider in a pane; guards are that provider's" },
};

export interface LaunchGuardStatus {
  guarded: boolean;
  /** Log/session-visible message when the builder runs without tool-call guards. */
  warning?: string;
}

/** Decide whether a launch has tool-call guards, with the warning to surface when it does not. */
export function resolveLaunchGuardStatus(provider: string, worktreePath: string): LaunchGuardStatus {
  const entry = (SAFETY_HOOKS as Record<string, { guarded: boolean } | undefined>)[provider];
  if (entry && !entry.guarded) {
    return { guarded: false, warning: `${provider}: no tool-call guards on this provider; builder runs unguarded` };
  }
  if (provider === "pi" && !existsSync(join(worktreePath, ".pi", "plugin", "agentic-kanban-hooks.ts"))) {
    return {
      guarded: false,
      warning: `pi: no agentic-kanban-hooks extension in ${worktreePath}; builder runs unguarded`,
    };
  }
  return { guarded: true };
}
