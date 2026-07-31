import { createHash } from "node:crypto";
import * as lifecycleRepo from "../../repositories/session-lifecycle.repository.js";
import type { Database } from "../../db/index.js";
import type { ProviderName } from "../agent-provider.js";
import { narrowProviderName } from "../agent-provider.js";
import type { RotationRings } from "../agent-provider/provider-exit-behavior.js";

/** Pure helpers for session launch that don't need the createSessionLifecycle closure. */

export const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";
export const CODEX_SAFE_DEFAULT_MODEL = "gpt-5.5";

export function isBuilderSession(triggerType: string | undefined, planMode: boolean | undefined): boolean {
  if (planMode) return false;
  if (!triggerType) return true;
  return triggerType === "agent" || triggerType === "auto-start" || triggerType === "plan-implement" || triggerType.startsWith("skill:");
}

/** Handoff note prefixed onto the prompt when relaunching fresh after a missing-transcript resume failure (#26). */
export function buildStaleResumeHandoffPrompt(originalPrompt: string): string {
  return (
    "[SESSION HANDOFF — resume recovery] The previous session's conversation transcript could not " +
    "be found by the provider (state likely lost — volume deleted, config dir pruned, or an image " +
    "rebuild without persisted state). Starting fresh: treat the current state of the worktree/branch " +
    "and any HANDOFF.md notes as the source of truth for what has already been done, then continue.\n\n" +
    originalPrompt
  );
}

export function instructionFingerprint(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export async function mergeExistingSessionStats(database: Database, sessionId: string, statsToSave: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stats = await lifecycleRepo.getSessionStats(sessionId, database);
  if (!stats) return statsToSave;
  try {
    const existing = JSON.parse(stats) as Record<string, unknown>;
    return { ...existing, ...statsToSave };
  } catch {
    return statsToSave;
  }
}

export function lifecycleProviderName(provider: string | undefined, profile?: { provider?: string; name?: string }): ProviderName {
  // A recorded profile.provider (a valid ProviderName) wins; otherwise narrow the
  // launch provider string (handles the legacy "claude-code" id, defaults to claude).
  const fromProfile = profile?.provider;
  if (fromProfile === "codex" || fromProfile === "copilot" || fromProfile === "claude" || fromProfile === "pi") return fromProfile;
  return narrowProviderName(provider);
}

/**
 * Resolve a provider's rotation-ring config directory for a launch.
 *
 * A Codex ChatGPT-plan license is a separate CODEX_HOME with its own auth.json;
 * a Claude Max/Pro login is a separate CLAUDE_CONFIG_DIR with its own
 * .credentials.json — each selected by an auto-discovered `~/.<provider>-<name>`
 * dir or a rotation-ring entry. When one resolves, point the env var at it and
 * DROP the profile name from the launch: a separate home/config dir has no
 * `[profiles.<name>]` / `settings_<name>.json`, so passing `--profile`/`--settings`
 * would make the CLI exit non-zero. Plain toml / settings-file / API-key profiles
 * resolve to nothing and keep their profile name.
 *
 * Best-effort by contract: a ring that fails to load is logged and ignored, never
 * thrown — a launch must not die because a rotation ring is unreadable.
 */
export async function resolveProviderRotation(
  database: Database,
  profile: { provider: ProviderName; name: string } | undefined,
  extraEnv: Record<string, string> | undefined,
  deps: {
    loadCodexLicenseRing: (db: Database) => Promise<unknown>;
    loadClaudeSubscriptionRing: (db: Database) => Promise<unknown>;
    getProviderExitBehavior: (provider: ProviderName) => {
      resolveConfigDir: (name: string, rings: RotationRings) => { envVar: string; dir: string } | null | undefined;
    };
  },
): Promise<{ extraEnv: Record<string, string> | undefined; profile: typeof profile }> {
  const name = profile?.name;
  if (!name || name === "default" || name === "mock") return { extraEnv, profile };

  const provider = profile!.provider;
  if (provider !== "codex" && provider !== "claude") return { extraEnv, profile };

  try {
    const rings: RotationRings = provider === "codex"
      ? { codex: (await deps.loadCodexLicenseRing(database)) as RotationRings["codex"] }
      : { claude: (await deps.loadClaudeSubscriptionRing(database)) as RotationRings["claude"] };
    const rotation = deps.getProviderExitBehavior(provider).resolveConfigDir(name, rings);
    if (!rotation) return { extraEnv, profile };
    const suppressed = provider === "codex" ? "--profile" : "--settings";
    console.log(`[session] ${provider} '${name}' -> ${rotation.envVar}=${rotation.dir} (${suppressed} suppressed)`);
    return {
      extraEnv: { ...extraEnv, [rotation.envVar]: rotation.dir },
      profile: { provider, name: "default" },
    };
  } catch (err) {
    console.warn(
      `[session] ${provider} rotation-ring resolution failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
    return { extraEnv, profile };
  }
}
