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

  // Typecheck is the cheapest correctness signal — run it per-edit when present.
  if (profile.typecheckCommand) {
    rules.push({
      name: "Typecheck",
      command: profile.typecheckCommand,
      filePatterns: patterns,
      blocking: !isSlowJvm,
      timeout: 120,
    });
  }

  // Quick/affected tests give behavioral feedback. Fall back to the full test command only
  // when there is no quick variant (and no typecheck already covering the edit). Skipped for the
  // slow JVM family (see above) — too slow to run on every edit.
  const testCommand = profile.quickTestCommand ?? profile.testCommand;
  if (testCommand && !isSlowJvm) {
    rules.push({
      name: profile.quickTestCommand ? "Quick tests" : "Tests",
      command: testCommand,
      filePatterns: patterns,
      blocking: true,
      timeout: 180,
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
