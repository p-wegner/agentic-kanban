import { describe, it, expect } from "vitest";
import { composeProjectName, isManagedComposeProject, projectScope } from "../src/lib/service-ports.js";

describe("service-ports helpers", () => {
  describe("projectScope", () => {
    it("takes the first 8 alphanumeric chars, lowercased", () => {
      expect(projectScope("ABCDEF1234567890")).toBe("abcdef12");
    });

    it("strips non-alphanumerics before slicing", () => {
      // hyphens/underscores removed first, then first 8 taken
      expect(projectScope("ab-cd_ef-gh-ij")).toBe("abcdefgh");
    });

    it("handles short ids", () => {
      expect(projectScope("abc")).toBe("abc");
    });
  });

  describe("composeProjectName", () => {
    it("is deterministic, project-scoped, and encodes the offset", () => {
      const name = composeProjectName("Proj1234WithMore", 42);
      expect(name).toBe("ak-proj1234-ws-42");
    });

    it("only contains compose-legal chars [a-z0-9-]", () => {
      const name = composeProjectName("Weird_Id!!With..Dots", 101);
      expect(name).toMatch(/^[a-z0-9-]+$/);
    });

    it("includes the offset in the name", () => {
      const offset = 777;
      const name = composeProjectName("someproject", offset);
      expect(name).toContain(String(offset));
      expect(name.endsWith(`-ws-${offset}`)).toBe(true);
    });

    it("is stable across calls (deterministic)", () => {
      expect(composeProjectName("p1", 5)).toBe(composeProjectName("p1", 5));
    });

    it("scopes by project so different projects differ", () => {
      expect(composeProjectName("projectAAA", 5)).not.toBe(composeProjectName("projectBBB", 5));
    });
  });

  describe("isManagedComposeProject", () => {
    it("matches names we generate", () => {
      expect(isManagedComposeProject(composeProjectName("proj", 3))).toBe(true);
      expect(isManagedComposeProject("ak-abcd1234-ws-12")).toBe(true);
    });

    it("rejects names missing the ak- prefix", () => {
      expect(isManagedComposeProject("other-abcd-ws-12")).toBe(false);
    });

    it("rejects names missing the -ws- infix", () => {
      expect(isManagedComposeProject("ak-abcd1234-svc-12")).toBe(false);
      expect(isManagedComposeProject("ak-somethingelse")).toBe(false);
    });

    it("rejects unrelated compose project names", () => {
      expect(isManagedComposeProject("postgres")).toBe(false);
      expect(isManagedComposeProject("")).toBe(false);
    });
  });
});
