import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAgentStreamLine } from "@agentic-kanban/shared/lib/agent-stream-parser";
import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import { getMcpConfigPath, buildSpawnEnv, splitArgs, nodeFileSystem, profileDefinesCustomEndpoint } from "./helpers.js";

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";
  readonly profilePrefKey = "claude_profile";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const {
      agentArgs,
      providerSessionId,
      agentCommand,
      claudeProfile,
      profile,
      model,
      keepAlive,
      permissionPromptTool,
      systemInstructions,
      planMode,
      oneShotText,
    } = options;

    const effectiveProfileName = profile?.name ?? claudeProfile;

    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "claude";
    const isWindows = process.platform === "win32";

    if (isWindows && !isMockAgent && !agentCommand) {
      try {
        const resolved = execSync("where claude.exe 2>nul", { encoding: "utf8" }).trim().split("\n")[0]?.trim();
        if (resolved) command = resolved;
      } catch {}
    }

    // One-shot, non-streaming text mode for internal AI utility calls. No
    // stream-json/MCP wiring — just `claude --output-format text -p` reading the
    // prompt from stdin and printing the final answer. This is the launch path
    // `invokeClaudePrompt` used to reimplement outside the provider abstraction.
    if (oneShotText && !isMockAgent) {
      const textArgs: string[] = ["--output-format", "text"];
      if (model && !profileDefinesCustomEndpoint(effectiveProfileName, this.fs)) {
        textArgs.push("--model", model);
      }
      if (effectiveProfileName) {
        const settingsPath = join(homedir(), ".claude", `settings_${effectiveProfileName}.json`);
        if (this.fs.existsSync(settingsPath)) {
          textArgs.push("--settings", settingsPath);
        }
      }
      textArgs.push("-p");
      return {
        command,
        args: textArgs,
        useShell: isWindows && !!agentCommand,
        isMockAgent: false,
        env: buildSpawnEnv(effectiveProfileName, this.fs),
        keepStdinOpen: false,
      };
    }

    let args: string[];
    let keepStdinOpen = false;

    if (isMockAgent) {
      args = [];
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (keepAlive) {
        args.push("--profile", "multi-turn");
        keepStdinOpen = true;
      }
    } else {
      args = ["--output-format", "stream-json", "--verbose"];
      try {
        args.push("--mcp-config", getMcpConfigPath(this.fs));
      } catch (err) {
        console.warn(`[agent] Failed to generate MCP config: ${String(err)}`);
      }
      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
      }
      if (effectiveProfileName) {
        const settingsPath = join(homedir(), ".claude", `settings_${effectiveProfileName}.json`);
        if (this.fs.existsSync(settingsPath)) {
          args.push("--settings", settingsPath);
        }
      }
      // Pass the selected model tier — but not for profiles routed to a custom endpoint
      // (e.g. z.ai/glm), which don't understand Claude aliases and supply their own model via env.
      if (model && !profileDefinesCustomEndpoint(effectiveProfileName, this.fs)) {
        args.push("--model", model);
      }
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (permissionPromptTool) {
        args.push("--permission-prompt-tool", permissionPromptTool);
      }
      if (systemInstructions) {
        args.push("--append-system-prompt", systemInstructions);
      }
      if (planMode) {
        args.push("--permission-mode", "plan");
        args.push("--append-system-prompt", "IMPORTANT: This is a PLAN-ONLY session. Do NOT implement, write, edit, or modify any files. Do NOT run commands that make changes (git, npm, pip, etc.). Only read and explore the codebase, analyze the issue, and produce a detailed implementation plan. Output your plan and stop.");
      }
      args.push("-p");
    }

    return {
      command,
      args,
      useShell: isWindows && (isMockAgent || !!agentCommand),
      isMockAgent,
      env: buildSpawnEnv(effectiveProfileName, this.fs),
      keepStdinOpen,
    };
  }

  parseStreamEvent(line: string): ParsedStreamEvent | undefined {
    return parseAgentStreamLine("claude", line);
  }
}
