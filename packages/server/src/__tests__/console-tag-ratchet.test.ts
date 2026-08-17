// @gate:always-run — scans the services/ and startup/ trees; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Server logs carry a `[tag]` prefix (#616).
 *
 * There is no logger module and no plan for one, so the convention IS the interface:
 * 732 tagged lines vs 22 untagged across `services/` + `startup/`, in 98 distinct tags.
 * The prefix is what makes a ~1600-line server log greppable per subsystem, which is why
 * an untagged line is not a style nit — it is a line nobody will find later.
 *
 * A RATCHET, not a ban, because a good share of the 22 survivors are legitimate:
 * `console.warn(warning)` / `console.warn(message)` forward a string that was already
 * tagged by its caller, and re-tagging there would double the prefix. Banning outright
 * would force those to be worked around; capping them stops the population growing while
 * leaving the judgement per-site.
 */
const SRC = path.join(import.meta.dirname!, "..");
const SCAN_DIRS = ["services", "startup"];

/** `console.<level>(` whose first argument does NOT open with a `[tag]` literal. */
const CONSOLE_CALL = /console\.(?:log|warn|error|info|debug)\(\s*(.)/;
const TAGGED = /console\.\w+\(\s*(?:`|"|')\[[^\]]+\]/;

function tsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : tsFiles(full);
    return e.name.endsWith(".ts") && !e.name.includes(".test.") ? [full] : [];
  });
}

function untaggedCount(): { total: number; sample: string[] } {
  let total = 0;
  const sample: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of tsFiles(path.join(SRC, dir))) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!CONSOLE_CALL.test(line) || TAGGED.test(line)) return;
        total++;
        if (sample.length < 10) {
          sample.push(`${path.relative(SRC, file).replaceAll("\\", "/")}:${i + 1}`);
        }
      });
    }
  }
  return { total, sample };
}

/** Untagged `console.*` calls in services/ + startup/ as of #616. Only ever LOWER this. */
const BASELINE_UNTAGGED = 22;

describe("server console logs carry a [tag] prefix (#616)", () => {
  const { total, sample } = untaggedCount();

  it("sees the console calls at all, so the scan cannot pass vacuously", () => {
    // >700 tagged calls exist; if the tagged pattern stops matching, `total` would balloon
    // rather than vanish — so pin the population it is measuring against instead.
    const anyConsole = SCAN_DIRS.flatMap((d) => tsFiles(path.join(SRC, d)))
      .map((f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => CONSOLE_CALL.test(l)).length)
      .reduce((a, b) => a + b, 0);
    expect(anyConsole).toBeGreaterThan(400);
  });

  it("does not add a new untagged console call", () => {
    expect(
      total,
      `Untagged console calls rose to ${total} (baseline ${BASELINE_UNTAGGED}).\n` +
        `Use console.<level>("[<tag>] …") with the file's existing subsystem tag.\n` +
        `First few untagged: ${sample.join(", ")}`,
    ).toBeLessThanOrEqual(BASELINE_UNTAGGED);
  });

  it("the baseline is not stale (lower it when calls are tagged)", () => {
    expect(
      total,
      `Only ${total} untagged calls remain — lower BASELINE_UNTAGGED to ${total}.`,
    ).toBeGreaterThanOrEqual(BASELINE_UNTAGGED);
  });
});
