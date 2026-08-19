// @gate:always-run — reads docs/env-vars.md, a file outside any src tree; imports nothing
// it checks beyond the registry itself.
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  KANBAN_ENV,
  readBoardEnv,
  __resetEnvDeprecationWarningsForTests,
} from "../lib/env-registry.js";

/**
 * The registry and its documentation cannot drift (#615).
 *
 * The problem this replaces is not a missing doc — it is that a doc is a SEPARATE artifact
 * nobody updates. Eight `KANBAN_*` vars were undocumented, and the way you found a
 * variable at all was to grep for `process.env`. So the renamed set lives in code as data
 * and the page is checked against it: a new registered variable has no way to reach master
 * undocumented, and a row cannot outlive its variable.
 */
const repoRoot = path.join(import.meta.dirname!, "..", "..", "..", "..");
const docPath = path.join(repoRoot, "docs", "env-vars.md");
const doc = fs.readFileSync(docPath, "utf8");

describe("env registry ↔ docs/env-vars.md parity (#615)", () => {
  beforeEach(__resetEnvDeprecationWarningsForTests);

  it("every registered variable is documented, with its legacy name", () => {
    const missing: string[] = [];
    for (const entry of KANBAN_ENV) {
      if (!doc.includes(`\`${entry.name}\``)) missing.push(entry.name);
      else if (entry.legacyAlias && !doc.includes(`\`${entry.legacyAlias}\``)) {
        missing.push(`${entry.name} (legacy ${entry.legacyAlias} undocumented)`);
      }
    }
    expect(missing, `add a row to docs/env-vars.md for:\n${missing.join("\n")}`).toEqual([]);
  });

  it("every canonical name obeys the KANBAN_ prefix rule the doc states", () => {
    const offenders = KANBAN_ENV.filter((e) => !e.name.startsWith("KANBAN_")).map((e) => e.name);
    expect(offenders).toEqual([]);
  });

  it("no legacy alias is itself KANBAN_-prefixed, and none collides with a canonical name", () => {
    // A `KANBAN_*` legacy alias would mean the rename went sideways rather than forward,
    // and an alias equal to some other var's canonical name would make one shadow the other.
    const canonical = new Set(KANBAN_ENV.map((e) => e.name));
    for (const entry of KANBAN_ENV) {
      if (!entry.legacyAlias) continue;
      expect(entry.legacyAlias.startsWith("KANBAN_"), `${entry.legacyAlias} is already prefixed`).toBe(false);
      expect(canonical.has(entry.legacyAlias), `${entry.legacyAlias} collides with a canonical name`).toBe(false);
    }
  });

  it("the doc documents the naming rule itself", () => {
    expect(doc).toContain("`KANBAN_*`");
  });
});

describe("readBoardEnv precedence and deprecation (#615)", () => {
  beforeEach(__resetEnvDeprecationWarningsForTests);

  const sample = KANBAN_ENV.find((e) => e.legacyAlias)!;

  it("prefers the canonical name over the legacy one", () => {
    const warnings: string[] = [];
    const value = readBoardEnv(
      sample.name,
      { [sample.name]: "new", [sample.legacyAlias!]: "old" },
      (m) => warnings.push(m),
    );
    expect(value).toBe("new");
    // No warning: the operator has already migrated, and nagging them would be noise.
    expect(warnings).toEqual([]);
  });

  it("falls back to the legacy name and warns ONCE, naming the replacement", () => {
    const warnings: string[] = [];
    const env = { [sample.legacyAlias!]: "old" };
    expect(readBoardEnv(sample.name, env, (m) => warnings.push(m))).toBe("old");
    expect(readBoardEnv(sample.name, env, (m) => warnings.push(m))).toBe("old");
    // Once, not per read — this sits on a request path in the slow-request case.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(sample.legacyAlias!);
    expect(warnings[0]).toContain(sample.name);
  });

  it("treats empty-string as unset, under both names", () => {
    // Every caller already meant this; leaving it to them is how one of them forgets.
    expect(readBoardEnv(sample.name, { [sample.name]: "", [sample.legacyAlias!]: "" }, () => {})).toBeUndefined();
  });

  it("throws for an unregistered name rather than silently reading it", () => {
    expect(() => readBoardEnv("KANBAN_NOT_REGISTERED", {}, () => {})).toThrow(/not in KANBAN_ENV/);
  });
});
