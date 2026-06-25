import { extname } from "node:path";
import { parseAgentProviderStreamLine, parseAgentProviderStreamLineObserved } from "@agentic-kanban/shared/lib/agent-stream-parser";
import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "./types.js";
import { nodeFileSystem, resolvePiExecutable, splitArgs } from "./helpers.js";

function extractPiProfile(profile: ProviderLaunchOptions["profile"]): { provider?: string; model?: string } {
  if (profile?.provider !== "pi") return {};
  const name = profile.name.trim();
  if (!name || name === "default") return {};

  const slash = name.indexOf("/");
  const colon = name.indexOf(":");
  const separator = slash >= 0 ? slash : colon;
  if (separator <= 0 || separator === name.length - 1) {
    return {};
  }

  return {
    provider: name.slice(0, separator),
    model: name.slice(separator + 1),
  };
}

export class PiProvider implements AgentProvider {
  readonly name = "pi";
  readonly profilePrefKey = "pi_profile";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, agentCommand, keepAlive, model, piExtensionPaths, piSkillPaths, planMode, profile, providerSessionId, prompt, systemInstructions } = options;
    const isWindows = process.platform === "win32";
    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "pi";
    let useShell = isWindows;

    const args: string[] = [];
    let promptPrefix: string | undefined;
    let suppressStdinPrompt = false;

    if (isMockAgent) {
      if (providerSessionId) args.push("--resume", providerSessionId);
      if (keepAlive) args.push("--profile", "multi-turn");
    } else {
      if (!agentCommand) {
        const resolved = resolvePiExecutable(command, this.fs);
        if (resolved) {
          command = resolved;
          const ext = extname(resolved).toLowerCase();
          useShell = ext === ".cmd" || ext === ".ps1";
        }
      }

      args.push("--mode", "json");

      const piProfile = extractPiProfile(profile);
      if (piProfile.provider) {
        args.push("--provider", piProfile.provider);
      }

      const effectiveModel = model ?? piProfile.model;
      if (effectiveModel) {
        args.push("--model", effectiveModel);
      }

      if (providerSessionId) {
        args.push("--session", providerSessionId);
      }

      for (const extensionPath of piExtensionPaths ?? []) {
        if (extensionPath) args.push("--extension", extensionPath);
      }

      for (const skillPath of piSkillPaths ?? []) {
        if (skillPath) args.push("--skill", skillPath);
      }

      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }

      if (planMode) {
        promptPrefix = [
          "IMPORTANT: This is a PLAN-ONLY session. Do NOT implement, write, edit, or modify any files.",
          "Do NOT run commands that make changes (git, npm, pnpm, yarn, pip, etc.). Only read and explore the codebase,",
          "analyze the issue, and produce a detailed implementation plan.",
          "",
          "At the very END of your response, output the complete plan as Markdown wrapped EXACTLY between",
          "these two marker lines, each on its own line with nothing else on the line:",
          PLAN_BEGIN_MARKER,
          "<your full markdown implementation plan here>",
          PLAN_END_MARKER,
          "Then stop.",
        ].join("\n");
      }
      if (systemInstructions) {
        promptPrefix = promptPrefix ? `${systemInstructions}\n\n${promptPrefix}` : systemInstructions;
      }

      const promptArg = promptPrefix ? `${promptPrefix}\n\n${prompt ?? ""}` : (prompt ?? "");
      args.push("-p", promptArg);
      promptPrefix = undefined;
      suppressStdinPrompt = true;
    }

    return {
      command,
      args,
      useShell,
      isMockAgent,
      env: { ...process.env as Record<string, string> },
      keepStdinOpen: false,
      suppressStdinPrompt,
      promptPrefix,
    };
  }

  parseStreamEvent(line: string): ParsedStreamEvent | undefined {
    return parseAgentProviderStreamLine("pi", line);
  }

  parseStreamEventObserved(line: string): ParsedStreamEvent | undefined {
    return parseAgentProviderStreamLineObserved("pi", line);
  }
}
