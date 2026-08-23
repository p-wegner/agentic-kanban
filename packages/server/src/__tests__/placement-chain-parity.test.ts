// @gate:always-run — reads the resolver's SOURCE TEXT and a docs page; imports neither (#755).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { PLACEMENT_CHECK_CHAIN } from "../services/placement-explain.service.js";

/**
 * #755 — "why was #N not dispatched" is answered by `placement-explain.service.ts`,
 * which describes a decision it deliberately does NOT own: the ordered guard chain
 * inside `resolveWorkerPlacement` (`worker-fleet.service.ts`).
 *
 * That is the drift risk the ticket names. An explanation reconstructed beside the
 * code it explains is correct exactly until someone reorders, inserts or removes a
 * guard — and then it is confidently wrong, which is worse than absent. There are
 * two defences, and this is the static one:
 *
 *   - RUNTIME: every `explainPlacement` result carries `agreesWithResolver`, from a
 *     read-only dry run of the real resolver. A disagreement is reported in the
 *     payload rather than hidden.
 *   - STATIC (here): the chain's ORDER is re-derived from the resolver's own source
 *     text and from `docs/worker-fleet.md` §7's numbered checklist. Any of the three
 *     moving independently fails this test, and the failure names which two disagree.
 *
 * This is a text match, not a proof: a guard rewritten to no longer contain its
 * marker fails loudly (the marker goes missing), but a guard whose CONDITION changes
 * while its marker survives does not. That residual is covered by the runtime
 * cross-check, not here.
 */

const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const repoRoot = path.join(packagesRoot, "..");
const RESOLVER_FILE = path.join(packagesRoot, "server", "src", "services", "worker-fleet.service.ts");
const DOC_FILE = path.join(repoRoot, "docs", "worker-fleet.md");

/** The body of `resolveWorkerPlacement`, from its declaration to the next top-level export. */
function resolverBody(): string {
  const source = fs.readFileSync(RESOLVER_FILE, "utf8");
  const start = source.indexOf("export async function resolveWorkerPlacement");
  expect(start, "resolveWorkerPlacement not found in worker-fleet.service.ts").toBeGreaterThan(-1);
  const end = source.indexOf("\nexport ", start + 10);
  return source.slice(start, end === -1 ? source.length : end);
}

/** The numbered items of docs/worker-fleet.md § "Nothing dispatches — what to check". */
function docChecklistItems(): string[] {
  const doc = fs.readFileSync(DOC_FILE, "utf8");
  const heading = doc.indexOf("Nothing dispatches");
  expect(heading, "the 'Nothing dispatches' section is gone from docs/worker-fleet.md").toBeGreaterThan(-1);
  const nextHeading = doc.indexOf("\n## ", heading);
  const section = doc.slice(heading, nextHeading === -1 ? doc.length : nextHeading);
  // Split on top-level "N. " list markers; each item runs to the next one.
  const items: string[] = [];
  const re = /^(\d+)\.\s/gm;
  const starts: Array<{ n: number; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) starts.push({ n: Number(m[1]), at: m.index });
  for (const [i, s] of starts.entries()) {
    items.push(section.slice(s.at, starts[i + 1]?.at ?? section.length));
  }
  return items;
}

describe("placement explanation chain parity (#755)", () => {
  it("declares exactly the checks the resolver applies, in the resolver's order", () => {
    const body = resolverBody();
    const positions = PLACEMENT_CHECK_CHAIN.map((check) => {
      const at = body.indexOf(check.resolverMarker);
      expect(
        at,
        `placement check '${check.id}' claims resolveWorkerPlacement contains ${JSON.stringify(check.resolverMarker)}, ` +
          `and it does not. Either the resolver changed (update PLACEMENT_CHECK_CHAIN — the explanation is now stale) ` +
          `or the marker was never distinctive enough.`,
      ).toBeGreaterThan(-1);
      return { id: check.id, at };
    });
    const sorted = [...positions].sort((a, b) => a.at - b.at).map((p) => p.id);
    expect(
      sorted,
      "PLACEMENT_CHECK_CHAIN is out of order relative to resolveWorkerPlacement. The chain must list the checks in " +
        "the order the resolver applies them, or an operator reading the explanation gets the wrong 'decided at' step.",
    ).toEqual(PLACEMENT_CHECK_CHAIN.map((c) => c.id));
  });

  it("matches docs/worker-fleet.md §7's checklist one-for-one, in the same order", () => {
    const items = docChecklistItems();
    expect(
      items.length,
      `docs/worker-fleet.md §7 lists ${items.length} checks; PLACEMENT_CHECK_CHAIN declares ` +
        `${PLACEMENT_CHECK_CHAIN.length}. One of the two is wrong — the docs page and the recorded chain describe ` +
        `the SAME five guards in resolveWorkerPlacement, so they cannot differ in count.`,
    ).toBe(PLACEMENT_CHECK_CHAIN.length);

    for (const check of PLACEMENT_CHECK_CHAIN) {
      const item = items[check.docStep - 1];
      expect(item, `no doc item at step ${check.docStep} for check '${check.id}'`).toBeTruthy();
      expect(
        check.docMarker.test(item!),
        `docs/worker-fleet.md §7 item ${check.docStep} does not describe '${check.id}' ` +
          `(expected to match ${String(check.docMarker)}). The doc's checklist order and the recorded chain's ` +
          `docStep numbering have drifted apart.`,
      ).toBe(true);
    }
  });

  /**
   * ORDER parity is not enough, and this test exists because that gap actually bit:
   * #748 added a SIXTH guard (repository shape) while this feature was being written,
   * and every marker still matched in order — the chain was simply incomplete, so it
   * concluded "remote" for a project the resolver kept on the host. Only the runtime
   * cross-check caught it. Counting the resolver's host exits makes that failure
   * static: a new guard is red here the moment it lands.
   */
  it("declares one check per host-fallback exit in the resolver — a NEW guard cannot go unlisted", () => {
    const body = resolverBody();
    // #801 made this guard STRONGER by accident of its own change: every host exit now
    // names the check that decided it (`hostBecause("<id>", …)`, so the session record can
    // say WHY), which means this test can compare the ID SET rather than just a count. A
    // seventh guard that reused an existing id would have passed the old count check.
    const hostExitIds = [...body.matchAll(/return hostBecause\("([a-z_]+)"/g)].map((m) => m[1]!);
    const declared = PLACEMENT_CHECK_CHAIN.map((c) => c.id);
    // The catch block's exit is `resolver_error`: an unexpected FAILURE is not one of the
    // checks — nothing decided it, the resolution broke — so it is excluded here and
    // asserted separately rather than being folded in as an anonymous "+1".
    expect(
      hostExitIds.filter((id) => id === "resolver_error").length,
      "the resolver's catch block must take exactly one host exit, tagged resolver_error",
    ).toBe(1);
    expect(
      hostExitIds.filter((id) => id !== "resolver_error").sort(),
      `resolveWorkerPlacement's host exits name [${hostExitIds.join(", ")}], but PLACEMENT_CHECK_CHAIN ` +
        `declares [${declared.join(", ")}]. A guard was added to or removed from the resolver without updating ` +
        `the chain — the explanation an operator gets is now incomplete, and a session recorded under an ` +
        `undeclared id would name a check nothing can explain. Add the check (with its resolverMarker and a ` +
        `matching numbered item in docs/worker-fleet.md §7) or remove it.`,
    ).toEqual([...declared].sort());
  });

  it("gives every check a distinct docStep covering 1..N with no gaps", () => {
    const steps = PLACEMENT_CHECK_CHAIN.map((c) => c.docStep).sort((a, b) => a - b);
    expect(steps).toEqual(PLACEMENT_CHECK_CHAIN.map((_, i) => i + 1));
  });
});
