// Canonical per-stack `verify` command (#124).
//
// Builders used to hand-roll their own build/test invocations and hit stack-specific
// traps the board already knows about. Fleet evidence over the exp/ build-out: the
// jvm-gradle cohort needed a median 34 turns and 23 re-runs (vs 28/8 for node-ts) at
// 35-37% tool-fail in its worst sessions. Two causes, both mechanical:
//
//  1. `.\gradlew.bat test ... 2>&1 | Select -Last N` in PowerShell 5.1 wraps the native
//     exe's stderr as ErrorRecords, which flips a PASSING build into a reported failure
//     (NativeCommandError) and starts a retry loop.
//  2. Inlining the whole JUnit/gradle test-result XML — the fleet's biggest single-turn
//     context spikes (+25k tokens in one turn).
//
// This module derives ONE canonical command per stack — quiet, exit-code-honest — plus
// the rules for running it. The same plan feeds both the merge gate (`verify_script_<id>`)
// and the builder's ticket-context prompt, so the command a builder is told to run is
// literally the command they will be merged against.
//
// Pure string logic, no Node builtins — safe as a value export through the client barrel.

import type { StackProfile } from "../types/api.js";

/** Coarse verify family, chosen from the profile's package manager / stack. */
export type VerifyStackKey = "gradle" | "maven" | "pytest" | "node" | "generic";

export interface VerifyCommandPlan {
  /** The canonical command: quiet flags applied, single invocation where possible. */
  command: string;
  stackKey: VerifyStackKey;
  /** Rules the builder must follow when running it. Rendered as bullets. */
  rules: string[];
  /**
   * What to do when it fails, instead of inlining the raw report. Always a NARROW
   * re-run — that is the "summarized failure tail": the console summary names the
   * failing test, and re-running just that test gives the detail without the XML.
   */
  onFailure: string | null;
}

/**
 * PowerShell 5.1 traps that apply to every native-exe stack. Documented in the repo
 * CLAUDE.md for years but never reached builders — that is the whole point of #124.
 */
const POWERSHELL_RULES = [
  "Do **not** append `2>&1` — PowerShell 5.1 wraps a native exe's stderr as ErrorRecords " +
    "and reports a PASSING build as failed. stderr is already captured.",
  "Do **not** pipe the run through `Select -Last N` / `head` / `tail` — piping discards " +
    "the exit code, so a real failure reads as a pass. Run the command bare and trust its exit code.",
];

/** Shared across all stacks: the raw machine-readable report is never worth its tokens. */
const NO_RAW_REPORT_RULE =
  "Do **not** read or paste the raw test-result XML/HTML report into your context — " +
  "those are the single biggest context spikes in the fleet. The console summary already " +
  "names what failed.";

/**
 * Append flags the command does not already carry — to EACH `&&`-chained segment, since a
 * flag tacked onto the end of `a && b` would only reach `b`. `applies` gates which segments
 * get them (pytest flags must not land on a non-pytest build step).
 */
function withFlags(command: string, flags: string[], applies: (segment: string) => boolean = () => true): string {
  return command
    .split(" && ")
    .map((segment) => {
      if (!applies(segment)) return segment;
      let out = segment;
      for (const flag of flags) {
        const bare = flag.split("=")[0];
        if (!new RegExp(`(^|\\s)${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(=|\\s|$)`).test(out)) {
          out = `${out} ${flag}`;
        }
      }
      return out;
    })
    .join(" && ");
}

/**
 * Collapse `<tool> test` + `<tool> build` into a single `<tool> test build` invocation.
 *
 * ONLY valid for true task runners (gradle, maven), which accept a task/goal list in one
 * invocation. Two gradle invocations mean two daemon round-trips for a build whose `build`
 * task already depends on `test`; one invocation is both faster and half the output.
 *
 * Emphatically NOT valid for script runners: `pnpm test` + `pnpm build` is NOT
 * `pnpm test build` (that passes "build" as an argument to the `test` script).
 */
function mergeTaskRunner(test: string | null, build: string | null): string | null {
  if (!test || !build) return test ?? build;
  const testParts = test.trim().split(/\s+/);
  const buildParts = build.trim().split(/\s+/);
  if (testParts[0] !== buildParts[0]) return `${test} && ${build}`;
  const tasks = [...testParts.slice(1), ...buildParts.slice(1)].filter(
    (task, i, all) => all.indexOf(task) === i,
  );
  return [testParts[0], ...tasks].join(" ");
}

/** Safe for every stack: run test, then build, only if test passed. */
function chain(test: string | null, build: string | null): string | null {
  if (!test || !build) return test ?? build;
  return `${test} && ${build}`;
}

function resolveStackKey(profile: StackProfile): VerifyStackKey {
  const pm = profile.packageManager?.toLowerCase() ?? "";
  if (pm === "gradle") return "gradle";
  if (pm === "maven") return "maven";
  if (profile.testRunner?.toLowerCase() === "pytest" || profile.stack?.toLowerCase() === "python") {
    return "pytest";
  }
  if (profile.stack?.toLowerCase() === "node") return "node";
  return "generic";
}

/**
 * Derive the canonical verify plan for a project, or null when the profile carries
 * neither a test nor a build command (nothing to verify — callers treat that as a no-op).
 */
export function deriveVerifyCommandPlan(profile: StackProfile | null | undefined): VerifyCommandPlan | null {
  if (!profile) return null;
  const test = profile.testCommand?.trim() || null;
  const build = profile.buildCommand?.trim() || null;
  const stackKey = resolveStackKey(profile);
  // Only gradle/maven can take both in one invocation; everything else must chain.
  const base =
    stackKey === "gradle" || stackKey === "maven" ? mergeTaskRunner(test, build) : chain(test, build);
  if (!base) return null;

  switch (stackKey) {
    case "gradle":
      return {
        // `--console=plain` kills the ANSI progress-bar redraw spam that dominates gradle
        // output. Deliberately NOT `--quiet`: -q also suppresses the per-test failure lines,
        // leaving only "There were failing tests, see the report" — which is exactly the
        // dead end that pushes an agent into opening the XML.
        command: withFlags(base, ["--console=plain"]),
        stackKey,
        rules: [...POWERSHELL_RULES, NO_RAW_REPORT_RULE],
        onFailure:
          "Re-run only the failing test for its stack trace: " +
          "`" + (base.split(/\s+/)[0] ?? "./gradlew") + " test --tests '<Class>.<method>' --console=plain`.",
      };
    case "maven":
      return {
        // -B (batch mode) drops the interactive download-progress spam; like gradle, no -q
        // so the surefire failure summary survives.
        command: withFlags(base, ["-B"]),
        stackKey,
        rules: [...POWERSHELL_RULES, NO_RAW_REPORT_RULE],
        onFailure:
          "Re-run only the failing test for its stack trace: `mvn -B test -Dtest='<Class>#<method>'`.",
      };
    case "pytest":
      return {
        // pytest's -q is safe (failures still print) and --tb=short IS the summarized tail.
        command: withFlags(base, ["-q", "--no-header", "--tb=short"], (s) => /\bpytest\b/.test(s)),
        stackKey,
        rules: [...POWERSHELL_RULES, NO_RAW_REPORT_RULE],
        onFailure:
          "Re-run only the failing test for its full traceback: " +
          "`python -m pytest '<path>::<test_name>' --tb=long`.",
      };
    case "node":
      return {
        // No flag injection: node test scripts are project-authored wrappers, and appending
        // reporter flags through `pnpm test` needs a `--` passthrough that varies per script.
        // The node-ts cohort was already the healthy one — the value here is the rules.
        command: base,
        stackKey,
        rules: [...POWERSHELL_RULES, NO_RAW_REPORT_RULE],
        onFailure: "Re-run only the failing test file, e.g. `pnpm exec vitest run <file>`.",
      };
    default:
      return { command: base, stackKey, rules: [...POWERSHELL_RULES, NO_RAW_REPORT_RULE], onFailure: null };
  }
}

/** Just the canonical command string, for the merge gate. "" when nothing is derivable. */
export function deriveVerifyCommand(profile: StackProfile | null | undefined): string {
  return deriveVerifyCommandPlan(profile)?.command ?? "";
}
