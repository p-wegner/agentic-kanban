/** Sentinel markers wrapping the machine-readable plan block emitted by a plan-mode run. */
export const PLAN_BEGIN_MARKER = "===PLAN BEGIN===";
export const PLAN_END_MARKER = "===PLAN END===";

export type ProviderName = "claude" | "codex" | "copilot";
export type ProviderId = "claude-code" | "codex" | "copilot";

export interface AgentLaunchConfig {
  command: string;
  args: string[];
  useShell: boolean;
  isMockAgent: boolean;
  env: Record<string, string>;
  /** If true, write prompt to stdin and keep it open for follow-up writes. */
  keepStdinOpen?: boolean;
  /** If true, do not write the prompt to stdin because the provider receives it via argv. */
  suppressStdinPrompt?: boolean;
  /** Prepended to the stdin prompt (used for providers that lack a system-prompt flag, e.g. Codex plan mode). */
  promptPrefix?: string;
}

export interface ProviderLaunchOptions {
  agentArgs?: string;
  providerSessionId?: string;
  agentCommand?: string;
  /** @deprecated Use profile instead — kept for back-compat during migration */
  claudeProfile?: string;
  /** Provider-tagged profile selection (replaces bare claudeProfile string). */
  profile?: { provider: ProviderName; name: string };
  keepAlive?: boolean;
  permissionPromptTool?: string;
  planMode?: boolean;
  provider?: ProviderId;
  prompt?: string;
  /** Skip permission prompts (use Copilot --allow-all, Claude system setting). */
  skipPermissions?: boolean;
}

/**
 * Provider-neutral parsed event from a single JSONL line of agent stdout.
 * The session manager uses these to update session state, live stats, and UI.
 */
export interface ParsedStreamEvent {
  /** Set when the provider emits its internal session/resume ID. */
  providerSessionId?: string;
  /** Set when ExitPlanMode was denied in the result event (non-interactive mode). */
  exitPlanModeDenied?: boolean;
  /** Set on result/final events with aggregate usage. */
  stats?: {
    durationMs: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    numTurns: number;
    model: string;
    success: boolean;
    agentSummary?: string;
  };
  /** Set when a result event signals turn completion (multi-turn mode). */
  turnComplete?: boolean;
  /** Set on assistant events with model/context info. */
  liveStats?: {
    model: string;
    contextTokens: number;
    toolUses?: number;
    subagentDelta?: number;
  };
  /** Set on tool_use events. */
  toolActivity?: {
    name: string;
    input: Record<string, unknown>;
    toolUseId?: string;
  };
  /** Set on tool_result events for tracked tool_use IDs. */
  toolResult?: {
    toolUseId: string;
    images?: Array<{ mediaType: string; data: string }>;
    agentResultText?: string;
  };
  /** Set on assistant events that contain text content. */
  assistantText?: string;
  /** Set on TodoWrite or equivalent task-tracking events. */
  todos?: Array<{ subject: string; status: string }>;
  /** Set on rate_limit_event events. */
  rateLimitInfo?: {
    status: string;
    rateLimitType: string;
    resetsAt?: number;
    overageStatus?: string;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
  };
}

export interface AgentProvider {
  readonly name: string;

  /** Build the full spawn configuration for this provider. */
  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig;

  /** Parse a single stdout line into a provider-neutral event (or undefined if not recognized). */
  parseStreamEvent(line: string): ParsedStreamEvent | undefined;
}

export interface BuildAgentLaunchConfigOptions extends ProviderLaunchOptions {}
