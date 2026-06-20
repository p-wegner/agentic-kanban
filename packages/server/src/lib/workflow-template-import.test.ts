import { describe, it, expect } from "vitest";
import {
  normalizeImportedTemplate,
  validateImportedTemplate,
} from "./workflow-template-import.js";

describe("normalizeImportedTemplate", () => {
  it("reads top-level fields directly", () => {
    const spec = normalizeImportedTemplate({
      name: "Flow",
      description: "d",
      ticketType: "feature",
      isDefault: true,
      nodes: [{ id: "a" }],
      edges: [{ fromNodeId: "a", toNodeId: "b" }],
    });
    expect(spec).toEqual({
      name: "Flow",
      description: "d",
      ticketType: "feature",
      isDefault: true,
      nodes: [{ id: "a" }],
      edges: [{ fromNodeId: "a", toNodeId: "b" }],
    });
  });

  it("unwraps a { template } envelope", () => {
    const spec = normalizeImportedTemplate({ template: { name: "T", nodes: [1], edges: [2] } });
    expect(spec.name).toBe("T");
    expect(spec.nodes).toEqual([1]);
    expect(spec.edges).toEqual([2]);
  });

  it("unwraps a { workflow } envelope", () => {
    const spec = normalizeImportedTemplate({ workflow: { name: "W" } });
    expect(spec.name).toBe("W");
  });

  it("falls back to metadata for name/description/ticketType", () => {
    const spec = normalizeImportedTemplate({ metadata: { name: "M", description: "md", ticketType: "bug" } });
    expect(spec.name).toBe("M");
    expect(spec.description).toBe("md");
    expect(spec.ticketType).toBe("bug");
  });

  it("prefers explicit top-level over nested metadata", () => {
    const spec = normalizeImportedTemplate({ name: "top", metadata: { name: "meta" } });
    expect(spec.name).toBe("top");
  });

  it("applies defaults for missing optional fields", () => {
    const spec = normalizeImportedTemplate({ name: "Only" });
    expect(spec.description).toBeNull();
    expect(spec.ticketType).toBeNull();
    expect(spec.isDefault).toBe(false);
    expect(spec.nodes).toEqual([]);
    expect(spec.edges).toEqual([]);
  });
});

describe("validateImportedTemplate", () => {
  const ok = { name: "N", description: null, ticketType: null, isDefault: false, nodes: [], edges: [] };

  it("accepts a minimal valid spec", () => {
    expect(validateImportedTemplate(ok)).toEqual([]);
  });

  it("rejects a missing/blank name", () => {
    expect(validateImportedTemplate({ ...ok, name: "" })).toContain("Imported workflow name is required.");
    expect(validateImportedTemplate({ ...ok, name: "   " })).toContain("Imported workflow name is required.");
    expect(validateImportedTemplate({ ...ok, name: undefined as any })).toContain("Imported workflow name is required.");
  });

  it("rejects non-array nodes/edges", () => {
    const errs = validateImportedTemplate({ ...ok, nodes: "x" as any, edges: 5 as any });
    expect(errs).toContain("Imported workflow nodes must be an array.");
    expect(errs).toContain("Imported workflow edges must be an array.");
  });

  it("flags a non-object node and missing node fields", () => {
    const errs = validateImportedTemplate({ ...ok, nodes: [null, { id: "", nodeType: "" }] as any });
    expect(errs).toContain("Imported workflow node at index 0 must be an object.");
    expect(errs).toContain("Imported workflow node at index 1 must have a non-empty string id.");
    expect(errs).toContain("Imported workflow node at index 1 must have a non-empty string nodeType.");
  });

  it("flags a non-object edge and missing edge endpoints", () => {
    const errs = validateImportedTemplate({ ...ok, edges: [undefined, { fromNodeId: "", toNodeId: "" }] as any });
    expect(errs).toContain("Imported workflow edge at index 0 must be an object.");
    expect(errs).toContain("Imported workflow edge at index 1 must have a non-empty string fromNodeId.");
    expect(errs).toContain("Imported workflow edge at index 1 must have a non-empty string toNodeId.");
  });

  it("accepts well-formed nodes and edges", () => {
    const errs = validateImportedTemplate({
      ...ok,
      nodes: [{ id: "a", nodeType: "stage" }],
      edges: [{ fromNodeId: "a", toNodeId: "b" }],
    } as any);
    expect(errs).toEqual([]);
  });
});
