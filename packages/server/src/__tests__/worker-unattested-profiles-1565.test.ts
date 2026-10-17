import { describe, expect, it } from "vitest";
import { parseWorkerUnattestedProfiles } from "@agentic-kanban/shared/lib/worker-protocol";
import { WORKER_RESTART_SETTING_KEYS, parseWorkerSettings } from "@agentic-kanban/shared/lib/worker-settings";
import {
  credentialProblemProfiles,
  describeWorkerProfiles,
  unattestedAllowedProfileLines,
} from "../lib/worker-profile-attestation.js";
import { pinnedSettingKeys } from "../worker/worker-settings-apply.js";

describe("#1565 unattested profiles", () => {
  it("parses names and states, dropping junk", () => {
    expect(parseWorkerUnattestedProfiles([
      { provider: "claude", name: "a", state: "filtered" },
      { provider: "claude", name: "b", state: "bogus" },
      { name: "c", state: "expired" },
    ])).toEqual([{ provider: "claude", name: "a", state: "filtered" }]);
    expect(parseWorkerUnattestedProfiles("x")).toBeUndefined();
  });

  it("describes attested and unattested together", () => {
    expect(describeWorkerProfiles(
      [{ provider: "claude", name: "anth" }, { provider: "claude", name: "old", credentials: "missing" }],
      [{ provider: "claude", name: "t5", state: "filtered" }],
    )).toBe("anth ✓ · old missing · t5 filtered");
  });

  it("flags a worker whose only attested profile has a credentials problem", () => {
    expect(credentialProblemProfiles([{ provider: "claude", name: "anth", credentials: "missing" }], "claude")).toEqual(["anth missing"]);
    expect(credentialProblemProfiles([{ provider: "claude", name: "anth", credentials: "missing" }, { provider: "claude", name: "b" }], "claude")).toEqual([]);
  });

  it("names allowed profiles a worker found but filtered out", () => {
    const lines = unattestedAllowedProfileLines(
      [{ name: "ao", unattestedProfiles: [{ provider: "claude", name: "t5", state: "filtered" }, { provider: "claude", name: "zz", state: "filtered" }] }],
      [{ provider: "claude", name: "t5" }],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("t5");
    expect(lines[0]).not.toContain("zz");
  });

  it("makes the attested set a restart-applied, flag-pinned board setting", () => {
    expect(parseWorkerSettings({ profiles: ["anth", "t5"] }).profiles).toEqual(["anth", "t5"]);
    expect(WORKER_RESTART_SETTING_KEYS).toContain("profiles");
    expect(pinnedSettingKeys({ profiles: ["anth"] })).toContain("profiles");
    expect(pinnedSettingKeys({})).not.toContain("profiles");
  });
});
