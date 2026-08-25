/**
 * #894 — the gate ran a full 7,183-test suite fifteen times on one workspace and merged zero
 * times, failing each round on ~3 timing-shaped tests that passed in 21.9s when re-run on a
 * quiet box. These cases pin the narrow re-run that fixes it, and — more importantly — the
 * guard rails that stop it becoming a blanket second chance.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_RETRYABLE_SUITES,
  decideFlakeRetry,
  parseFailedSuites,
  retryScopeEnvValue,
} from "../services/verify-flake-retry.js";

/** The shape `scripts/test-mine.mjs` actually prints, package headers and all. */
const REAL_846_OUTPUT = `
[test:mine] shared: node vitest run --passWithNoTests --maxWorkers=2

 Test Files  25 passed (25)
      Tests  103 passed (103)

[test:mine] server: node vitest run --passWithNoTests --maxWorkers=2

 FAIL  src/__tests__/mock-agent-multiturn.test.ts > multiturn > keeps context
 FAIL  src/__tests__/session-lifecycle.test.ts > lifecycle > counts turns
AssertionError: expected 1 to be >= 2
 FAIL  src/__tests__/shared-package-exports.test.ts
Error: Test timed out in 90000ms

 Test Files  3 failed | 761 passed (764)
      Tests  3 failed | 7175 passed | 5 skipped (7183)
`;

describe("parseFailedSuites", () => {
  it("pulls the failing suites out of a real gate run and attributes them to a package", () => {
    expect(parseFailedSuites(REAL_846_OUTPUT)).toEqual([
      { packageLabel: "server", file: "src/__tests__/mock-agent-multiturn.test.ts" },
      { packageLabel: "server", file: "src/__tests__/session-lifecycle.test.ts" },
      { packageLabel: "server", file: "src/__tests__/shared-package-exports.test.ts" },
    ]);
  });

  it("collapses the same suite named once per failing test and again in the summary", () => {
    const out = parseFailedSuites(`
[test:mine] server: node vitest run
 FAIL  src/__tests__/a.test.ts > one
 FAIL  src/__tests__/a.test.ts > two
 FAIL  src/__tests__/a.test.ts [ src/__tests__/a.test.ts ]
`);
    expect(out).toEqual([{ packageLabel: "server", file: "src/__tests__/a.test.ts" }]);
  });

  it("keeps same-named suites in different packages apart", () => {
    // The reason attribution exists at all: every package has a src/__tests__, so the bare
    // relative path is ambiguous and re-running the wrong one would report a false green.
    // A REAL cross-package collision: both packages carry a src/__tests__/settings-registry
    // suite. (Deliberately not the nloc-ratchet pair, which is the other real one — naming it
    // here would trip always-run-marker-ratchet's guard-helper regex on a mere fixture string.)
    const out = parseFailedSuites(`
[test:mine] server: node vitest run
 FAIL  src/__tests__/settings-registry.test.ts > x
[test:mine] client: node vitest run
 FAIL  src/__tests__/settings-registry.test.ts > y
`);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.packageLabel)).toEqual(["server", "client"]);
  });

  it("survives the ANSI colouring vitest emits when it thinks it has a TTY", () => {
    const out = parseFailedSuites(
      "[test:mine] server: node vitest run\n [41m FAIL [0m src/__tests__/a.test.ts > x",
    );
    expect(out).toEqual([{ packageLabel: "server", file: "src/__tests__/a.test.ts" }]);
  });

  it("finds nothing in output that never ran a test", () => {
    expect(parseFailedSuites("error TS2345: Argument of type 'string'...\nBuild failed.")).toEqual([]);
  });
});

describe("decideFlakeRetry", () => {
  const scoped = { scoped: true };

  it("retries the small, identifiable failure that #846 actually hit", () => {
    const d = decideFlakeRetry({ output: REAL_846_OUTPUT, ...scoped });
    expect(d.retry).toBe(true);
    expect(d.suites).toHaveLength(3);
  });

  it("refuses a broad failure — that is a regression, not contention", () => {
    const lines = ["[test:mine] server: node vitest run"];
    for (let i = 0; i < MAX_RETRYABLE_SUITES + 1; i++) lines.push(` FAIL  src/__tests__/s${i}.test.ts > x`);
    const d = decideFlakeRetry({ output: lines.join("\n"), ...scoped });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/regression/);
  });

  it("retries right up to the ceiling but not past it", () => {
    const at = ["[test:mine] server: node vitest run"];
    for (let i = 0; i < MAX_RETRYABLE_SUITES; i++) at.push(` FAIL  src/__tests__/s${i}.test.ts > x`);
    expect(decideFlakeRetry({ output: at.join("\n"), ...scoped }).retry).toBe(true);
  });

  it("refuses when nothing can be named — a compile or install failure has nothing to re-run", () => {
    const d = decideFlakeRetry({ output: "error TS2345: ...\nBuild failed.", ...scoped });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/no failing suite/);
  });

  it("refuses a suite it cannot attribute to a package", () => {
    // No `[test:mine] <pkg>:` header, so the path is ambiguous across packages.
    const d = decideFlakeRetry({ output: " FAIL  src/__tests__/a.test.ts > x", ...scoped });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/could not be attributed/);
  });

  it("refuses for a project whose verify_script cannot scope — the retry would re-run EVERYTHING", () => {
    // The trap this guard exists for: KANBAN_RETRY_TEST_FILES is inert for gradlew/pytest/mvn,
    // so a "targeted re-run" there is a second full 44-minute build.
    const d = decideFlakeRetry({ output: REAL_846_OUTPUT, scoped: false });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/does not honour suite scoping/);
  });

  it("refuses a timeout, which is already reported as inconclusive upstream", () => {
    const d = decideFlakeRetry({ output: REAL_846_OUTPUT, timedOut: true, ...scoped });
    expect(d.retry).toBe(false);
  });
});

describe("retryScopeEnvValue", () => {
  it("emits package-qualified entries the runner can resolve unambiguously", () => {
    expect(
      retryScopeEnvValue([
        { packageLabel: "server", file: "src/__tests__/a.test.ts" },
        { packageLabel: "client", file: "src/__tests__/b.test.ts" },
      ]),
    ).toBe("server:src/__tests__/a.test.ts,client:src/__tests__/b.test.ts");
  });

  it("round-trips what parseFailedSuites produced", () => {
    const suites = parseFailedSuites(REAL_846_OUTPUT);
    const value = retryScopeEnvValue(suites);
    expect(value.split(",")).toHaveLength(suites.length);
    for (const s of suites) expect(value).toContain(`${s.packageLabel}:${s.file}`);
  });
});
