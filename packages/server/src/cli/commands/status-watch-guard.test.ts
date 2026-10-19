import { describe, it, expect } from "vitest";
import { guardedRefresh } from "./status.js";

describe("guardedRefresh", () => {
  it("renders the error and keeps the loop alive when a refresh throws", async () => {
    const out: string[] = [];
    let calls = 0;
    const refresh = async () => {
      calls++;
      if (calls === 1) throw new Error("ERR_MODULE_NOT_FOUND moved");
    };
    expect(await guardedRefresh(refresh, (t) => out.push(t))).toBe(false);
    expect(out.join("")).toContain("ERR_MODULE_NOT_FOUND moved");
    expect(await guardedRefresh(refresh, (t) => out.push(t))).toBe(true);
    expect(calls).toBe(2);
  });
});
