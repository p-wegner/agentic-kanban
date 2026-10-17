import { describe, expect, it } from "vitest";
import { verifyHonoursSuiteScope } from "../services/self-project.js";

const runner = (text: string | null) => () => text;

describe("verifyHonoursSuiteScope (#1579)", () => {
  const base = { repoPath: "/other/checkout", selfRoot: "/self", workingDir: "/wt" };

  it("is true for a non-self checkout whose verify runs a test-mine that reads the retry scope", () => {
    expect(
      verifyHonoursSuiteScope({ ...base, verifyScript: "pnpm check:arch && pnpm test:mine", readRunner: runner("process.env.KANBAN_RETRY_TEST_FILES") }),
    ).toBe(true);
  });

  it("stays false for a foreign stack, a script that does not run test:mine, or a runner without the variable", () => {
    expect(verifyHonoursSuiteScope({ ...base, verifyScript: "gradlew.bat build", readRunner: runner("KANBAN_RETRY_TEST_FILES") })).toBe(false);
    expect(verifyHonoursSuiteScope({ ...base, verifyScript: "pnpm test:mine", readRunner: runner("nothing here") })).toBe(false);
    expect(verifyHonoursSuiteScope({ ...base, verifyScript: "pnpm test:mine", readRunner: runner(null) })).toBe(false);
  });

  it("keeps the board's own checkout true", () => {
    expect(verifyHonoursSuiteScope({ repoPath: "/self", selfRoot: "/self", verifyScript: null })).toBe(true);
  });
});
