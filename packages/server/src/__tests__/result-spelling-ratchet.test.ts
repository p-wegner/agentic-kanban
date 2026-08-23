// @gate:always-run — walks the services/lib/repositories trees and the routes tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * #617 (ring R17) — TWO spellings for the same idea, capped so they can only shrink.
 *
 * 1. **Result objects.** The house spelling is `{ ok: false, reason }` (12 services + 4 lib
 *    + 4 routes). A minority spell the same thing `{ success: false, error }`. Neither is
 *    wrong on its own; having both means a caller must read the callee to know which field
 *    to branch on. There is no `Result<T>` type, and introducing one across ~50 sites is a
 *    bigger change than this ticket — so the minority spelling is FROZEN instead: it may
 *    shrink, never grow.
 *
 *    Deliberately NOT counted: `shared/lib/agent-stream/*`, where `success` is a field name
 *    in a PROVIDER's JSON (Claude/Codex/Pi stream events). Renaming those would be a lie
 *    about the wire.
 *
 * 2. **Route error bodies.** `error-handler.ts` maps the domain-code vocabulary to HTTP in
 *    ONE place, yet 168 route sites still build `c.json({ error: … }, 4xx)` inline — the
 *    older style, which is how a status code drifts from what the middleware would have
 *    chosen. Frozen at today's count; new routes throw a domain error instead.
 *
 * Both are RATCHETS, not bans: an inline body is sometimes genuinely right (a validation
 * message with no domain-error class behind it), and forcing a workaround would be worse
 * than capping the population.
 */
const SERVER_SRC = path.join(import.meta.dirname!, "..");
const SHARED_LIB = path.join(SERVER_SRC, "..", "..", "shared", "src", "lib");

// 38 -> 35: the old cap counted 3 PROSE mentions (see stripComments below). Lowered to the
// honest code-only count rather than left slack — slack in a shrink-only ratchet is budget.
const SUCCESS_SPELLING_CAP = 35;
/**
 * 168 -> 169 (#595). NOT a new inline body: `routes/internal-monitor.ts` MOVED here from
 * `startup/monitor-setup.ts`, carrying its unchanged `c.json({ error: "resource sweep
 * unavailable" }, 503)`. It was uncounted before only because this scan covers `routes/`
 * and `startup/` sat outside it — the same blind spot #595 found in depcruise, showing up
 * here too. Raising a ratchet is otherwise forbidden; this is an accounting correction for
 * a population that grew by relocation, and the guard is unchanged for new code.
 */
// 169 -> 167, same reason: two of those were comments about the pattern, not instances of it.
/**
 * 167 -> 170 (#805): the SAME relocation case as #595 above, and verified as one rather
 * than assumed. #805 moved `POST /api/workspaces/:id/review` out of
 * `startup/route-setup.ts` — which this scan does not cover — into
 * `routes/workspace-review.ts`, which it does. Its three inline bodies are byte-identical
 * to the pre-move ones (`git show 009771c859^:packages/server/src/startup/route-setup.ts`,
 * lines 43/57/71 vs 49/63/79 today), so the population grew by relocation and not by new
 * code. Raising a ratchet is otherwise forbidden.
 *
 * These three ARE convertible to the central `error-handler.ts` mapping — they hand-map
 * NOT_FOUND/BAD_REQUEST/INTERNAL, which is precisely what the middleware exists to do.
 * That conversion is filed rather than done here, so this stays an accounting correction
 * and not a silently-accepted three-site budget.
 */
const INLINE_ROUTE_ERROR_CAP = 170;

function tsFiles(dir: string, skip: (name: string, full: string) => boolean = () => false): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" || skip(e.name, full) ? [] : tsFiles(full, skip);
    return e.name.endsWith(".ts") && !e.name.includes(".test.") ? [full] : [];
  });
}

/**
 * Strip comments before counting. Both caps below are about the SPELLING A CALLER MUST
 * BRANCH ON, which a comment is not — and this scan counted prose for as long as it has
 * existed. It surfaced when #735 wrote the sentence "the HTTP layer answers `{success:true}`
 * either way" into `project-worktrees.service.ts` and pushed the cap from 38 to 39: a
 * comment ABOUT the spelling read as a new instance of it. Two pre-existing matches
 * (`session-exit-stats.ts`, `workspace-launch-failures.service.ts`) are also prose, so the
 * old caps were partly counting documentation.
 *
 * Same defect class as #707's "documented" check, which accepted any backticked mention of
 * a variable as a doc row until #734 tightened it. A guard that cannot tell code from prose
 * punishes explaining yourself, which is the opposite of what these ratchets are for.
 *
 * Deliberately a text strip, not an AST pass: this suite counts a SPELLING and never needs
 * to resolve a symbol, so a parse would buy nothing. A `//` inside a string literal (a URL)
 * is the known imprecision; it can only UNDER-count, and undercounting a shrink-only cap
 * cannot let a new spelling in unnoticed — the cap moves down with it.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function count(files: string[], re: RegExp): { total: number; byFile: Array<[string, number]> } {
  const byFile: Array<[string, number]> = [];
  let total = 0;
  for (const f of files) {
    const n = (stripComments(fs.readFileSync(f, "utf8")).match(re) ?? []).length;
    if (n > 0) {
      byFile.push([path.relative(SERVER_SRC, f).split(path.sep).join("/"), n]);
      total += n;
    }
  }
  return { total, byFile };
}

describe("result-spelling ratchet (#617)", () => {
  it(`the {success} result spelling stays at or below ${SUCCESS_SPELLING_CAP}`, () => {
    const files = [
      ...tsFiles(path.join(SERVER_SRC, "services")),
      ...tsFiles(path.join(SERVER_SRC, "lib")),
      ...tsFiles(path.join(SERVER_SRC, "repositories")),
      // `agent-stream` is a provider's wire shape, not ours.
      ...tsFiles(SHARED_LIB, (name) => name === "agent-stream"),
    ];
    const { total, byFile } = count(files, /\bsuccess:\s*(?:true|false)/g);
    expect({ total, byFile }).toMatchObject({ total: expect.any(Number) });
    expect(total).toBeLessThanOrEqual(SUCCESS_SPELLING_CAP);
  });

  it(`inline c.json({ error }) route bodies stay at or below ${INLINE_ROUTE_ERROR_CAP}`, () => {
    const { total } = count(tsFiles(path.join(SERVER_SRC, "routes")), /c\.json\(\{\s*error/g);
    expect(total).toBeLessThanOrEqual(INLINE_ROUTE_ERROR_CAP);
  });
});
