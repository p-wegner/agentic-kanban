// @gate:always-run — walks the whole server source tree; imports nothing it checks.
/**
 * #585 — `decision function` is a named kind: a pure, synchronous verdict co-located with the
 * executor that acts on it — `decideX(row) -> {action, reason}`, `classifyX(...) -> union`,
 * `shouldX(input) -> boolean`.
 *
 * At least a dozen live in `startup/` alone (`decideBornBlockedAction`, `classifyWorktree`,
 * `classifyQuotaBlock`, `shouldStartHealthRefresh`, `shouldDeferForContention`, the exit and
 * rate-limit classifiers). They all have the same shape and the same reason for existing: the
 * verdict is separable from the sweep, so it can be unit-tested exhaustively while the sweep
 * around it needs a database. That property is the whole value of the kind, and nothing was
 * protecting it — the first `decideX` that awaits a repository silently converts a table of
 * cheap cases into a fixture-heavy integration test, and no reviewer would see the kind change.
 *
 * Per-FUNCTION, not per-file: a decision function shares its module with the executor that
 * calls it, and that executor legitimately reads the database.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  walkPackageSources,
  sliceTopLevelFunction,
  importedBindingsFrom,
} from "../../../shared/__tests__/helpers/guard-scan.js";

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSISTENCE = /(^|\/)db(\/|\.js$)|repositories\//;
const DECLARATION = /^export function ((?:decide|classify|should)[A-Z]\w*)\(/gm;

interface Decision {
  file: string;
  name: string;
  slice: string;
  persistenceBindings: string[];
}

function collectDecisions(): Decision[] {
  const found: Decision[] = [];
  for (const file of walkPackageSources(serverSrc)) {
    const source = fs.readFileSync(file, "utf-8");
    const bindings = importedBindingsFrom(source, PERSISTENCE);
    for (const m of source.matchAll(DECLARATION)) {
      const slice = sliceTopLevelFunction(source, m[1]);
      if (slice === null) continue;
      found.push({
        file: path.relative(serverSrc, file).replace(/\\/g, "/"),
        name: m[1],
        slice,
        persistenceBindings: bindings,
      });
    }
  }
  return found;
}

describe("decision functions are pure verdicts (#585)", () => {
  const decisions = collectDecisions();

  it("finds the kind at all — a rule over an empty set guards nothing", () => {
    expect(decisions.length).toBeGreaterThanOrEqual(12);
  });

  it("is synchronous: `export async function decide*` is a service wearing the name", () => {
    const awaiting = decisions.filter((d) => /\bawait\b/.test(d.slice));
    expect(awaiting.map((d) => `${d.file}:${d.name}`)).toEqual([]);
  });

  it("touches no `db/` or `repositories/` binding", () => {
    const impure = decisions.flatMap((d) =>
      d.persistenceBindings
        .filter((binding) => new RegExp("\\b" + binding + "\\s*\\(").test(d.slice))
        .map((binding) => `${d.file}:${d.name} calls ${binding}`),
    );
    expect(impure).toEqual([]);
  });

  it("the `async` variant is excluded by construction, so the count is not inflated by services", () => {
    expect(decisions.every((d) => d.slice.startsWith("export function "))).toBe(true);
  });
});
