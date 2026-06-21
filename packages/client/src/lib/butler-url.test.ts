import { describe, it, expect } from "vitest";
import { buildButlerUrl } from "./butler-url.js";

describe("buildButlerUrl", () => {
  it("uses the base path for the default / empty butler", () => {
    expect(buildButlerUrl("p1", "default", "/message")).toBe("/api/projects/p1/butler/message");
    expect(buildButlerUrl("p1", "", "/message")).toBe("/api/projects/p1/butler/message");
  });
  it("appends an encoded ?butler= for a named butler", () => {
    expect(buildButlerUrl("p1", "quick bot", "/ensure")).toBe("/api/projects/p1/butler/ensure?butler=quick%20bot");
  });
  it("appends &butler= when the path already has a query", () => {
    expect(buildButlerUrl("p1", "b2", "/stream?since=5")).toBe("/api/projects/p1/butler/stream?since=5&butler=b2");
  });
});
