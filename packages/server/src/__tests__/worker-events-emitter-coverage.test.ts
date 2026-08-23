// @gate:always-run — reads route/service SOURCE TEXT outside its own import graph (#774).
//
// The point of this guard: `worker-events.service.ts` declares eleven event types but #774
// can only EMIT six of them, because the call sites for the other five live in files it does
// not own (`fleet-listener.service.ts` for the WebSocket lifecycle, `agent-remote.service.ts`
// for assignment and exit, `worker-incoming-refs.service.ts` for the held-ref sweep, and the
// registry for an effective-status transition).
//
// A comment saying so would rot the day someone wires one up, and the failure mode is
// specific and bad: a declared-but-unemitted type reads to a reader (and to the panel's
// legend) as a thing the board records. So the split is DATA (`EMITTED_TYPES` /
// `UNEMITTED_TYPES`) and this test pins it against what the routes actually write.
//
// It fails in both directions: emitting a type listed as unemitted, and listing a type as
// emitted that no route writes. The second half is what stops the honest disclosure from
// quietly becoming a false claim.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMITTED_TYPES,
  UNEMITTED_TYPES,
  WORKER_EVENT_TYPES,
  type WorkerEventType,
} from "../services/worker-events.service.js";

const SERVER_SRC = resolve(__dirname, "..");

/** Every file that is allowed to write a worker event today. */
const EMITTER_FILES = ["routes/workers.ts"];

/**
 * Which types a source text actually writes, matched on the `type:` property of a
 * `recordWorkerEvent({...})` call. Exported shape kept trivial so the test below can run it
 * over a SYNTHETIC source and prove the detection works — a guard nobody has watched fail is
 * not a guard.
 */
export function emittedTypesIn(source: string): Set<string> {
  const found = new Set<string>();
  const re = /type:\s*"([a-z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if ((WORKER_EVENT_TYPES as readonly string[]).includes(m[1]!)) found.add(m[1]!);
  }
  return found;
}

describe("worker event emitter coverage", () => {
  it("EMITTED and UNEMITTED partition the vocabulary exactly", () => {
    const declared = [...EMITTED_TYPES, ...UNEMITTED_TYPES].sort();
    expect(declared).toEqual([...WORKER_EVENT_TYPES].sort());
    // No type may be in both lists — that would make the split meaningless.
    const overlap = EMITTED_TYPES.filter((t) => (UNEMITTED_TYPES as readonly string[]).includes(t));
    expect(overlap).toEqual([]);
  });

  it("every type declared EMITTED is actually written by a route", () => {
    const written = new Set<string>();
    for (const rel of EMITTER_FILES) {
      for (const t of emittedTypesIn(readFileSync(resolve(SERVER_SRC, rel), "utf8"))) written.add(t);
    }
    const claimedButAbsent = EMITTED_TYPES.filter((t) => !written.has(t));
    expect(claimedButAbsent, "declared as emitted but no route writes it").toEqual([]);
  });

  it("no type declared UNEMITTED is written anywhere yet", () => {
    const written = new Set<string>();
    for (const rel of EMITTER_FILES) {
      for (const t of emittedTypesIn(readFileSync(resolve(SERVER_SRC, rel), "utf8"))) written.add(t);
    }
    const wiredButUndeclared = UNEMITTED_TYPES.filter((t) => written.has(t));
    expect(
      wiredButUndeclared,
      "an emitter appeared for a type still listed as UNEMITTED — move it to EMITTED_TYPES",
    ).toEqual([]);
  });

  it("the detector this guard rests on really sees a violation", () => {
    // The guard above is only worth its keep if `emittedTypesIn` finds what it claims to.
    // Written in the exact form the violation would take, and asserted to be caught.
    const violating = `
      void recordWorkerEvent({
        database,
        workerId: id,
        type: "disconnected",
        summary: "socket closed",
      });
    `;
    const found = emittedTypesIn(violating);
    expect(found.has("disconnected")).toBe(true);
    expect(UNEMITTED_TYPES.includes("disconnected" as WorkerEventType)).toBe(true);
    // And it does not invent types that are not in the vocabulary.
    expect(emittedTypesIn(`type: "not_a_worker_event"`).size).toBe(0);
  });
});
