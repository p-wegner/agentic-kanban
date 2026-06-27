import { describe, it, expect } from "vitest";
import { evaluateCondition } from "@agentic-kanban/shared/lib/workflow-engine";

/**
 * Boundary characterization of the hand-rolled `diff_touches` glob matcher
 * (`globToRegExp` in packages/shared/src/lib/workflow-engine/conditions.ts).
 *
 * The matcher is NOT a standard glob. It compiles a tiny subset to an anchored
 * (`^…$`) RegExp:
 *   - `*`  → `[^/]*`   (a single path segment; does NOT cross `/`)
 *   - `**` → `.*`      (crosses `/`; a trailing `/` after `**` is collapsed)
 *   - `?`  → `[^/]`    (exactly one non-slash char)
 *   - the regex metacharacters `\ ^ $ . | + ( ) [ ] { }` are ESCAPED to literals
 *   - every other char (including `!`, `,`) is emitted literally
 *
 * Consequences these tests pin (some are latent product bugs, flagged inline):
 *   - `*` silently fails to match across directory boundaries.
 *   - brace alternation `{a,b}` is treated LITERALLY → never matches the way a
 *     user expects (LATENT BUG: silent no-match → "block").
 *   - leading `!` negation is treated LITERALLY, not as exclusion
 *     (LATENT BUG: silent no-match → "block").
 *
 * These are characterization assertions: they pin CURRENT behaviour so the
 * matcher's real semantics are nailed down. evaluateCondition maps a matcher
 * hit to "fire" and a miss to "block" (and missing arg / missing diffFiles to
 * "manual"), so each row exercises the matcher through its only public caller.
 */
describe("workflow-engine diff_touches glob matcher — boundary semantics", () => {
  // @covers workflow-engine.evaluate.condition [boundary]

  const files = (...f: string[]) => ({ diffFiles: f });

  type Row = {
    name: string;
    pattern: string;
    diffFiles: string[];
    expected: "fire" | "block" | "manual";
    /** Why this row fails if the matcher's behaviour changed (mutation guard). */
    mutation: string;
  };

  const rows: Row[] = [
    // ---- `*` does NOT cross `/` ------------------------------------------
    {
      name: "`*` matches within a single segment",
      pattern: "src/*",
      diffFiles: ["src/a.ts"],
      expected: "fire",
      mutation: "If `*` were compiled to something that can't match a bare segment it would block.",
    },
    {
      name: "`*` does NOT cross a `/` boundary (the defining boundary case)",
      pattern: "src/*",
      diffFiles: ["src/a/b.ts"],
      expected: "block",
      mutation:
        "If `*` were widened to `.*` (cross-slash), `src/a/b.ts` would match → fire. Pinning block detects that mutation.",
    },
    // ---- `**` DOES cross `/` --------------------------------------------
    {
      name: "`**` crosses directory boundaries",
      pattern: "packages/**",
      diffFiles: ["packages/server/src/x.ts"],
      expected: "fire",
      mutation: "If `**` were narrowed to a single segment it could not reach a nested file → block.",
    },
    {
      name: "leading `**/` is collapsed so it also matches a top-level file",
      pattern: "**/*.ts",
      diffFiles: ["a.ts"],
      expected: "fire",
      mutation:
        "The `**/` collapse means the pattern matches with zero leading dirs. Drop the collapse and `a.ts` (no slash) would block.",
    },
    {
      name: "`**/*.ts` still matches a nested file",
      pattern: "**/*.ts",
      diffFiles: ["src/deep/a.ts"],
      expected: "fire",
      mutation: "If `**` stopped crossing slashes the nested path would block.",
    },
    // ---- `?` is exactly one non-slash char ------------------------------
    {
      name: "`?` matches exactly one non-slash char",
      pattern: "src/?.ts",
      diffFiles: ["src/a.ts"],
      expected: "fire",
      mutation: "If `?` matched zero-or-more, or matched `/`, this anchored single-char case would shift.",
    },
    {
      name: "`?` does not match two chars",
      pattern: "src/?.ts",
      diffFiles: ["src/ab.ts"],
      expected: "block",
      mutation: "If `?` were `[^/]*` (greedy), `ab` would match → fire. Pinning block guards single-char semantics.",
    },
    // ---- brace alternation is LITERAL (LATENT BUG) ----------------------
    {
      name: "brace alternation `{a,b}` is treated LITERALLY, not as alternation (LATENT BUG)",
      pattern: "packages/{server,client}/**",
      diffFiles: ["packages/server/src/x.ts"],
      expected: "block",
      mutation:
        "`{` `}` are escaped to literals, so the pattern only matches a path literally containing `{server,client}`. " +
        "If brace expansion were implemented this would become fire. Characterization: pinned to current block. " +
        "BUG: a user expecting `{server,client}` alternation gets a silent no-match.",
    },
    {
      name: "brace pattern matches only the LITERAL braces text",
      pattern: "packages/{server,client}/x.ts",
      diffFiles: ["packages/{server,client}/x.ts"],
      expected: "fire",
      mutation:
        "Confirms braces compile to literal characters (not metacharacters). If they became alternation this literal path would no longer match → block.",
    },
    // ---- negation `!` is LITERAL (LATENT BUG) ---------------------------
    {
      name: "leading `!` negation is treated LITERALLY, not as exclusion (LATENT BUG)",
      pattern: "!packages/server/**",
      diffFiles: ["packages/server/src/x.ts"],
      expected: "block",
      mutation:
        "`!` is emitted literally, producing `^!packages/server/.*$`, which a path without a leading `!` cannot match. " +
        "If `!` meant 'exclude', a non-server file would fire and a server file would block — different verdict entirely. " +
        "Characterization: pinned to current block. BUG: negation is silently unsupported.",
    },
    {
      name: "literal `!` only matches a path that literally starts with `!`",
      pattern: "!keep/*",
      diffFiles: ["!keep/a.ts"],
      expected: "fire",
      mutation: "Proves `!` is a literal char. If `!` became a negation operator this would invert → block.",
    },
    // ---- full-anchor behaviour ------------------------------------------
    {
      name: "pattern is fully anchored — a prefix match does NOT count",
      pattern: "src/**",
      diffFiles: ["other/src/a.ts"],
      expected: "block",
      mutation: "If the regex were not `^`-anchored, the substring `src/a.ts` would match → fire.",
    },
    {
      name: "pattern is fully anchored — a suffix beyond the pattern does NOT count",
      pattern: "src/a.ts",
      diffFiles: ["src/a.ts.bak"],
      expected: "block",
      mutation: "If the regex were not `$`-anchored, `src/a.ts.bak` would match the `src/a.ts` prefix → fire.",
    },
    {
      name: "a literal dot is escaped (does not match an arbitrary char)",
      pattern: "src/a.ts",
      diffFiles: ["src/aXts"],
      expected: "block",
      mutation: "If `.` were left as a regex wildcard, `aXts` would match → fire. Pinning block proves `.` is escaped.",
    },
  ];

  it.each(rows)("$name", ({ pattern, diffFiles, expected }) => {
    expect(evaluateCondition(`diff_touches:${pattern}`, files(...diffFiles))).toBe(expected);
  });

  // ---- matcher short-circuits (boundary of the arg / context, not the regex) ----
  it("returns manual when the pattern arg is empty (no regex is built)", () => {
    // `diff_touches:` → arg === "" (falsy) → manual, short-circuiting the matcher.
    expect(evaluateCondition("diff_touches:", files("src/a.ts"))).toBe("manual");
  });

  it("returns manual when diffFiles is absent (signal unknown)", () => {
    expect(evaluateCondition("diff_touches:src/**", {})).toBe("manual");
  });

  it("blocks when diffFiles is present but empty (no file can match)", () => {
    // [].some(...) === false → block (distinct from the unknown-signal manual above).
    expect(evaluateCondition("diff_touches:src/**", { diffFiles: [] })).toBe("block");
  });
});
