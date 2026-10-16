import { describe, expect, it } from "vitest";
import { describeFailingSuites } from "../services/verify-worker-runner.service.js";

describe("describeFailingSuites (#1544)", () => {
  it("is empty when nothing was named", () => {
    expect(describeFailingSuites(undefined)).toBe("");
    expect(describeFailingSuites([])).toBe("");
  });
  it("lists the suites", () => {
    expect(describeFailingSuites(["a.test.ts", "b.test.ts"])).toBe(" [a.test.ts, b.test.ts]");
  });
  it("caps at 10 and says how many more", () => {
    const suites = Array.from({ length: 13 }, (_, i) => `s${i}.test.ts`);
    const out = describeFailingSuites(suites);
    expect(out).toContain("s9.test.ts");
    expect(out).not.toContain("s10.test.ts");
    expect(out).toContain("+3 more");
  });
});
