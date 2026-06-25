import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveEffectiveModel } from "../services/effective-config.service.js";
import type { ProviderName } from "../services/agent-provider.js";

// Architecture gate for #902 ("Remove the non-provider-scoped global default_model").
//
// The global, provider-agnostic `default_model` pref was the structural footgun: it was
// fed to whichever provider won the resolution, guarded only by a silent-nullify check
// (`modelBelongsToProvider`) that turned a stale Codex `gpt-5.5` into a doomed
// `claude.exe --model gpt-5.5` launch (the #696/#699 multi-cycle stalls). Model is now
// ONLY provider-scoped (`default_model_<provider>`), making a cross-provider model id
// structurally unrepresentable.
//
// This test makes that MACHINE-TRUE: the resolver must consult ONLY provider-scoped keys,
// and no live source may READ the global `default_model` key. A regression fails
// `pnpm test` instead of silently re-introducing the footgun.

const SERVER_SRC = join(import.meta.dirname, "..");

function prefs(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("#902 — resolver consults only provider-scoped model keys", () => {
  it("the resolver source does NOT read the global default_model key", () => {
    const resolver = readFileSync(
      join(SERVER_SRC, "services", "effective-config.service.ts"),
      "utf8",
    );
    // No reference to the global key string and no use of the deprecated constant.
    expect(resolver).not.toMatch(/PREF_DEFAULT_MODEL\b/);
    expect(resolver).not.toContain('"default_model"');
    // The `legacy-default` candidate is gone from the resolver's source union.
    expect(resolver).not.toContain("legacy-default");
    // Provider-scoped slots remain the only model source.
    expect(resolver).toMatch(/PREF_DEFAULT_MODEL_CLAUDE/);
    expect(resolver).toMatch(/PREF_DEFAULT_MODEL_CODEX/);
    expect(resolver).toMatch(/PREF_DEFAULT_MODEL_PI/);
  });

  it("a value in the global default_model key is IGNORED — only provider-scoped keys win", () => {
    // A leftover global default_model (the old footgun) must have NO effect now.
    const claude = resolveEffectiveModel({
      prefMap: prefs({ provider: "claude", default_model: "gpt-5.5", default_model_claude: "opus" }),
      provider: "claude" satisfies ProviderName,
    });
    expect(claude.model).toBe("opus");
    expect(claude.source).toBe("provider-default");

    // Global key alone (no provider-scoped slot) → no model leaks through.
    const none = resolveEffectiveModel({
      prefMap: prefs({ provider: "claude", default_model: "gpt-5.5" }),
      provider: "claude" satisfies ProviderName,
    });
    expect(none.model).toBeUndefined();
    expect(none.source).toBe("none");
  });

  it("the EffectiveModel source union no longer contains legacy-default", () => {
    // Provider-scoped default still resolves with the right source label.
    const r = resolveEffectiveModel({
      prefMap: prefs({ provider: "codex", default_model_codex: "gpt-5.5" }),
      provider: "codex" satisfies ProviderName,
    });
    expect(r.source).toBe("provider-default");
    // @ts-expect-error — "legacy-default" is no longer an assignable EffectiveModel source.
    const dead: typeof r.source = "legacy-default";
    void dead;
  });
});
