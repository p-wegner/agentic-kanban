/** Sentinel markers wrapping the machine-readable plan block emitted by a plan-mode run. */
export const PLAN_BEGIN_MARKER = "===PLAN BEGIN===";
export const PLAN_END_MARKER = "===PLAN END===";

/**
 * The single source of truth for the set of concrete agent providers. Both the
 * `ProviderName` union and the registry derive from this, and a parity test
 * (agent-provider-registry.test.ts) asserts the registry implements exactly these —
 * so adding a 5th provider is a one-line change that cannot silently drift out of
 * sync with the registry.
 */
export const PROVIDER_NAMES = ["claude", "codex", "copilot", "pi"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
export type ProviderId = "claude-code" | "codex" | "copilot" | "pi";

export interface AgentLaunchConfig {
  command: string;
  args: string[];
  useShell: boolean;
  isMockAgent: boolean;
  env: Record<string, string>;
  /** Optional system-facing guidance passed directly as a provider-specific instruction. */
  systemInstructions?: string;
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
  /** Model override passed via the provider launch flags (e.g. Claude/Codex/other harness-specific values). */
  model?: string;
  /** Optional system-facing guidance that all providers should enforce. */
  systemInstructions?: string;
  keepAlive?: boolean;
  permissionPromptTool?: string;
  planMode?: boolean;
  provider?: ProviderId;
  prompt?: string;
  /** Provider-readable files to attach or otherwise expose to the initial turn. */
  contextFiles?: string[];
  /** Pi extension package paths loaded with repeated `--extension` flags. */
  piExtensionPaths?: string[];
  /** Pi skill `SKILL.md` paths loaded with repeated `--skill` flags. */
  piSkillPaths?: string[];
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
    contextTokens?: number;
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
    retryAfter?: string;
    message?: string;
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

/** Minimal filesystem abstraction to enable testing without global node:fs mocks. */
export interface FileSystem {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: BufferEncoding): string;
  writeFileSync(path: string, data: string, encoding: BufferEncoding): void;
}
