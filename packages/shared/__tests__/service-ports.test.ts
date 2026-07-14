import { describe, it, expect } from "vitest";
import {
  composeProjectName,
  isInstanceManagedComposeProject,
  isManagedComposeProject,
} from "../src/lib/service-ports.js";

const INSTANCE = "a1b2c3d4";
const OTHER_INSTANCE = "ffee9988";

describe("service-ports helpers", () => {
  describe("composeProjectName", () => {
    it("is keyed on instance id + workspace id: `ak-<inst8>-ws-<first 12 alnum>`", () => {
      const name = composeProjectName("550e8400-e29b-41d4-a716-446655440000", INSTANCE);
      expect(name).toBe("ak-a1b2c3d4-ws-550e8400e29b");
    });

    it("lowercases and strips non-alphanumerics before slicing (both tokens)", () => {
      expect(composeProjectName("ABCD-EF12_3456-XYZ", "A1-B2:C3d4!")).toBe("ak-a1b2c3d4-ws-abcdef123456");
    });

    it("only contains compose-legal chars [a-z0-9-]", () => {
      expect(composeProjectName("Weird_Id!!With..Dots-1234", INSTANCE)).toMatch(/^[a-z0-9-]+$/);
    });

    it("is stable across calls (deterministic)", () => {
      expect(composeProjectName("workspace-abc-1", INSTANCE)).toBe(composeProjectName("workspace-abc-1", INSTANCE));
    });

    it("is UNIQUE per workspace id — two workspaces on the same issue never collide", () => {
      const a = composeProjectName("11111111-aaaa-4bbb-8ccc-111111111111", INSTANCE);
      const b = composeProjectName("22222222-aaaa-4bbb-8ccc-222222222222", INSTANCE);
      expect(a).not.toBe(b);
    });

    it("is UNIQUE per instance id — two board instances never claim the same name", () => {
      const ws = "550e8400-e29b-41d4-a716-446655440000";
      expect(composeProjectName(ws, INSTANCE)).not.toBe(composeProjectName(ws, OTHER_INSTANCE));
    });

    it("THROWS on an empty/unsanitizable instance id (no silent unscoped fallback)", () => {
      expect(() => composeProjectName("anything", "")).toThrow(/instanceId/);
      expect(() => composeProjectName("anything", "!!--__")).toThrow(/instanceId/);
    });
  });

  describe("isInstanceManagedComposeProject", () => {
    it("matches names THIS instance generates", () => {
      const name = composeProjectName("550e8400-e29b-41d4-a716-446655440000", INSTANCE);
      expect(isInstanceManagedComposeProject(name, INSTANCE)).toBe(true);
    });

    it("REJECTS another instance's names — the reaper must never cross instances", () => {
      const foreign = composeProjectName("550e8400-e29b-41d4-a716-446655440000", OTHER_INSTANCE);
      expect(isInstanceManagedComposeProject(foreign, INSTANCE)).toBe(false);
    });

    it("REJECTS legacy unscoped `ak-ws-*` names — left alone, never reaped", () => {
      expect(isInstanceManagedComposeProject("ak-ws-550e8400e29b", INSTANCE)).toBe(false);
      expect(isInstanceManagedComposeProject("ak-ws-abcdef", INSTANCE)).toBe(false);
    });

    it("REJECTS a user's unrelated projects and malformed shapes", () => {
      expect(isInstanceManagedComposeProject("ak-myapp-ws-1", INSTANCE)).toBe(false);
      expect(isInstanceManagedComposeProject(`ak-${INSTANCE}-ws-ab`, INSTANCE)).toBe(false); // scope too short (<6)
      expect(isInstanceManagedComposeProject(`ak-${INSTANCE}-ws-abc-123def`, INSTANCE)).toBe(false); // internal hyphen
      expect(isInstanceManagedComposeProject(`ak-${INSTANCE}-ws-abc123!extra`, INSTANCE)).toBe(false);
      expect(isInstanceManagedComposeProject(` ak-${INSTANCE}-ws-abc123def `, INSTANCE)).toBe(false);
      expect(isInstanceManagedComposeProject("postgres", INSTANCE)).toBe(false);
      expect(isInstanceManagedComposeProject("", INSTANCE)).toBe(false);
    });

    it("returns false (never permissive) when the instance id is unusable", () => {
      expect(isInstanceManagedComposeProject("ak--ws-abc123def", "")).toBe(false);
      expect(isInstanceManagedComposeProject("ak-ws-abc123def", "!!")).toBe(false);
    });
  });

  describe("isManagedComposeProject (LEGACY shape recognizer)", () => {
    it("matches the legacy unscoped shape", () => {
      expect(isManagedComposeProject("ak-ws-abcd1234ef56")).toBe(true);
      expect(isManagedComposeProject("ak-ws-webfrontend")).toBe(true);
    });

    it("does NOT match instance-scoped names or unrelated projects", () => {
      expect(isManagedComposeProject(composeProjectName("550e8400-e29b-41d4", INSTANCE))).toBe(false);
      expect(isManagedComposeProject("ak-myapp-ws-1")).toBe(false);
      expect(isManagedComposeProject("ak-ws-web-frontend")).toBe(false);
      expect(isManagedComposeProject("ak-ws-")).toBe(false);
      expect(isManagedComposeProject("ak-ws-ab")).toBe(false);
      expect(isManagedComposeProject("postgres")).toBe(false);
      expect(isManagedComposeProject("")).toBe(false);
    });
  });
});
