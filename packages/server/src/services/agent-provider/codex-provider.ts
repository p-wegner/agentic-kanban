import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "./types.js";
import { resolveCodexDirect, splitArgs, nodeFileSystem } from "./helpers.js";

export class CodexProvider implements AgentProvider {
  readonly name = "codex";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, providerSessionId, agentCommand, keepAlive, profile, model, planMode } = options;
    const isWindows = process.platform === "win32";

    const isMockAgent = !!process.env.AGENT_COMMAND || (agentCommand?.includes("mock-agent") ?? false);
    let command = process.env.AGENT_COMMAND || agentCommand || "codex";
    let useShell = isWindows;

    const args: string[] = [];
    let promptPrefix: string | undefined;

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

      const sandboxFlags = planMode
        ? ["--sandbox", "read-only"]
        : ["--dangerously-bypass-approvals-and-sandbox"];
      if (providerSessionId) {
        args.push("exec", "resume", "--json", ...sandboxFlags);
      } else {
        args.push("exec", "--json", ...sandboxFlags);
      }
      const profileName = profile?.provider === "codex" ? profile.name : undefined;
      if (profileName && profileName !== "default") {
        args.push("--profile-v2", profileName);
      }
      if (model) {
        args.push("--model", model);
      }
      if (providerSessionId) {
        args.push(providerSessionId);
      }
      if (agentArgs) {
        args.push(...splitArgs(agentArgs));
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
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return undefined;
    }

    const result: ParsedStreamEvent = {};

    if (obj.type === "thread.started" && obj.thread_id) {
      result.providerSessionId = obj.thread_id as string;
    }

    if (obj.type === "turn.completed") {
      const usage = obj.usage as Record<string, unknown> | undefined;
      const inputTokens = (usage?.input_tokens as number) ?? 0;
      const cachedTokens = (usage?.cached_input_tokens as number) ?? 0;
      const outputTokens = (usage?.output_tokens as number) ?? 0;
      result.stats = {
        durationMs: 0,
        totalCostUsd: 0,
        inputTokens,
        outputTokens,
        numTurns: 1,
        model: "",
        success: true,
      };
      result.liveStats = {
        model: "",
        contextTokens: inputTokens + cachedTokens,
      };
      result.turnComplete = true;
    }

    if (obj.type === "item.started" && obj.item) {
      const item = obj.item as Record<string, unknown>;
      if (item.type === "command_execution" && item.command) {
        result.toolActivity = {
          name: "shell",
          input: { command: item.command },
          toolUseId: item.id as string | undefined,
        };
      } else if (item.type === "mcp_tool_call" && item.name) {
        result.toolActivity = {
          name: item.name as string,
          input: (item.args ?? {}) as Record<string, unknown>,
          toolUseId: item.id as string | undefined,
        };
      }
    }

    if (obj.type === "item.completed" && obj.item) {
      const item = obj.item as Record<string, unknown>;
      if (item.type === "command_execution" && item.id) {
        result.toolResult = { toolUseId: item.id as string };
      } else if (item.type === "agent_message" && typeof item.text === "string" && item.text) {
        result.assistantText = item.text;
      } else if (item.type === "mcp_tool_call" && item.id) {
        const resultText = typeof item.result === "string" ? item.result : undefined;
        result.toolResult = {
          toolUseId: item.id as string,
          ...(resultText ? { agentResultText: resultText } : {}),
        };
      }
    }

    if (
      result.providerSessionId === undefined &&
      result.stats === undefined &&
      result.turnComplete === undefined &&
      result.liveStats === undefined &&
      result.assistantText === undefined &&
      result.toolActivity === undefined &&
      result.toolResult === undefined &&
      result.todos === undefined
    ) {
      return undefined;
    }

    return result;
  }
}
