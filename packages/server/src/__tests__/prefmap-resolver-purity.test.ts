// @gate:always-run — walks the whole server source tree; imports nothing it checks.
/**
 * #586 — `prefMap resolver` is a named kind: `resolveX(prefMap, ctx) → one decision value`,
 * pure and synchronous.
 *
 * Six of them exist (`resolveStartPolicy`, `resolveEffectiveProviderProfile`,
 * `resolveProviderConfig`, `resolveProjectRuntimeConfig`, `resolveAgentSettings`,
 * `resolveConductorSchedule`); two are documented SSOTs (decision 008, the provider default)
 * and one is guarded — but the KIND had no rule, while the same `resolve*` prefix is also worn
 * by ~10 async db-reading functions that are ordinary services. So the prefix alone told a
 * reader nothing.
 *
 * The rule this pins: **first parameter named `prefMap` ⇒ pure.** No `await`, and no call into
 * `db`/`repositories/` — the prefs were already read by the caller, which is the entire point
 * (it is what makes these unit-testable and what lets one decision have one source).
 *
 * The check is per-FUNCTION, not per-file, deliberately: `agent-settings.service.ts` and
 * `project-runtime-config.service.ts` each hold a pure prefMap resolver beside db-reading
 * service functions, and a file-level import scan would have to fail them or be relaxed into
 * uselessness.
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
const DECLARATION = /export function (resolve\w+)\(\s*\n?\s*prefMap/g;

interface Resolver {
  file: string;
  name: string;
  slice: string;
  persistenceBindings: string[];
}

function collectResolvers(): Resolver[] {
  const found: Resolver[] = [];
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

describe("prefMap resolvers are pure (#586)", () => {
  const resolvers = collectResolvers();

  it("finds the kind at all — a rule over an empty set guards nothing", () => {
    expect(resolvers.length).toBeGreaterThanOrEqual(6);
  });

  it("is synchronous — a prefMap resolver that awaits is reading state its caller already read", () => {
    const async = resolvers.filter((r) => /^export async function/.test(r.slice) || /\bawait\b/.test(r.slice));
    expect(async.map((r) => `${r.file}:${r.name}`)).toEqual([]);
  });

  it("calls nothing from `db/` or `repositories/`", () => {
    const impure = resolvers.flatMap((r) =>
      r.persistenceBindings
        .filter((binding) => new RegExp(`\\b${binding}\\s*\\(`).test(r.slice))
        .map((binding) => `${r.file}:${r.name} calls ${binding}`),
    );
    expect(impure).toEqual([]);
  });
});
