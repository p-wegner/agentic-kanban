// @covers project-registration.enrich.llmGapFill [config,error-handling]
//
// populateStackProfile (services/stack-profile/persistence.ts:48) detects a project's
// stack via deterministic rules, then — ONLY when the rule-derived profile is sparse
// (no stack, OR neither test nor build command: isProfileSparse, persistence.ts:22) —
// invokes an LLM gap-fill (enrichWithLlm → invokeClaudePrompt) and merges the LLM's
// answer in WHERE RULES LEFT NULL, flipping `source` to "llm". A profile that already
// carries a stack + test/build command is complete, so the LLM must NOT be called and
// the persisted profile stays rule-derived (source "detected").
//
// This is a config/derivation gate that silently rots if the sparse condition inverts
// (LLM never called → empty profiles never enriched; or LLM always called → wasted
// spawn + non-deterministic profiles on every register). So we assert BOTH branches and
// also that the merge respects rule precedence. The LLM call is mocked to a canned JSON
// enrichment, so the test is fully deterministic with no real Claude/network.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Canned LLM enrichment returned by the mocked invokeClaudePrompt. Includes a `stack`
// and `testCommand` the rules could not supply, plus a `buildCommand` we DELIBERATELY
// leave for the rule-precedence assertion (the sparse fixture has no buildCommand, so
// the LLM value wins there).
const CANNED_LLM_JSON = JSON.stringify({
  stack: "elixir",
  packageManager: "mix",
  buildCommand: "mix compile",
  testCommand: "mix test",
  quickTestCommand: "mix test --stale",
  lintCommand: "mix credo",
  typecheckCommand: "mix dialyzer",
  devCommand: "mix phx.server",
  isWeb: true,
  devHealthUrl: "http://localhost:4000",
  devPort: 4000,
  testDir: "test",
  testRunner: "exunit",
});

const invokeClaudePrompt = vi.fn(async () => CANNED_LLM_JSON);

vi.mock("../services/claude-cli.service.js", () => ({
  invokeClaudePrompt: (...args: unknown[]) => invokeClaudePrompt(...args),
}));

import { createTestDb } from "./helpers/test-db.js";
import { populateStackProfile, getStackProfile } from "../services/stack-profile.service.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kanban-llm-gapfill-"));
}

describe("populateStackProfile — LLM gap-fill (project-registration.enrich.llmGapFill)", () => {
  let dir: string;
  let database: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    invokeClaudePrompt.mockClear();
    dir = tmp();
    database = createTestDb().db;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("SPARSE profile → invokes the LLM and merges its fields ONLY into null slots", async () => {
    // An empty repo: detectStackProfile finds no markers → stack null, no test/build →
    // isProfileSparse is true, so the gap-fill must fire.
    const projectId = "proj-sparse";
    const result = await populateStackProfile(projectId, dir, database);

    // (1) The LLM WAS invoked exactly once.
    expect(invokeClaudePrompt).toHaveBeenCalledTimes(1);

    // (2) The previously-null slots are now filled from the canned LLM answer, and the
    //     provenance flips to "llm".
    expect(result.source).toBe("llm");
    expect(result.stack).toBe("elixir");
    expect(result.testCommand).toBe("mix test");
    expect(result.buildCommand).toBe("mix compile");
    expect(result.devPort).toBe(4000);
    expect(result.isWeb).toBe(true);

    // (3) The enriched profile is what got persisted.
    const persisted = await getStackProfile(projectId, database);
    expect(persisted?.source).toBe("llm");
    expect(persisted?.testCommand).toBe("mix test");
  });

  it("rule facts WIN over the LLM where the rules produced a value (only nulls are filled)", async () => {
    // A partial project that is still sparse — a package.json with NO scripts means no
    // test/build command (sparse), but it DOES pin packageManager=pnpm via the lockfile.
    // The canned LLM says packageManager "mix"; the rule value must survive the merge.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const result = await populateStackProfile("proj-precedence", dir, database);

    expect(invokeClaudePrompt).toHaveBeenCalledTimes(1);
    // Rule-derived fact (node / pnpm) is NOT overwritten by the LLM's "elixir"/"mix"...
    expect(result.stack).toBe("node");
    expect(result.packageManager).toBe("pnpm");
    // ...but the genuinely-null test/build slots ARE filled by the LLM.
    expect(result.testCommand).toBe("mix test");
    expect(result.buildCommand).toBe("mix compile");
  });

  it("COMPLETE profile → does NOT invoke the LLM; persists the rule-derived profile", async () => {
    // A node/pnpm single-package project WITH test + build scripts: detectStackProfile
    // returns stack=node + test + build → NOT sparse → the gap-fill must be skipped.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }),
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const projectId = "proj-complete";
    const result = await populateStackProfile(projectId, dir, database);

    // (1) The LLM was NEVER called.
    expect(invokeClaudePrompt).not.toHaveBeenCalled();

    // (2) The profile stays rule-derived — source "detected", commands from the rules,
    //     and none of the canned LLM values (e.g. elixir) leaked in.
    expect(result.source).toBe("detected");
    expect(result.stack).toBe("node");
    expect(result.testCommand).toBe("pnpm test");
    expect(result.buildCommand).toBe("pnpm build");

    const persisted = await getStackProfile(projectId, database);
    expect(persisted?.source).toBe("detected");
    expect(persisted?.stack).toBe("node");
  });

  it("LLM THROWS on a sparse profile → try/catch swallows it, persists the rule profile (source 'detected'), no throw", async () => {
    // Graceful degradation (persistence.ts:63-65): the gap-fill is best-effort. A pnpm
    // package.json with no scripts is sparse (no test/build) but pins packageManager=pnpm.
    // When the LLM call rejects, registration must NOT fail — the rule-derived profile is
    // persisted untouched and provenance stays "detected" (NOT a half-merged "llm").
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    invokeClaudePrompt.mockRejectedValueOnce(new Error("boom"));

    const projectId = "proj-llm-throws";
    // Must NOT reject — the error is swallowed inside populateStackProfile.
    const result = await populateStackProfile(projectId, dir, database);

    expect(invokeClaudePrompt).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("detected"); // fell through to the rule profile, no "llm"
    expect(result.stack).toBe("node"); // rule fields survive
    expect(result.packageManager).toBe("pnpm");
    expect(result.testCommand).toBeNull(); // NOT filled — no partial LLM merge happened
    // The persisted profile is the rule profile, not a half-enriched one.
    const persisted = await getStackProfile(projectId, database);
    expect(persisted?.source).toBe("detected");
    expect(persisted?.testCommand).toBeNull();
  });

  it("MALFORMED LLM JSON on a sparse profile → parseLlmJson returns null → persists the rule profile, no partial merge", async () => {
    // persistence.ts:124-135 + 98-100: unparseable output → parseLlmJson null →
    // enrichWithLlm returns null → fall through to persist the rule profile. No throw,
    // no "llm" provenance, no fields invented from garbage.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    invokeClaudePrompt.mockResolvedValueOnce("not json {{");

    const projectId = "proj-llm-malformed";
    const result = await populateStackProfile(projectId, dir, database);

    expect(invokeClaudePrompt).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("detected");
    expect(result.stack).toBe("node");
    expect(result.testCommand).toBeNull();
    expect(result.buildCommand).toBeNull();
    const persisted = await getStackProfile(projectId, database);
    expect(persisted?.source).toBe("detected");
  });

  it("skipLlm option short-circuits the gap-fill even for a sparse profile", async () => {
    // The fire-and-forget escape hatch: callers can opt out of the LLM entirely. A sparse
    // repo with skipLlm must persist the rule profile untouched and never spawn the LLM.
    const result = await populateStackProfile("proj-skip", dir, database, { skipLlm: true });
    expect(invokeClaudePrompt).not.toHaveBeenCalled();
    expect(result.source).toBe("detected");
    expect(result.stack).toBeNull();
  });
});
