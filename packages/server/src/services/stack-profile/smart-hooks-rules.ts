// Edit-time feedback rules generated from the stack profile (#787; #911 split).
//
// Builds and writes `.claude/smart-hooks-rules.json` so a driven project's builder gets
// the same incremental PostToolUse/Stop feedback board builders get. Re-exported
// byte-identically through ../stack-profile.service.ts.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StackProfile } from "@agentic-kanban/shared";

/** One file-pattern -> quick-check entry in the generated smart-hooks-rules.json. */
export interface SmartHooksRule {
  /** Human label shown when the check fails. */
  name: string;
  /** Quick build/test/typecheck command to run (from the stack profile). */
  command: string;
  /** Glob-ish patterns (smart-hooks-runner.js dialect) that trigger this rule. */
  filePatterns: string[];
  /** Block the agent on failure. Quick incremental checks block; reminders don't. */
  blocking: boolean;
  /** Seconds before the check is killed. */
  timeout: number;
  /**
   * Hook events this rule runs on. Omitted = both (the pre-`events` behavior the runner still
   * defaults to). A command that is NOT scoped to the edited file — any test suite — is
   * `["Stop"]`: per-edit it costs its full runtime on every Write/Edit while telling you
   * nothing the end-of-turn run wouldn't.
   */
  events?: ("PostToolUse" | "Stop")[];
}

export interface SmartHooksRulesFile {
  version: "1.0.0";
  /** Marks the file as machine-generated so humans/tools know not to hand-edit it. */
  generated: true;
  /** The stack the rules were derived from, for debuggability. */
  stack: string | null;
  /** When the rules were generated. */
  generatedAt: string;
  /** Rules evaluated on PostToolUse (per-edit) and Stop (end-of-session). */
  rules: SmartHooksRule[];
}

/** Per-stack source-file glob patterns that should trigger an edit-time quick check. */
const STACK_SOURCE_PATTERNS: Record<string, string[]> = {
  node: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  rust: ["**/*.rs"],
  go: ["**/*.go"],
  python: ["**/*.py"],
  java: ["**/*.java", "**/*.kt"],
  ruby: ["**/*.rb"],
  elixir: ["**/*.ex", "**/*.exs"],
};

/** Source patterns for a profile's stack, falling back to a broad set when the stack is unknown. */
function sourcePatternsForStack(stack: string | null): string[] {
  if (stack && STACK_SOURCE_PATTERNS[stack]) return STACK_SOURCE_PATTERNS[stack];
  // Unknown stack: union of all known source extensions so SOME feedback still fires.
  return [...new Set(Object.values(STACK_SOURCE_PATTERNS).flat())];
}

/**
 * Build the generated edit-time feedback rules from a stack profile. Pure — no I/O.
 *
 * Prefers the cheapest signal available: typecheck (fastest), else quick test, else the full
 * test command. Each non-null command becomes a rule that fires when a source file for the
 * stack is edited. Project-agnostic: every command comes from the profile, nothing hard-coded
 * to a particular repo. Returns an empty `rules` list when the profile has no usable command.
 */
export function buildSmartHooksRules(profile: StackProfile): SmartHooksRulesFile {
  const patterns = sourcePatternsForStack(profile.stack);
  const rules: SmartHooksRule[] = [];

  // Gradle/Maven (the `java` family) have multi-second cold-daemon startup and, for Kotlin
  // Multiplatform, a full `test` runs every target (jvmTest + jsNodeTest). Running that as a
  // BLOCKING hook on every edit stalls the builder for minutes per keystroke-batch; running the
  // full test suite per edit is worse still. So for this family: skip the per-edit test rule
  // entirely and downgrade the (compile) typecheck to a non-blocking reminder. The verify gate
  // (`testCommand && buildCommand`) at merge time stays the real correctness gate. Fast stacks
  // (node/rust/go/python) keep the blocking per-edit loop, which is cheap there.
  const isSlowJvm = profile.stack === "java";

  // Typecheck is the cheapest correctness signal — but a profile's typecheckCommand is the
  // WHOLE project's (`pnpm typecheck`, `cargo check`), never scoped to the edited file, so
  // per-edit it is the same full run the test rule was moved off of. Measured over 7 days on
  // this repo: 207 PostToolUse runs, median 5m37s each, killed at their timeout — 47.9% of
  // all hook wall-clock for no signal. Stop-only, like the test rules below; the runner
  // defaults an absent `events` to both, which is exactly what this avoids.
  //
  // #868 — a flat 120s budget is a fine default for a small single-package repo but is
  // structurally unusable on a monorepo, where a whole-project typecheck routinely exceeds
  // it: the rule can then only ever be killed (SKIPPED "inconclusive" on every run) and never
  // produces a verdict. `isMonorepo` is already a reliably-detected profile field (used by
  // the verify-gate/dev-server derivation elsewhere), so it is the cheapest available signal
  // for "this typecheck spans multiple packages" without inventing a new measured-runtime
  // mechanism. A monorepo gets a 5x budget instead of a doomed 120s one.
  if (profile.typecheckCommand) {
    rules.push({
      name: "Typecheck",
      command: profile.typecheckCommand,
      filePatterns: patterns,
      blocking: !isSlowJvm,
      timeout: profile.isMonorepo ? 600 : 120,
      events: ["Stop"],
    });
  }

  // Quick/affected tests give behavioral feedback. Fall back to the full test command only
  // when there is no quick variant (and no typecheck already covering the edit). Skipped for the
  // slow JVM family (see above) — too slow to run on every edit.
  const testCommand = profile.quickTestCommand ?? profile.testCommand;
  if (testCommand && !isSlowJvm) {
    // #487 — "quick" is an assumption about the project's own script, not a fact this
    // generator can check. On a large monorepo the configured quick command can BE the whole
    // suite (measured: `pnpm test:mine` = 10+ min on this repo) under a 180s budget, so the
    // rule could only ever be killed. It was blocking, so it then failed on every single edit
    // regardless of what changed — a gate that is always red carries no signal at all, and it
    // reprinted its own truncated output each time.
    //
    // Two layers now stop that. The runner treats a TIMEOUT as inconclusive for non-safety
    // checks rather than a block (see smart-hooks-runner.js), and the fallback FULL test
    // command — the case we know is not scoped to the edit — is emitted as advisory only.
    // A genuine `quickTestCommand` keeps the blocking per-edit loop it was designed for.
    // Those two layers still left the per-EDIT cost in place, and it is the dominant one:
    // measured over 3 days on this repo, the PostToolUse chain ran a median of 5m50s per
    // Write/Edit — typecheck and tests each running to their timeout and being killed — for
    // 5.6h of pure latency that produced no signal at all. A test command is never scoped to
    // the one file just edited, so running it per-edit buys nothing an end-of-turn run doesn't
    // already give. Test rules are therefore Stop-only; the runner defaults an absent `events`
    // to both, so older generated files are unaffected.
    const isFullSuiteFallback = !profile.quickTestCommand;
    rules.push({
      name: profile.quickTestCommand ? "Quick tests" : "Tests",
      command: testCommand,
      filePatterns: patterns,
      blocking: !isFullSuiteFallback,
      timeout: isFullSuiteFallback ? 600 : 180,
      events: ["Stop"],
    });
  }

  return {
    version: "1.0.0",
    generated: true,
    stack: profile.stack,
    generatedAt: new Date().toISOString(),
    rules,
  };
}

/** Repo-relative path of the generated edit-time feedback rules file. */
export function smartHooksRulesPath(repoPath: string): string {
  return join(repoPath, ".claude", "smart-hooks-rules.json");
}

/**
 * Generate and write `.claude/smart-hooks-rules.json` for a project from its stack profile.
 * The generic `smart-hooks-runner.js` reads this file to give a driven project's builder the
 * same incremental PostToolUse/Stop feedback board builders get. Non-fatal on any error —
 * profile persistence must never fail because rule generation did.
 */
export function writeSmartHooksRules(repoPath: string, profile: StackProfile): void {
  try {
    const rulesFile = buildSmartHooksRules(profile);
    const outPath = smartHooksRulesPath(repoPath);
    mkdirSync(join(repoPath, ".claude"), { recursive: true });
    writeFileSync(outPath, JSON.stringify(rulesFile, null, 2) + "\n", "utf8");
  } catch {
    /* non-fatal: rule generation must never block profile persistence */
  }
}
