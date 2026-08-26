import { describe, expect, it } from "vitest";
import {
  EU_DATA_RESIDENCY_LABEL,
  NO_TRAINING_LABEL,
  dataHandlingBlockedByRequirement,
  missingProfileTags,
  parseProfileCapabilities,
  parseRequiredDataLabels,
  profileCapabilitiesPrefKey,
  profileSatisfiesRequiredTags,
  requiredDataLabelsPrefKey,
  serializeProfileCapabilities,
} from "../src/lib/profile-capabilities.js";

describe("profileCapabilitiesPrefKey", () => {
  it("builds a provider:name compact key", () => {
    expect(profileCapabilitiesPrefKey("claude", "andrena_team_5x_2")).toBe(
      "profile_capabilities_claude:andrena_team_5x_2",
    );
  });

  it("narrows an unrecognized provider to the default (claude), like profile-allowlist does", () => {
    expect(profileCapabilitiesPrefKey("bogus", "x")).toBe("profile_capabilities_claude:x");
  });
});

describe("requiredDataLabelsPrefKey", () => {
  it("builds a per-project key", () => {
    expect(requiredDataLabelsPrefKey("proj-1")).toBe("required_data_labels_proj-1");
  });
});

describe("parseProfileCapabilities / serializeProfileCapabilities", () => {
  it("parses a CSV, trimming and lowercasing", () => {
    expect(parseProfileCapabilities(" No-Training , EU-Data-Residency ")).toEqual([
      "no-training",
      "eu-data-residency",
    ]);
  });

  it("treats absent/empty as no tags", () => {
    expect(parseProfileCapabilities(undefined)).toEqual([]);
    expect(parseProfileCapabilities(null)).toEqual([]);
    expect(parseProfileCapabilities("")).toEqual([]);
  });

  it("serializes back to a deduped, normalized CSV", () => {
    expect(serializeProfileCapabilities(["No-Training", "no-training", " eu-data-residency "])).toBe(
      "no-training,eu-data-residency",
    );
  });
});

describe("profileSatisfiesRequiredTags / missingProfileTags", () => {
  it("is satisfied when no tags are required", () => {
    expect(profileSatisfiesRequiredTags([], [])).toBe(true);
    expect(missingProfileTags([], [])).toEqual([]);
  });

  it("is satisfied when the profile carries every required tag, case/whitespace-insensitively", () => {
    expect(profileSatisfiesRequiredTags(["no-training", "eu-data-residency"], [" No-Training "])).toBe(true);
  });

  it("reports what is missing without being satisfied", () => {
    expect(profileSatisfiesRequiredTags(["no-training"], ["no-training", "eu-data-residency"])).toBe(false);
    expect(missingProfileTags(["no-training"], ["no-training", "eu-data-residency"])).toEqual([
      "eu-data-residency",
    ]);
  });

  it("an untagged profile fails any non-empty requirement", () => {
    expect(profileSatisfiesRequiredTags([], [NO_TRAINING_LABEL])).toBe(false);
    expect(missingProfileTags([], [NO_TRAINING_LABEL])).toEqual([NO_TRAINING_LABEL]);
  });
});

describe("dataHandlingBlockedByRequirement", () => {
  it("is unblocked when the project requires nothing", () => {
    const result = dataHandlingBlockedByRequirement({
      requiredRaw: "",
      provider: "claude",
      profileName: "andrena_team_5x_2",
      profileTagsRaw: null,
    });
    expect(result.blocked).toBe(false);
  });

  it("is unblocked when the resolved profile carries every required tag", () => {
    const result = dataHandlingBlockedByRequirement({
      requiredRaw: NO_TRAINING_LABEL,
      provider: "claude",
      profileName: "andrena_team_5x_2",
      profileTagsRaw: `${NO_TRAINING_LABEL},${EU_DATA_RESIDENCY_LABEL}`,
    });
    expect(result.blocked).toBe(false);
  });

  it("is blocked, naming the missing tag(s), when the profile is missing one", () => {
    const result = dataHandlingBlockedByRequirement({
      requiredRaw: `${NO_TRAINING_LABEL},${EU_DATA_RESIDENCY_LABEL}`,
      provider: "claude",
      profileName: "personal_account",
      profileTagsRaw: NO_TRAINING_LABEL,
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.missing).toEqual([EU_DATA_RESIDENCY_LABEL]);
      expect(result.reason).toContain("claude:personal_account");
      expect(result.reason).toContain(EU_DATA_RESIDENCY_LABEL);
    }
  });

  it("is blocked when no profile has resolved at all — an untagged profile cannot be assumed compliant", () => {
    const result = dataHandlingBlockedByRequirement({
      requiredRaw: NO_TRAINING_LABEL,
      provider: "claude",
      profileName: undefined,
      profileTagsRaw: undefined,
    });
    expect(result.blocked).toBe(true);
  });
});
