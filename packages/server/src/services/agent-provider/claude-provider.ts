import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import { getMcpConfigPath, buildSpawnEnv, splitArgs, nodeFileSystem } from "./helpers.js";

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";
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
      keepAlive,
      permissionPromptTool,
      planMode,
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
        console.warn(`[agent] Failed to generate MCP config: ${err}`);
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
      if (providerSessionId) {
        args.push("--resume", providerSessionId);
      }
      if (permissionPromptTool) {
        args.push("--permission-prompt-tool", permissionPromptTool);
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
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return undefined;
    }

    const result: ParsedStreamEvent = {};

    if (obj.type === "system" && obj.subtype === "init" && obj.session_id) {
      result.providerSessionId = obj.session_id as string;
    }

    if (obj.type === "result") {
      const usage = obj.usage as Record<string, unknown> | undefined;
      const rawCost = obj.total_cost_usd ?? obj.cost_usd;
      const agentSummary = typeof obj.result === "string" ? obj.result : undefined;
      result.stats = {
        durationMs: (obj.duration_ms as number) ?? 0,
        totalCostUsd: typeof rawCost === "number" ? rawCost : 0,
        inputTokens: (usage?.input_tokens as number) ?? 0,
        outputTokens: (usage?.output_tokens as number) ?? 0,
        numTurns: (obj.num_turns as number) ?? 1,
        model: (obj.model as string) ?? "",
        success: obj.subtype === "success" && !obj.is_error,
        agentSummary,
      };
      result.turnComplete = true;

      const denials = obj.permission_denials as Array<Record<string, unknown>> | undefined;
      if (denials?.some((d) => d.tool_name === "ExitPlanMode")) {
        result.exitPlanModeDenied = true;
      }
    }

    if (obj.type === "assistant" && obj.message) {
      const message = obj.message as Record<string, unknown>;
      const usage = message.usage as Record<string, unknown> | undefined;
      const model = (message.model as string) ?? "";
      const cacheRead = (usage?.cache_read_input_tokens as number) ?? 0;
      const inputTokens = (usage?.input_tokens as number) ?? 0;
      const contextTokens = cacheRead + inputTokens;
      if (model || contextTokens > 0) {
        result.liveStats = { model, contextTokens };
      }

      const content = message.content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "tool_use" && !result.toolActivity) {
            result.toolActivity = {
              name: block.name,
              input: block.input ?? {},
              toolUseId: block.id,
            };
            if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
              result.todos = (block.input.todos as Array<{ subject: string; status: string }>).map(
                (t) => ({ subject: t.subject, status: t.status }),
              );
            }
            if (block.name === "Agent") {
              result.liveStats = {
                ...(result.liveStats ?? { model, contextTokens }),
                subagentDelta: 1,
              };
            }
          }
        }
        if (textParts.length > 0) {
          result.assistantText = textParts.join("\n");
        }
      }
    }

    if (obj.type === "system" && obj.subtype === "task_progress" && obj.usage) {
      const tpUsage = obj.usage as { tool_uses?: number };
      if (tpUsage.tool_uses) {
        result.liveStats = { model: "", contextTokens: 0, toolUses: tpUsage.tool_uses };
      }
    }

    if (obj.type === "result" && obj.usage) {
      const rUsage = obj.usage as Record<string, unknown>;
      const contextTokens = ((rUsage.cache_read_input_tokens as number) ?? 0) + ((rUsage.input_tokens as number) ?? 0);
      if (contextTokens > 0) {
        result.liveStats = { ...(result.liveStats ?? { model: "", contextTokens }), contextTokens };
      }
    }

    if (obj.type === "user" && (obj.message as Record<string, unknown> | undefined)?.content) {
      const content = (obj.message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const images: Array<{ mediaType: string; data: string }> = [];
            if (Array.isArray(block.content)) {
              for (const inner of block.content) {
                if (inner.type === "image" && inner.source?.type === "base64" && inner.source.data) {
                  images.push({ mediaType: inner.source.media_type ?? "image/png", data: inner.source.data });
                }
              }
            }
            const agentResultText = typeof block.content === "string" && block.content ? block.content : undefined;
            result.toolResult = { toolUseId: block.tool_use_id, ...(images.length > 0 ? { images } : {}), ...(agentResultText !== undefined ? { agentResultText } : {}) };
            break;
          }
        }
      }
    }

    if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
      const rli = obj.rate_limit_info as Record<string, unknown>;
      result.rateLimitInfo = {
        status: (rli.status as string) ?? "",
        rateLimitType: (rli.rateLimitType as string) ?? "",
        resetsAt: rli.resetsAt as number | undefined,
        overageStatus: rli.overageStatus as string | undefined,
        overageDisabledReason: rli.overageDisabledReason as string | undefined,
        isUsingOverage: rli.isUsingOverage as boolean | undefined,
      };
    }

    if (
      result.providerSessionId === undefined &&
      result.exitPlanModeDenied === undefined &&
      result.stats === undefined &&
      result.turnComplete === undefined &&
      result.liveStats === undefined &&
      result.toolActivity === undefined &&
      result.toolResult === undefined &&
      result.todos === undefined &&
      result.rateLimitInfo === undefined
    ) {
      return undefined;
    }

    return result;
  }
}
