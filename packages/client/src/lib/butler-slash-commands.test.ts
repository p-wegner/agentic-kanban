import { describe, it, expect } from "vitest";
import { parseSlashCommand, filterCommands, applyCommandToInput, nextCycleIndex } from "./butler-slash-commands.js";

describe("parseSlashCommand", () => {
  it("returns the trailing slash query (incl. empty for a bare slash)", () => {
    expect(parseSlashCommand("/")).toBe("");
    expect(parseSlashCommand("hello /dep")).toBe("dep");
    expect(parseSlashCommand("/skill:foo-bar")).toBe("skill:foo-bar");
  });
  it("returns null when there is no trailing slash token", () => {
    expect(parseSlashCommand("no slash here")).toBeNull();
    expect(parseSlashCommand("/cmd then more")).toBeNull(); // slash not at the end
  });
});

describe("filterCommands", () => {
  const cmds = Array.from({ length: 12 }, (_, i) => ({ name: `deploy${i}` }));
  it("filters case-insensitively and caps at 8", () => {
    expect(filterCommands(cmds, "DEPLOY").length).toBe(8);
    expect(filterCommands([{ name: "review" }, { name: "deploy" }], "rev").map((c) => c.name)).toEqual(["review"]);
  });
});

describe("applyCommandToInput", () => {
  it("replaces a trailing slash token with /<name> ", () => {
    expect(applyCommandToInput("tell me /dep", "deploy")).toBe("tell me /deploy ");
    expect(applyCommandToInput("/dep", "deploy")).toBe("/deploy ");
  });
  it("returns null when there is no slash token", () => {
    expect(applyCommandToInput("no slash", "deploy")).toBeNull();
  });
});

describe("nextCycleIndex", () => {
  it("advances by one and wraps", () => {
    expect(nextCycleIndex(3, 0)).toBe(1);
    expect(nextCycleIndex(3, 2)).toBe(0);
    expect(nextCycleIndex(3, -1)).toBe(0); // findIndex miss -> first
  });
});
