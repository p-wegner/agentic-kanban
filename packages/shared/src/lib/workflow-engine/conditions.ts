

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

/** Split a stored condition like `diff_touches:packages/**` into base + arg.
 *  Internal to the condition DSL — used only by evaluateCondition. */
function parseCondition(condition: string): { base: string; arg: string | null } {
  const idx = condition.indexOf(":");
  if (idx === -1) return { base: condition, arg: null };
  return { base: condition.slice(0, idx), arg: condition.slice(idx + 1) };
}

/**
 * Translate a glob body to a regex fragment (no anchoring), supporting:
 *   - `**` → `.*` (crosses `/`; trailing `/` after `**` collapsed)
 *   - `*`  → `[^/]*` (single segment, does NOT cross `/`)
 *   - `?`  → `[^/]`
 *   - `{a,b,c}` → `(a|b|c)`, each alternative itself glob-translated; nesting
 *     supported, top-level commas separate alternatives, `{}` → `()`
 *   - regex metacharacters `\ ^ $ . | + ( ) [ ] { }` escaped to literals
 */
function globBodyToRegExp(glob: string): string {
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
    } else if (c === "{") {
      // Find the matching close brace (track nesting), split top-level commas.
      let depth = 1;
      let j = i + 1;
      const alts: string[] = [];
      let cur = "";
      for (; j < glob.length && depth > 0; j++) {
        const cj = glob[j];
        if (cj === "{") {
          depth++;
          cur += cj;
        } else if (cj === "}") {
          depth--;
          if (depth === 0) break;
          cur += cj;
        } else if (cj === "," && depth === 1) {
          alts.push(cur);
          cur = "";
        } else {
          cur += cj;
        }
      }
      if (depth !== 0) {
        // Unbalanced brace — treat the `{` literally (no matching close found).
        re += "\\{";
      } else {
        alts.push(cur);
        re += `(${alts.map(globBodyToRegExp).join("|")})`;
        i = j; // advance past the matching `}`
      }
    } else if ("\\^$.|+()[]}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return re;
}

/**
 * Minimal glob → RegExp supporting `**`, `*`, `?`, `{a,b}` brace alternation,
 * and a single leading `!` negation (the path matches iff it does NOT match the
 * rest of the pattern, e.g. `!foo/**` → `^(?!foo/.*$).*$`).
 */
function globToRegExp(glob: string): RegExp {
  if (glob.startsWith("!")) {
    const body = globBodyToRegExp(glob.slice(1));
    return new RegExp(`^(?!${body}$).*$`);
  }
  return new RegExp(`^${globBodyToRegExp(glob)}$`);
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
