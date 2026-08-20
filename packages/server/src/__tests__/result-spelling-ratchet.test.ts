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

const SUCCESS_SPELLING_CAP = 38;
/**
 * 168 -> 169 (#595). NOT a new inline body: `routes/internal-monitor.ts` MOVED here from
 * `startup/monitor-setup.ts`, carrying its unchanged `c.json({ error: "resource sweep
 * unavailable" }, 503)`. It was uncounted before only because this scan covers `routes/`
 * and `startup/` sat outside it — the same blind spot #595 found in depcruise, showing up
 * here too. Raising a ratchet is otherwise forbidden; this is an accounting correction for
 * a population that grew by relocation, and the guard is unchanged for new code.
 */
const INLINE_ROUTE_ERROR_CAP = 169;

function tsFiles(dir: string, skip: (name: string, full: string) => boolean = () => false): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" || skip(e.name, full) ? [] : tsFiles(full, skip);
    return e.name.endsWith(".ts") && !e.name.includes(".test.") ? [full] : [];
  });
}

function count(files: string[], re: RegExp): { total: number; byFile: Array<[string, number]> } {
  const byFile: Array<[string, number]> = [];
  let total = 0;
  for (const f of files) {
    const n = (fs.readFileSync(f, "utf8").match(re) ?? []).length;
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
