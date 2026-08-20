import { describe, expect, it, vi } from "vitest";
import { adoptLegacySlugPath, legacySlugify } from "../src/lib/slug-path-compat.js";
import { slugify } from "../src/lib/slugify.js";

/**
 * #682 — #565's slug consolidation moved PERSISTED paths, with no migration and no note.
 *
 * Both halves are pinned here: that the legacy rule really is the old one (so the compat lookup
 * finds what is actually on disk), and that adoption only ever moves a legacy artifact onto a
 * currently-unoccupied path.
 */
describe("legacySlugify — the pre-#565 rule", () => {
  it("reproduces the measured divergences from the ticket", () => {
    expect(legacySlugify("Über-Ticket")).toBe("ber-ticket");
    expect(slugify("Über-Ticket")).toBe("uber-ticket");
    expect(legacySlugify("Straße")).toBe("stra-e");
    expect(slugify("Straße")).toBe("strasse");
  });

  it("diverges on pure ASCII too, when the cap lands mid-run", () => {
    // The old rule capped AFTER trimming and never re-trimmed, so a dash could survive at the end.
    const title = `${"a".repeat(59)} b`;
    expect(legacySlugify(title, { maxLength: 60 })).toBe(`${"a".repeat(59)}-`);
    expect(slugify(title, { maxLength: 60 })).toBe("a".repeat(59));
  });

  it("agrees with the current rule for a plain ASCII name — the common no-op case", () => {
    expect(legacySlugify("agentic kanban")).toBe(slugify("agentic kanban"));
  });

  it("honours the fallback for a name with nothing slug-able", () => {
    expect(legacySlugify("—", { fallback: "project" })).toBe("project");
    expect(legacySlugify("", { fallback: "issue" })).toBe("issue");
  });
});

describe("adoptLegacySlugPath", () => {
  it("renames the legacy artifact when only it exists", () => {
    const rename = vi.fn();
    const res = adoptLegacySlugPath("/r/uber.md", "/r/ber.md", {
      exists: (p) => p === "/r/ber.md",
      rename,
    });
    expect(res).toEqual({ adopted: true, from: "/r/ber.md" });
    expect(rename).toHaveBeenCalledWith("/r/ber.md", "/r/uber.md");
  });

  it("does NOTHING when the current path already exists — never overwrites live content", () => {
    const rename = vi.fn();
    const res = adoptLegacySlugPath("/r/uber.md", "/r/ber.md", { exists: () => true, rename });
    expect(res.adopted).toBe(false);
    expect(rename).not.toHaveBeenCalled();
  });

  it("does nothing when the legacy path does not exist", () => {
    const rename = vi.fn();
    expect(adoptLegacySlugPath("/r/uber.md", "/r/ber.md", { exists: () => false, rename }).adopted).toBe(false);
    expect(rename).not.toHaveBeenCalled();
  });

  it("is a pure no-op when the two paths are identical (unchanged slug)", () => {
    const exists = vi.fn(() => true);
    expect(adoptLegacySlugPath("/r/x.md", "/r/x.md", { exists }).adopted).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });

  it("degrades to 'not adopted' when the rename fails, rather than throwing at the caller", () => {
    // The write that follows creates the new path; a failed adoption must not fail the merge/write.
    const res = adoptLegacySlugPath("/r/uber.md", "/r/ber.md", {
      exists: (p) => p === "/r/ber.md",
      rename: () => { throw new Error("EPERM"); },
    });
    expect(res.adopted).toBe(false);
  });
});
