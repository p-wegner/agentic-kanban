

/**
 * Runtime signals about a workspace's state, evaluated against edge conditions
 * for data-driven routing (conditional edges v2 / ticket #85).
 */
export interface SignalContext {
  /** Did the agent's last test run pass? (reported by the agent) */
  testsPassed?: boolean;
  /** Number of changed files in the workspace diff (computed server-side). */
  diffFilesChanged?: number;
  /** Changed file paths in the workspace diff (computed server-side). */
  diffFiles?: string[];
}

/** Split a stored condition like `diff_touches:packages/**` into base + arg. */
export function parseCondition(condition: string): { base: string; arg: string | null } {
  const idx = condition.indexOf(":");
  if (idx === -1) return { base: condition, arg: null };
  return { base: condition.slice(0, idx), arg: condition.slice(idx + 1) };
}

/** Minimal glob → RegExp supporting `**`, `*`, and `?`. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // collapse `**/`
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Evaluate an edge condition against the workspace signals.
 * - "fire"   — the condition is satisfied; the edge auto-fires.
 * - "block"  — the condition is known to be unsatisfied; the edge must not be taken.
 * - "manual" — no automatic signal applies; the agent/human chooses freely.
 */
export type ConditionVerdict = "fire" | "block" | "manual";

export function evaluateCondition(condition: string, ctx: SignalContext): ConditionVerdict {
  const { base, arg } = parseCondition(condition);
  switch (base) {
    case "manual":
      return "manual";
    case "auto_on_exit_0":
      // The agent reaches this point deliberately when the stage succeeded.
      return "fire";
    case "tests_pass":
      if (ctx.testsPassed === undefined) return "manual";
      return ctx.testsPassed ? "fire" : "block";
    case "tests_fail":
      if (ctx.testsPassed === undefined) return "manual";
      return ctx.testsPassed === false ? "fire" : "block";
    case "diff_clean":
      if (ctx.diffFilesChanged === undefined) return "manual";
      return ctx.diffFilesChanged === 0 ? "fire" : "block";
    case "diff_touches": {
      if (!arg || !ctx.diffFiles) return "manual";
      const re = globToRegExp(arg);
      return ctx.diffFiles.some((f) => re.test(f)) ? "fire" : "block";
    }
    default:
      // agent_score / custom_js / unknown — not auto-evaluable in this version.
      return "manual";
  }
}
