import { describe, it, expect } from "vitest";
import {
  isProjectScopedDynamicKey,
  PROJECT_SCOPED_KEY_PREFIXES,
  FREEFORM_SUFFIX_KEY_PREFIXES,
} from "../lib/dynamic-preference-keys.js";

const PROJECT_ID = "0b3f1a2c-4d5e-6789-abcd-ef0123456789";

describe("isProjectScopedDynamicKey", () => {
  it("accepts every project-scoped prefix with a valid project-id suffix", () => {
    for (const prefix of PROJECT_SCOPED_KEY_PREFIXES) {
      expect(isProjectScopedDynamicKey(`${prefix}_${PROJECT_ID}`)).toBe(true);
    }
  });

  // #904: the card-aging heatmap toggle + warm/hot day thresholds were written
  // client-side but never whitelisted here, so PUT /preferences/settings 422'd
  // and the write was silently swallowed — the prefs appeared to work but never
  // persisted (same class as #874). Assert them explicitly so a regression that
  // drops a prefix fails loudly, not just via the loop above.
  it("accepts the card-aging board prefixes (#904)", () => {
    expect(isProjectScopedDynamicKey(`board_card_aging_heatmap_${PROJECT_ID}`)).toBe(true);
    expect(isProjectScopedDynamicKey(`board_aging_warm_days_${PROJECT_ID}`)).toBe(true);
    expect(isProjectScopedDynamicKey(`board_aging_hot_days_${PROJECT_ID}`)).toBe(true);
  });

  it("rejects a project-scoped prefix with a non-hex suffix", () => {
    expect(isProjectScopedDynamicKey("start_mode_NotAUuid")).toBe(false);
    expect(isProjectScopedDynamicKey("wip_limit_ZZZ")).toBe(false);
  });

  it("rejects a project-scoped prefix with no suffix", () => {
    expect(isProjectScopedDynamicKey("start_mode")).toBe(false);
    expect(isProjectScopedDynamicKey("start_mode_")).toBe(false);
  });

  it("accepts freeform-suffix prefixes with any non-empty suffix", () => {
    for (const prefix of FREEFORM_SUFFIX_KEY_PREFIXES) {
      expect(isProjectScopedDynamicKey(`${prefix}_anth`)).toBe(true);
      expect(isProjectScopedDynamicKey(`${prefix}_some.Profile-99`)).toBe(true);
    }
  });

  it("rejects a freeform prefix with no suffix", () => {
    expect(isProjectScopedDynamicKey("codex_cooldown_")).toBe(false);
  });

  it("rejects unrelated / exact-match settings keys", () => {
    expect(isProjectScopedDynamicKey("auto_merge")).toBe(false);
    expect(isProjectScopedDynamicKey("claude_profile")).toBe(false);
    // exact 'butler_event_feed' is a static SETTINGS_KEY, not a dynamic one
    expect(isProjectScopedDynamicKey("butler_event_feed")).toBe(false);
  });

  it("does not match the board-strategy key (handled separately by the service)", () => {
    expect(isProjectScopedDynamicKey(`board_strategy_${PROJECT_ID}`)).toBe(false);
  });

  it("requires the full suffix to be hex (no trailing garbage)", () => {
    expect(isProjectScopedDynamicKey(`start_mode_${PROJECT_ID}x!`)).toBe(false);
  });
});
