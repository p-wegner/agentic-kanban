import { parseAgentProviderStreamLine } from "@agentic-kanban/shared/lib/agent-stream-parser";
import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "./types.js";
import { resolveCodexDirect, splitArgs, nodeFileSystem } from "./helpers.js";

export class CodexProvider implements AgentProvider {
  readonly name = "codex";
  readonly profilePrefKey = "codex_profile";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, providerSessionId, agentCommand, keepAlive, profile, model, planMode, systemInstructions, oneShotText } = options;
    const isWindows = process.platform === "win32";

    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "codex";
    let useShell = isWindows;

    const args: string[] = [];
    let promptPrefix: string | undefined;

    // One-shot, non-streaming text mode for internal AI utility calls. `codex exec`
    // WITHOUT `--json` prints only the final assistant message to stdout — the plain
    // text these callers parse. The previous claude-cli path sent Claude's
    // `--output-format text`/`-p` flags to `codex`, which it rejects; routing through
    // the codex adapter fixes that.
    if (oneShotText && !isMockAgent) {
      const entry = resolveCodexDirect(command, this.fs);
      if (entry) {
        args.unshift(entry);
        command = process.execPath;
        useShell = false;
      }
      args.push("exec", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust");
      const profileName = profile?.provider === "codex" ? profile.name : undefined;
      if (profileName && profileName !== "default") {
        args.push("--profile", profileName);
      }
      if (model) {
        args.push("--model", model);
      }
      args.push("-");
      return {
        command,
        args,
        useShell,
        isMockAgent: false,
        env: { ...process.env as Record<string, string> },
        keepStdinOpen: false,
      };
    }

    if (isMockAgent) {
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (keepAlive) {
        args.push("--profile", "multi-turn");
      }
    } else {
      const entry = resolveCodexDirect(command, this.fs);
      if (entry) {
        args.unshift(entry);
        command = process.execPath;
        useShell = false;
      }

      const hookTrustFlags = ["--dangerously-bypass-hook-trust"];
      const sandboxFlags = planMode
        ? ["--sandbox", "read-only", ...hookTrustFlags]
        : ["--dangerously-bypass-approvals-and-sandbox", ...hookTrustFlags];
      const profileName = profile?.provider === "codex" ? profile.name : undefined;
      // All `codex exec` options (--json, sandbox, --profile, --model, extra args)
      // MUST precede the `resume` subcommand. `codex exec resume` does not accept
      // --profile/--model and exits with code 2 ("unexpected argument") if they
      // appear after `resume`, so build the exec flags first, then the subcommand.
      args.push("exec", "--json", ...sandboxFlags);
      if (profileName && profileName !== "default") {
        args.push("--profile", profileName);
      }
      if (model) {
        args.push("--model", model);
      }
      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }
      if (providerSessionId) {
        args.push("resume", providerSessionId);
      }
      if (planMode) {
        promptPrefix = [
          "IMPORTANT: This is a PLAN-ONLY session. Do NOT implement, write, edit, or modify any files.",
          "Do NOT run commands that make changes (git, npm, pip, etc.). Only read and explore the codebase,",
          "analyze the issue, and produce a detailed implementation plan.",
          "",
          "At the very END of your response, output the complete plan as Markdown wrapped EXACTLY between",
          "these two marker lines, each on its own line with nothing else on the line:",
          PLAN_BEGIN_MARKER,
          "<your full markdown implementation plan here>",
          PLAN_END_MARKER,
          "Then stop.",
        ].join("\n");
      } else if (systemInstructions) {
        promptPrefix = systemInstructions;
      }
      if (planMode && systemInstructions) {
        promptPrefix = `${systemInstructions}\n\n${promptPrefix}`;
      }
      args.push("-");
    }

    return {
      command,
      args,
      useShell,
      isMockAgent,
      env: { ...process.env as Record<string, string> },
      keepStdinOpen: false,
      promptPrefix,
    };
  }

  parseStreamEvent(line: string): ParsedStreamEvent | undefined {
    return parseAgentProviderStreamLine("codex", line);
  }
}
