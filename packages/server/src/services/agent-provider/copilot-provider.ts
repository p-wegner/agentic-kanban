import { parseAgentStreamLine } from "@agentic-kanban/shared/lib/agent-stream-parser";
import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import {
  COPILOT_PLAN_PROMPT_PREFIX,
  COPILOT_PLAN_DENIED_TOOLS,
  COPILOT_DEFAULT_ALLOWED_TOOLS,
  resolveCopilotNpmLoader,
  getMcpConfigPath,
  splitArgs,
  mapCopilotProfile,
  nodeFileSystem,
} from "./helpers.js";

export class CopilotProvider implements AgentProvider {
  readonly name = "copilot";
  readonly profilePrefKey = "copilot_profile";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, providerSessionId, agentCommand, keepAlive, profile, planMode, prompt, contextFiles, skipPermissions, systemInstructions } = options;
    const isWindows = process.platform === "win32";

    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "copilot";
    let useShell = isWindows;
    const argsPrefix: string[] = [];

    const args: string[] = [];
    let promptPrefix: string | undefined;
    let suppressStdinPrompt = false;

    if (isMockAgent) {
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (keepAlive) {
        args.push("--profile", "multi-turn");
      }
    } else {
      const loader = resolveCopilotNpmLoader(command, this.fs);
      if (loader) {
        command = process.execPath;
        argsPrefix.push(loader);
        useShell = false;
      }

      const effectivePrompt = [
        systemInstructions,
        planMode ? COPILOT_PLAN_PROMPT_PREFIX : undefined,
        prompt,
      ].filter(Boolean).join("\n\n");
      args.push("-p", effectivePrompt);
      suppressStdinPrompt = true;
      args.push("--output-format", "json", "--stream", "on", "--no-ask-user", "--no-color");
      for (const file of contextFiles ?? []) {
        args.push("--attachment", file);
      }

      if (providerSessionId) {
        args.push(`--resume=${providerSessionId}`);
      }

      try {
        args.push("--additional-mcp-config", `@${getMcpConfigPath(this.fs)}`);
      } catch (err) {
        console.warn(`[agent] Failed to generate MCP config: ${String(err)}`);
      }
      args.push("--disable-builtin-mcps");

      const profileName = profile?.provider === "copilot" ? profile.name : undefined;
      if (profileName) {
        const mapped = mapCopilotProfile(profileName);
        if (mapped) {
          args.push(mapped.flag, mapped.value);
        }
      }

      if (skipPermissions) {
        args.push("--allow-all");
      } else {
        for (const allowedTool of COPILOT_DEFAULT_ALLOWED_TOOLS) {
          args.push(`--allow-tool=${allowedTool}`);
        }
      }

      if (planMode) {
        args.push("--plan");
        args.push("--available-tools=read,search,shell,agentic-kanban");
        for (const deniedTool of COPILOT_PLAN_DENIED_TOOLS) {
          args.push(`--deny-tool=${deniedTool}`);
        }
      }

      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }
    }

    return {
      command,
      args: [...argsPrefix, ...args],
      useShell,
      isMockAgent,
      env: { ...process.env as Record<string, string> },
      keepStdinOpen: false,
      suppressStdinPrompt,
      promptPrefix,
    };
  }

  parseStreamEvent(line: string): ParsedStreamEvent | undefined {
    return parseAgentStreamLine("copilot", line);
  }
}
