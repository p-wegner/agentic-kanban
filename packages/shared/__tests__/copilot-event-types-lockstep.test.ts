import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COPILOT_RESULT_TYPES,
  COPILOT_SESSION_START_TYPES,
  COPILOT_TOOL_RESULT_TYPES,
  COPILOT_TOOL_USE_TYPES,
} from "../src/lib/agent-stream/copilot-event-types.js";

/**
 * Architecture gate (arch-review #892): the Copilot event-type name sets must
 * have exactly ONE definition.
 *
 * Two parsers consume Copilot JSONL — the live stream parser
 * (`src/lib/agent-stream/copilot.ts`) and the offline session-summary parser
 * (`src/lib/session-summary.ts`). They used to each define their own copy of
 * `COPILOT_SESSION_START_TYPES` / `COPILOT_RESULT_TYPES`, and the copies had
 * already drifted. The failure mode is silent: a CLI version bump teaches one
 * parser a new `session_*` event name but not the other, so the live terminal
 * keeps streaming tokens while the summary panel/CLI shows zero — with no error.
 *
 * The fix routes both files through `copilot-event-types.ts`. This test guards
 * the de-fork two ways: the imported sets are the SAME object at runtime, and a
 * source scan fails if either consumer re-introduces a private `new Set([...])`
 * for these constants (i.e. re-forks).
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

function readSrc(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, "src", relPath), "utf8");
}

const CONST_NAMES = [
  "COPILOT_SESSION_START_TYPES",
  "COPILOT_RESULT_TYPES",
  "COPILOT_TOOL_USE_TYPES",
  "COPILOT_TOOL_RESULT_TYPES",
] as const;

/**
 * Files scanned against re-forking the sets. Since #951 the offline
 * session-summary parser no longer classifies Copilot events itself — it
 * consumes `parseCopilotEvent` — so only copilot.ts is REQUIRED to import the
 * sets, but session-summary is still scanned so a private copy can't creep back.
 */
const IMPORTERS = ["lib/agent-stream/copilot.ts"];
const CONSUMERS = ["lib/agent-stream/copilot.ts", "lib/session-summary.ts"];

describe("Copilot event-type sets stay in lockstep (#892)", () => {
  it("the shared module exports the expected normalized event names", () => {
    // Sanity: these are normalized (lowercased, dashes→underscores) so the
    // `normalizedType()` lookups in both parsers hit them.
    expect(COPILOT_SESSION_START_TYPES).toContain("session.started");
    expect(COPILOT_SESSION_START_TYPES).toContain("session_created");
    expect(COPILOT_RESULT_TYPES).toContain("turn.completed");
    expect(COPILOT_TOOL_USE_TYPES).toContain("tool_call.started");
    expect(COPILOT_TOOL_RESULT_TYPES).toContain("tool.completed");

    // No drift via casing/dashes: every entry is already normalized.
    for (const set of [
      COPILOT_SESSION_START_TYPES,
      COPILOT_RESULT_TYPES,
      COPILOT_TOOL_USE_TYPES,
      COPILOT_TOOL_RESULT_TYPES,
    ]) {
      for (const name of set) {
        expect(name).toBe(name.toLowerCase().replace(/-/g, "_"));
      }
    }
  });

  it("the consumer source files import the sets, never redefine them", () => {
    for (const importer of IMPORTERS) {
      expect(
        readSrc(importer).includes("copilot-event-types"),
        `${importer} must import the Copilot event-type sets from agent-stream/copilot-event-types`,
      ).toBe(true);
    }
    // Session-summary must consume the canonical Copilot parser, not re-parse (#951).
    expect(
      readSrc("lib/session-summary.ts").includes("parseCopilotEvent"),
      "lib/session-summary.ts must consume parseCopilotEvent from agent-stream/copilot",
    ).toBe(true);

    for (const consumer of CONSUMERS) {
      const src = readSrc(consumer);
      for (const name of CONST_NAMES) {
        // A re-fork would look like `const COPILOT_*_TYPES = new Set(...`.
        const reDefinition = new RegExp(`(const|let|var)\\s+${name}\\s*=\\s*new Set`);
        expect(
          reDefinition.test(src),
          `${consumer} re-defines ${name} locally — it must import it from ` +
            `agent-stream/copilot-event-types to stay in lockstep (#892).`,
        ).toBe(false);
      }
    }
  });

  it("copilot-event-types.ts is the single definition site", () => {
    const owner = readSrc("lib/agent-stream/copilot-event-types.ts");
    for (const name of CONST_NAMES) {
      const exportDef = new RegExp(`export const ${name}\\s*=\\s*new Set`);
      expect(
        exportDef.test(owner),
        `copilot-event-types.ts must export ${name}`,
      ).toBe(true);
    }
  });
});
