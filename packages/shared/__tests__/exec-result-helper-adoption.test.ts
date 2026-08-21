// @gate:always-run — walks every package's `src/` tree; it imports none of the files it judges.
/**
 * The `ExecResult` helpers are USED, and a new hand-rolled `.code` check cannot appear (#705).
 *
 * #591 introduced the one exec result shape and `execSucceeded` / `execFailedToRun` /
 * `execErrorMessage` beside it, and the shape half worked: git, docker and devcontainer all
 * report a spawn failure the same way now. The helper half did not. Measured when #705 was
 * filed: **0 non-test callers**, against 42 hand-rolled `.code === 0` / `!== 0` / `=== null`
 * comparisons — including four lines in `workspace-services.service.ts` that wrote
 * `res.code === 0` and called `execErrorMessage(res)` in the same expression.
 *
 * Unlike #569's duplicate-DTO ratchet and #513's fetch-in-effect ratchet, nothing at all stood
 * behind this one: a new adapter caller could add a 43rd hand-rolled check today and no gate
 * would notice. That absence is the actual finding of #705, and this file is it.
 *
 * **The heuristic, stated plainly.** There are no types here, so an `ExecResult` value is
 * identified structurally: a `<ident>.code === 0` style comparison in a file that imports one
 * of the exec adapters. That is deliberately narrow in one direction — a function receiving an
 * `ExecResult` as a parameter in a file that imports no adapter is invisible to this scan — and
 * it is what keeps the scan from claiming things it cannot know. It does NOT catch, and must
 * not: the plugin-script result shape (`plugin-exec.ts`, which carries `timedOut` alongside
 * `code`) is a different type with a different contract, and its callers in
 * `plugin-loop.service.ts` and the two client components are correct as written.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkPackageSources, compareRatchet } from "./helpers/guard-scan.js";

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES = ["shared", "server", "client", "mcp-server"];

/** A file that imports one of these is a file that can hold an `ExecResult`. */
const IMPORTS_EXEC_ADAPTER = /from "(?:@agentic-kanban\/shared\/lib\/)?(?:\.\.?\/)*(?:lib\/)?(git-exec|docker-exec|devcontainer-exec|exec-result)(?:\.js)?"/;

/** `x.code === 0` / `x.code !== 0` / `x.code === null` / `x.code !== null`. */
const HAND_ROLLED = /\b([A-Za-z_$][\w$]*)\.code\s*(?:===|!==)\s*(?:0|null)\b/g;

/**
 * Sites allowed to compare `.code` directly, each with WHY. Empty today, and that is the
 * whole point of #705's migration — but the map exists rather than a bare `toEqual([])`
 * because a legitimate case is easy to imagine (an adapter deciding what to put IN the
 * field), and when one appears it should arrive with an argument attached rather than by
 * someone deleting the assertion.
 */
const ALLOWED: Record<string, string> = {};

function scan(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const pkg of PACKAGES) {
    for (const file of walkPackageSources(path.join(packagesRoot, pkg, "src"))) {
      const source = fs.readFileSync(file, "utf-8");
      if (!IMPORTS_EXEC_ADAPTER.test(source)) continue;
      const hits = [...source.matchAll(HAND_ROLLED)].length;
      if (hits > 0) counts[path.relative(packagesRoot, file).replace(/\\/g, "/")] = hits;
    }
  }
  return counts;
}

/** Non-test callers of a helper, so "it is exported" cannot be mistaken for "it is used". */
function callersOf(helper: string): string[] {
  const callSite = new RegExp(`\\b${helper}\\s*\\(`);
  const files: string[] = [];
  for (const pkg of PACKAGES) {
    for (const file of walkPackageSources(path.join(packagesRoot, pkg, "src"))) {
      const source = fs.readFileSync(file, "utf-8");
      // The declaration itself is not a call site.
      if (file.endsWith(path.join("lib", "exec-result.ts"))) continue;
      if (callSite.test(source)) files.push(path.relative(packagesRoot, file).replace(/\\/g, "/"));
    }
  }
  return files;
}

describe("ExecResult helpers are adopted, and hand-rolled .code checks cannot come back (#705)", () => {
  it("has no hand-rolled .code comparison in a file that imports an exec adapter", () => {
    const { over, stale } = compareRatchet(ALLOWED, scan());

    expect(
      over,
      over.length === 0
        ? ""
        : [
            "A `.code === 0` / `!== 0` / `=== null` comparison on what is almost certainly an",
            "ExecResult. Use the helper that says what you mean:",
            "",
            "  x.code === 0     -> execSucceeded(x)",
            "  x.code !== 0     -> !execSucceeded(x)",
            "  x.code === null  -> execFailedToRun(x)      (never spawned, or signal-killed)",
            "  `${x.error}`     -> execErrorMessage(x)     (stderr first, never empty)",
            "",
            "If this site genuinely must read the raw field, add it to ALLOWED with the reason.",
          ].join("\n"),
    ).toEqual([]);

    // A stale entry here would silently excuse whatever lands at that path next.
    expect(stale, "ALLOWED names a site that no longer compares .code — delete the entry").toEqual([]);
  });

  it("execSucceeded has real non-test callers — #705 was filed because it had none", () => {
    // The ratchet above is satisfied by a codebase that calls NOTHING, which is exactly the
    // state #591 left behind: no hand-rolled checks would be reported if there were no exec
    // callers at all. This is the other half, and it is what actually fails if someone
    // migrates the call sites back.
    const callers = callersOf("execSucceeded");
    expect(callers.length, `execSucceeded call sites: ${callers.join(", ") || "(none)"}`).toBeGreaterThanOrEqual(10);
  });

  it("execErrorMessage and execFailedToRun are used too, so the trio is not one adopted helper", () => {
    // Floors, not targets, and deliberately set at the CURRENT counts rather than aspirational
    // ones: 3 files call execErrorMessage (agent, devcontainer-workspace, workspace-services)
    // and 1 calls execFailedToRun (git-exec's memo, which is the only place asking "did this
    // ever run?" rather than "did it succeed?"). Both are genuinely small because the question
    // they answer is rarer than "did it exit 0", not because adoption stalled — the sweep for
    // #705 found no further site formatting an ExecResult failure by hand. Raise a floor when a
    // migration raises the count; do not lower one to make a red gate green.
    expect(callersOf("execErrorMessage").length).toBeGreaterThanOrEqual(3);
    expect(callersOf("execFailedToRun").length).toBeGreaterThanOrEqual(1);
  });
});
