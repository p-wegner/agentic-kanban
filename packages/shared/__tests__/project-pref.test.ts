import { describe, expect, it } from "vitest";
import {
  projectPref,
  isProjectScopedDynamicKey,
  PROJECT_SCOPED_KEY_PREFIXES,
} from "../src/lib/dynamic-preference-keys.js";

const PROJECT_ID = "d1c5d9c1-4897-4e1b-acc3-2aa96de04117";

describe("projectPref (#496)", () => {
  it("builds and parses a key round-trip", () => {
    const pref = projectPref("start_mode");
    const key = pref.key(PROJECT_ID);
    expect(key).toBe(`start_mode_${PROJECT_ID}`);
    expect(pref.projectIdOf(key)).toBe(PROJECT_ID);
  });

  it("returns null for a key of a different family", () => {
    expect(projectPref("start_mode").projectIdOf(`wip_limit_${PROJECT_ID}`)).toBeNull();
  });

  it("returns null when the suffix is not project-id shaped", () => {
    // Guards the inverse regexes this replaced: several were bare `(.+)` captures that
    // would happily return a non-id suffix.
    expect(projectPref("start_mode").projectIdOf("start_mode_")).toBeNull();
    expect(projectPref("start_mode").projectIdOf("start_mode_NotAUuid")).toBeNull();
  });

  it("does not mistake a LONGER prefix for its own family", () => {
    // `compounding_setup` vs `compounding_setup_state` share a head — the shorter family
    // must not claim the longer one's keys, or a state blob reads as a project id.
    const shorter = projectPref("compounding_setup");
    expect(shorter.projectIdOf(`compounding_setup_state_${PROJECT_ID}`)).toBeNull();
    expect(projectPref("compounding_setup_state").projectIdOf(`compounding_setup_state_${PROJECT_ID}`))
      .toBe(PROJECT_ID);
  });

  it("every key it builds is one the allow-list accepts", () => {
    // The point of typing `prefix` off the registry: build and allow-list can't disagree.
    for (const prefix of PROJECT_SCOPED_KEY_PREFIXES) {
      expect(isProjectScopedDynamicKey(projectPref(prefix).key(PROJECT_ID)), prefix).toBe(true);
    }
  });
});

describe("live per-project settings are registered (#496)", () => {
  // These three had dedicated key builders but were missing from the registry, so
  // `getSettings()` filtered them out — and config export/import is built on getSettings(),
  // which meant an exported config silently omitted them and rejected them (422) on import.
  it.each(["dev_command", "health_url", "butler_profile"])("%s is allow-listed", (prefix) => {
    expect(isProjectScopedDynamicKey(`${prefix}_${PROJECT_ID}`)).toBe(true);
  });

  it("keeps the deliberately-unregistered keys out", () => {
    // `butler_model_<id>` is legacy (read-only fallback) and `project_completed_announced_<id>`
    // is an internal reconciler marker — registering either would make it settable through the
    // settings route/MCP and carry it through config export. See the note in the source.
    expect(isProjectScopedDynamicKey(`butler_model_${PROJECT_ID}`)).toBe(false);
    expect(isProjectScopedDynamicKey(`project_completed_announced_${PROJECT_ID}`)).toBe(false);
  });
});
