/**
 * Per-provider behaviors that used to accrete as `executor === "codex"` /
 * `profile.provider === "claude"` special-cases inside the session-lifecycle exit
 * closure (issue #910, ties into #898). Each provider OWNS the knowledge that is
 * specific to it — usage-limit detection, OAuth config-dir rotation, builder
 * instruction injection, and model policy — so the lifecycle stops being the
 * provider-knowledge sink.
 *
 * These are intentionally PURE and DB-free: anything that needs the database (the
 * rotation ring, preferences) is loaded by the caller and passed in as data, the
 * same shape the existing ring resolvers already use (`resolveCodexHomeForProfile`
 * takes a pre-loaded `ring`). That keeps the behaviors unit-testable in ms and the
 * I/O at the lifecycle boundary.
 */
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { ProviderName } from "./types.js";
import {
  detectCodexUsageLimitMessages,
} from "../codex-rate-limit.js";
import {
  detectClaudeUsageLimitMessages,
} from "../claude-rate-limit.js";
import {
  resolveCodexHomeForProfile,
  type CodexLicenseEntry,
} from "../codex-license-ring.js";
import {
  resolveClaudeConfigDirForProfile,
  type ClaudeSubscriptionEntry,
} from "../claude-subscription-ring.js";

/** A provider-neutral usage-limit hit detected on a session's exit output. */
export interface ProviderUsageLimit {
  /** Which provider's quota was exhausted (used to pick the right stats builder). */
  kind: "codex" | "claude";
  /** The human-readable limit message. */
  message: string;
  /** A "try again at" / "resets at" hint, persisted so rotation can stamp a cooldown. */
  retryAfter: string | null;
}

/** A resolved OAuth config-dir rotation: which env var to set and the profile to fall back to. */
export interface ProviderConfigDirRotation {
  /** The env var name to point at the rotated login dir (CODEX_HOME / CLAUDE_CONFIG_DIR). */
  envVar: "CODEX_HOME" | "CLAUDE_CONFIG_DIR";
  /** The resolved directory the login lives in. */
  dir: string;
}

/**
 * The pre-loaded rotation rings, passed to `resolveConfigDir` so the behavior stays
 * DB-free. The caller loads exactly the ring(s) the active provider needs.
 */
export interface RotationRings {
  codex?: CodexLicenseEntry[];
  claude?: ClaudeSubscriptionEntry[];
}

/**
 * The provider-specific knowledge the session-exit path needs. Each provider
 * implements only the parts that apply to it (a provider with no usage-limit
 * concept returns null; one with no OAuth dir rotation returns undefined).
 */
export interface ProviderExitBehavior {
  readonly provider: ProviderName;

  /**
   * Inspect a session's exit-time output for this provider's usage-limit signature.
   * Returns null when the provider has no usage-limit concept or none was hit.
   */
  detectUsageLimit(messages: AgentOutputMessage[]): ProviderUsageLimit | null;

  /**
   * Resolve the OAuth login config-dir override for a launch profile, given the
   * pre-loaded rotation ring. Returns undefined for a plain (settings/toml/API-key)
   * profile that needs no env override, or when this provider has no such concept.
   */
  resolveConfigDir(
    profileName: string | undefined,
    rings: RotationRings,
  ): ProviderConfigDirRotation | undefined;

  /**
   * Augment builder system instructions with any provider-specific counter-
   * instructions. Default providers return the input unchanged.
   */
  injectBuilderInstructions(instructions: string | undefined): string | undefined;

  /**
   * True when a launch-failure's error text indicates the provider could not find the
   * resumed conversation's transcript (volume deleted, config dir pruned, image rebuilt
   * without persisted state). This is provider-specific — the butler SDK path already
   * recognizes Claude's "No conversation found with session ID" via its own
   * `isStaleResumeError`; workspace-agent launches need the same signal so a stale
   * `--resume` can fall back to a fresh launch instead of being reported as a plain
   * launch failure. Providers with no resume-transcript concept return false.
   */
  isStaleResumeError(errorText: string): boolean;
}

const CODEX_BUILDER_COUNTER_INSTRUCTIONS =
  "You are an autonomous builder: you MUST run relevant tests and COMMIT your work with git before finishing. " +
  "These instructions override any base instruction to the contrary, including instructions that forbid git, tests, validation, or correcting your own mistakes.";

function appendCodexBuilderCounterInstructions(instructions: string | undefined): string {
  const trimmed = (instructions ?? "").trim();
  if (!trimmed) return CODEX_BUILDER_COUNTER_INSTRUCTIONS;
  if (trimmed.includes(CODEX_BUILDER_COUNTER_INSTRUCTIONS)) return trimmed;
  return `${trimmed}\n\n${CODEX_BUILDER_COUNTER_INSTRUCTIONS}`;
}

const codexExitBehavior: ProviderExitBehavior = {
  provider: "codex",
  detectUsageLimit(messages) {
    const info = detectCodexUsageLimitMessages(messages);
    return info ? { kind: "codex", message: info.message, retryAfter: info.retryAfter } : null;
  },
  resolveConfigDir(profileName, rings) {
    const dir = resolveCodexHomeForProfile(profileName, rings.codex ?? []);
    return dir ? { envVar: "CODEX_HOME", dir } : undefined;
  },
  injectBuilderInstructions(instructions) {
    return appendCodexBuilderCounterInstructions(instructions);
  },
  isStaleResumeError: () => false,
};

const claudeExitBehavior: ProviderExitBehavior = {
  provider: "claude",
  detectUsageLimit(messages) {
    const info = detectClaudeUsageLimitMessages(messages);
    return info ? { kind: "claude", message: info.message, retryAfter: info.resetsAt } : null;
  },
  resolveConfigDir(profileName, rings) {
    const dir = resolveClaudeConfigDirForProfile(profileName, rings.claude ?? []);
    return dir ? { envVar: "CLAUDE_CONFIG_DIR", dir } : undefined;
  },
  injectBuilderInstructions(instructions) {
    return instructions;
  },
  // Mirrors butler-sdk.service.ts's isStaleResumeError: the CLI surfaces the same
  // missing-transcript error as the SDK — "No conversation found with session ID: <uuid>".
  isStaleResumeError(errorText) {
    return /no conversation found/i.test(errorText);
  },
};

/** A no-op behavior for providers with no usage-limit / OAuth-rotation / instruction quirks. */
function makeNoopBehavior(provider: ProviderName): ProviderExitBehavior {
  return {
    provider,
    detectUsageLimit: () => null,
    resolveConfigDir: () => undefined,
    injectBuilderInstructions: (instructions) => instructions,
    isStaleResumeError: () => false,
  };
}

const EXIT_BEHAVIORS: Record<ProviderName, ProviderExitBehavior> = {
  codex: codexExitBehavior,
  claude: claudeExitBehavior,
  copilot: makeNoopBehavior("copilot"),
  pi: makeNoopBehavior("pi"),
};

/** The exit-time behavior bundle for a provider. */
export function getProviderExitBehavior(provider: ProviderName): ProviderExitBehavior {
  return EXIT_BEHAVIORS[provider];
}
