import { describe, it, expect } from "vitest";
import { composeProjectName, isManagedComposeProject } from "../src/lib/service-ports.js";

describe("service-ports helpers", () => {
  describe("composeProjectName", () => {
    it("is keyed on the workspace id: `ak-ws-<first 12 alnum>`", () => {
      const name = composeProjectName("550e8400-e29b-41d4-a716-446655440000");
      expect(name).toBe("ak-ws-550e8400e29b");
    });

    it("lowercases and strips non-alphanumerics before slicing", () => {
      expect(composeProjectName("ABCD-EF12_3456-XYZ")).toBe("ak-ws-abcdef123456");
    });

    it("only contains compose-legal chars [a-z0-9-]", () => {
      expect(composeProjectName("Weird_Id!!With..Dots-1234")).toMatch(/^[a-z0-9-]+$/);
    });

    it("is stable across calls (deterministic)", () => {
      expect(composeProjectName("workspace-abc-1")).toBe(composeProjectName("workspace-abc-1"));
    });

    it("is UNIQUE per workspace id — two workspaces on the same issue never collide", () => {
      // Distinct workspace ids (e.g. two workspaces on the same issue/branch) must
      // yield distinct names, or one workspace's `down -v` destroys the other's stack.
      const a = composeProjectName("11111111-aaaa-4bbb-8ccc-111111111111");
      const b = composeProjectName("22222222-aaaa-4bbb-8ccc-222222222222");
      expect(a).not.toBe(b);
    });

    it("always starts with the ak-ws- prefix", () => {
      expect(composeProjectName("anything").startsWith("ak-ws-")).toBe(true);
    });
  });

  describe("isManagedComposeProject", () => {
    it("matches names we generate", () => {
      expect(isManagedComposeProject(composeProjectName("550e8400-e29b-41d4-a716-446655440000"))).toBe(true);
      expect(isManagedComposeProject("ak-ws-abcd1234ef56")).toBe(true);
    });

    it("rejects names missing the ak-ws- prefix", () => {
      expect(isManagedComposeProject("ak-abcd1234-ws-12")).toBe(false);
      expect(isManagedComposeProject("other-ws-abcd1234")).toBe(false);
    });

    it("is PRECISE — does not match a user's unrelated `ak-*-ws-*` project (F10)", () => {
      // The old loose matcher (prefix `ak-` + `-ws-` infix) would have downed these.
      expect(isManagedComposeProject("ak-myapp-ws-1")).toBe(false);
      expect(isManagedComposeProject("ak-ws-webfrontend")).toBe(true); // pure alnum scope, ours
      expect(isManagedComposeProject("ak-ws-web-frontend")).toBe(false); // internal hyphen — never generated
      expect(isManagedComposeProject("ak-ws-")).toBe(false); // no scope
      expect(isManagedComposeProject("ak-ws-ab")).toBe(false); // too short (<6)
    });

    it("rejects names with trailing/embedded illegal chars", () => {
      expect(isManagedComposeProject("ak-ws-abc123!extra")).toBe(false);
      expect(isManagedComposeProject("ak-ws-ABC123DEF")).toBe(false); // uppercase not in shape
      expect(isManagedComposeProject(" ak-ws-abc123def ")).toBe(false);
    });

    it("rejects unrelated compose project names", () => {
      expect(isManagedComposeProject("postgres")).toBe(false);
      expect(isManagedComposeProject("")).toBe(false);
    });
  });
});
