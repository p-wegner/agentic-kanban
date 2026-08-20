import { describe, expect, it } from "vitest";
import {
  assessFileContention,
  computeHotFiles,
  isRegistrationFile,
  resolveFileContentionMode,
} from "../src/lib/file-contention.js";
import { computeCouplingCandidates } from "../src/lib/coupling-overlap.js";

describe("isRegistrationFile", () => {
  it("detects the registration files observed in all three dogfood stacks (#119)", () => {
    // taskflow/TS, bookvault/Python, shopcart/Kotlin — the exact files named in the ticket.
    expect(isRegistrationFile("src/app.ts")).toBe(true);
    expect(isRegistrationFile("app/main.py")).toBe(true);
    expect(isRegistrationFile("app/models/__init__.py")).toBe(true);
    expect(isRegistrationFile("src/main/kotlin/Application.kt")).toBe(true);
    expect(isRegistrationFile("src/main/kotlin/DatabaseFactory.kt")).toBe(true);
  });

  it("matches suffix-shaped wiring files whose basename varies per project", () => {
    expect(isRegistrationFile("src/app.module.ts")).toBe(true);
    expect(isRegistrationFile("src/di/AppModule.kt")).toBe(true);
    expect(isRegistrationFile("src/DatabaseConfig.kt")).toBe(true);
  });

  it("does not flag ordinary feature files", () => {
    expect(isRegistrationFile("src/routes/tasks.ts")).toBe(false);
    expect(isRegistrationFile("app/services/billing.py")).toBe(false);
    expect(isRegistrationFile("src/main/kotlin/TaskRepository.kt")).toBe(false);
    expect(isRegistrationFile("")).toBe(false);
  });

  it("normalises windows separators and leading ./", () => {
    expect(isRegistrationFile("src\\app.ts")).toBe(true);
    expect(isRegistrationFile("./src/app.ts")).toBe(true);
  });
});

describe("computeHotFiles", () => {
  it("marks a registration file hot even when only one issue predicts it", () => {
    const hot = computeHotFiles([{ issueId: "a", files: ["src/app.ts", "src/routes/tasks.ts"] }]);
    expect(hot.has("src/app.ts")).toBe(true);
    expect(hot.has("src/routes/tasks.ts")).toBe(false);
  });

  it("marks a project-specific file hot once enough issues predict it", () => {
    const issues = [
      { issueId: "a", files: ["src/di/wiring.gen.ts"] },
      { issueId: "b", files: ["src/di/wiring.gen.ts"] },
      { issueId: "c", files: ["src/di/wiring.gen.ts"] },
    ];
    expect(computeHotFiles(issues).has("src/di/wiring.gen.ts")).toBe(true);
    expect(computeHotFiles(issues, { hotFileMinIssues: 4 }).has("src/di/wiring.gen.ts")).toBe(false);
  });

  it("never lets hotFileMinIssues drop below 2 (a single issue can't contend with itself)", () => {
    const hot = computeHotFiles([{ issueId: "a", files: ["src/lonely.ts"] }], { hotFileMinIssues: 1 });
    expect(hot.has("src/lonely.ts")).toBe(false);
  });

  it("honours explicitly configured extra hot files", () => {
    const hot = computeHotFiles([{ issueId: "a", files: ["src/feature.ts"] }], {
      extraHotFiles: ["src\\feature.ts"],
    });
    expect(hot.has("src/feature.ts")).toBe(true);
  });
});

describe("assessFileContention", () => {
  // The #119 scenario: two correctly-sized, otherwise-disjoint tickets that both
  // must register themselves in src/app.ts.
  const candidate = { issueId: "ticket-b", files: ["src/app.ts", "src/routes/labels.ts", "src/services/label.ts"] };
  const inFlight = [{ issueId: "ticket-a", files: ["src/app.ts", "src/routes/tags.ts", "src/services/tag.ts"] }];

  it("serializes two tickets that share a registration file", () => {
    const hot = computeHotFiles([candidate, ...inFlight]);
    const verdict = assessFileContention(candidate, inFlight, hot);
    expect(verdict.serialize).toBe(true);
    expect(verdict.hotFiles).toEqual(["src/app.ts"]);
    expect(verdict.blockingIssueIds).toEqual(["ticket-a"]);
  });

  it("catches the case the existing coupling detector cannot (the regression #119 is about)", () => {
    // Overlap coefficient is 1/3 — below the 0.5 coupling threshold — so
    // computeCouplingCandidates correctly reports NO coupling. These are not the
    // same ticket. But they still collide on src/app.ts, which is exactly the
    // parallelism tax. Contention detection must be independent of overlap breadth.
    const coupling = computeCouplingCandidates([candidate, ...inFlight]);
    expect(coupling).toEqual([]);

    const hot = computeHotFiles([candidate, ...inFlight]);
    expect(assessFileContention(candidate, inFlight, hot).serialize).toBe(true);
  });

  it("does not serialize when the shared file is not hot", () => {
    const a = { issueId: "a", files: ["src/util/dates.ts", "src/routes/tags.ts"] };
    const b = { issueId: "b", files: ["src/util/dates.ts", "src/routes/labels.ts"] };
    const hot = computeHotFiles([a, b]); // dates.ts: 2 issues, below the default 3
    const verdict = assessFileContention(b, [a], hot);
    expect(verdict.serialize).toBe(false);
    expect(verdict.sharedFiles).toEqual(["src/util/dates.ts"]);
    expect(verdict.blockingIssueIds).toEqual([]);
  });

  it("does not serialize disjoint tickets", () => {
    const a = { issueId: "a", files: ["src/app.ts", "src/routes/tags.ts"] };
    const b = { issueId: "b", files: ["docs/readme.md"] };
    expect(assessFileContention(b, [a], computeHotFiles([a, b])).serialize).toBe(false);
  });

  it("fails open when the candidate has no cached prediction", () => {
    const a = { issueId: "a", files: ["src/app.ts"] };
    const verdict = assessFileContention({ issueId: "b", files: [] }, [a], computeHotFiles([a]));
    expect(verdict.serialize).toBe(false);
  });

  it("fails open when the in-flight ticket has no cached prediction", () => {
    const b = { issueId: "b", files: ["src/app.ts"] };
    const verdict = assessFileContention(b, [{ issueId: "a", files: [] }], computeHotFiles([b]));
    expect(verdict.serialize).toBe(false);
  });

  it("ignores the candidate appearing in its own in-flight set", () => {
    const a = { issueId: "a", files: ["src/app.ts"] };
    expect(assessFileContention(a, [a], computeHotFiles([a])).serialize).toBe(false);
  });

  it("reports every contending in-flight issue, sorted and deduped", () => {
    const c = { issueId: "c", files: ["src/app.ts", "src/x.ts"] };
    const flight = [
      { issueId: "b", files: ["src/app.ts"] },
      { issueId: "a", files: ["src/app.ts", "src/x.ts"] },
    ];
    const verdict = assessFileContention(c, flight, computeHotFiles([c, ...flight]));
    expect(verdict.blockingIssueIds).toEqual(["a", "b"]);
    expect(verdict.sharedFiles).toEqual(["src/app.ts", "src/x.ts"]);
  });

  it("treats windows- and posix-spelled predictions as the same file", () => {
    const a = { issueId: "a", files: ["src\\app.ts"] };
    const b = { issueId: "b", files: ["./src/app.ts"] };
    expect(assessFileContention(b, [a], computeHotFiles([a, b])).serialize).toBe(true);
  });
});

describe("resolveFileContentionMode", () => {
  it("defaults to serialize (safe: defers a start, never cancels it)", () => {
    expect(resolveFileContentionMode(undefined)).toBe("serialize");
    expect(resolveFileContentionMode("")).toBe("serialize");
    expect(resolveFileContentionMode("serialize")).toBe("serialize");
  });

  it("accepts explicit opt-out and warn-only", () => {
    expect(resolveFileContentionMode("off")).toBe("off");
    expect(resolveFileContentionMode("FALSE")).toBe("off");
    expect(resolveFileContentionMode(" warn ")).toBe("warn");
    expect(resolveFileContentionMode("suggest")).toBe("warn");
  });
});
