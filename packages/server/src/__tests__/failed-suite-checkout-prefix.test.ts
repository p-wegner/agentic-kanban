import { describe, expect, it } from "vitest";
import { failedSuitesForOutcome, stripCheckoutPrefix } from "../services/failed-suite-parse.js";
import { classifyFailedSuites } from "../services/verify-failed-suites.js";
import { parseVerifyFailingSuites } from "../worker/worker-verify-runner.js";

const ROOT = "/home/worker/.agentic-kanban/stable/state-work/verify/job-1";
const NAMES = ["verify-gate-runner", "data-dir", "worker-agent-tree-dies-with-daemon", "plugin-exec-progress"];
const LOG = [
  "[test:mine] server: node vitest run",
  ...NAMES.map((n) => ` FAIL  ${ROOT}/packages/server/src/__tests__/${n}.test.ts > some test`),
  " Test Files  4 failed | 900 passed (904)",
].join("\n");
const EXPECTED = NAMES.map((n) => `packages/server/src/__tests__/${n}.test.ts`).sort();

describe("worker checkout prefix (#1470)", () => {
  it("strips POSIX and Windows checkout roots", () => {
    expect(stripCheckoutPrefix(`${ROOT}/packages/server/a.test.ts`)).toBe("packages/server/a.test.ts");
    expect(stripCheckoutPrefix(["C:","w","verify","j","packages","shared","b.test.ts"].join(String.fromCharCode(92)))).toBe("packages/shared/b.test.ts");
    expect(stripCheckoutPrefix("src/x.test.ts")).toBe("src/x.test.ts");
  });
  it("yields the four package-relative names from a worker log", () => {
    expect(failedSuitesForOutcome("red", LOG)).toEqual(EXPECTED);
    expect(parseVerifyFailingSuites(LOG)).toEqual(EXPECTED);
  });
  it("classifies absolute suites and keeps unplaceable raw names", () => {
    const c = classifyFailedSuites(null, [{ file: `${ROOT}/packages/server/src/__tests__/data-dir.test.ts` }, { file: "src/__tests__/zzz.test.ts" }]);
    expect(c.files).toEqual(["packages/server/src/__tests__/data-dir.test.ts"]);
    expect(c.unattributed).toEqual(["src/__tests__/zzz.test.ts"]);
  });
});
