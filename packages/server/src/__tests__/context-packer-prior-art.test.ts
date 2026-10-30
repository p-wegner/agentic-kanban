import { describe, expect, it } from "vitest";
import { isBoardGeneratedTicket, priorArtExcerpt } from "../services/context-packer.service.js";

describe("context primer prior art (#1764)", () => {
  it("excludes board-generated tickets", () => {
    expect(isBoardGeneratedTicket({ title: "heal: base branch 'master' is red (2 failing suites)" })).toBe(true);
    expect(isBoardGeneratedTicket({ title: "x", externalKey: "base-health-heal:p:master" })).toBe(true);
    expect(isBoardGeneratedTicket({ title: "x", externalKey: "plugin-loop:abc" })).toBe(true);
    expect(isBoardGeneratedTicket({ title: "jira sync", externalKey: "PROJ-12" })).toBe(false);
  });

  it("cuts at a line boundary", () => {
    const d = "first line here\nsecond line here\n" + "z".repeat(200);
    expect(priorArtExcerpt(d)).toBe("first line here second line here");
  });

  it("never leaves an unterminated backtick", () => {
    const ex = priorArtExcerpt("The nightly sweep ran and it FAILED.\n\n- Base branch: `master` and `ma" + "x".repeat(200));
    expect((ex.match(/`/g) ?? []).length % 2).toBe(0);
    const long = priorArtExcerpt("word ".repeat(10) + "`unterminated " + "y ".repeat(50));
    expect((long.match(/`/g) ?? []).length % 2).toBe(0);
  });
});
