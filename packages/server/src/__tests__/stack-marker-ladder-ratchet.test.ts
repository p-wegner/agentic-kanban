// @gate:always-run — recursively walks every package's `src/` tree; it imports none of
// the files it judges, so `vitest related` cannot see it (#583).
//
// #695. `9b79937d13` genuinely collapsed a 9-branch stack ladder into
// `deriveVerifyCommand(detectStackProfile(...))`, but a SECOND marker ladder survived it
// unmentioned — `container-dep-volumes.ts` in `packages/shared`, which carried its own
// copy of the marker filenames. It survived because the layering hid it: a `shared`
// module cannot import the `server` detector, so no reviewer looking at the detector
// could see the duplicate, and nothing checked. Adding a THIRD failed nothing at all.
//
// This is the check that was missing. It is a RATCHET, not a ban, because a marker list
// is not automatically a defect: the detector needs one, and a consumer that maps markers
// to something else (dependency directories, lockfiles) legitimately enumerates a subset.
// What must not happen is a new one appearing SILENTLY. Every known site is listed with
// the reason it is allowed to exist, so adding one is a deliberate act with an argument
// attached, and removing one turns the gate red rather than leaving a stale exemption
// behind (the `compareRatchet` philosophy in guard-scan.ts).
//
// The shared vocabulary itself is `shared/lib/stack-marker-files.ts`; consumers type
// their tables with `ProjectMarkerFile` so a typo cannot invent a marker.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_MARKER_FILES } from "@agentic-kanban/shared/lib/stack-marker-files";

const PACKAGES_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Files allowed to enumerate marker filenames, each with WHY. A file here that no longer
 * matches is a failure too — a stale exemption silently excuses the next offender.
 */
// Two files that might be expected here are deliberately absent, and their absence is
// itself checked by the stale-exemption test:
//   - `shared/src/lib/stack-marker-files.ts` declares the vocabulary but never probes the
//     filesystem, so it is data, not a ladder.
//   - `server/src/services/stack-markers.ts` stopped being one when it began importing
//     that vocabulary — the ratchet tightened, so the entry is gone rather than kept.
const KNOWN_LADDERS: Record<string, string> = {
  "server/src/services/stack-detector.service.ts":
    "Maps markers to a stack profile (verify/setup commands). The mapping is its job; " +
    "the vocabulary comes from the shared list.",
  "shared/src/lib/container-dep-volumes.ts":
    "Maps markers to the dependency DIRECTORIES a containerized builder relocates. " +
    "Cannot import the server detector (shared must not depend on server), so it keeps " +
    "its own mapping — but its `marker` field is typed ProjectMarkerFile, so it can only " +
    "speak the shared vocabulary.",
  "server/src/services/project-setup.service.ts":
    "`deriveVerifyScript`'s three GAP branches (Makefile / Gemfile / mix.exs) — ecosystems " +
    "the canonical detector has no profile for yet. It calls the detector FIRST and only " +
    "falls through to these, so it is a shrinking remainder, not a rival detector. Each " +
    "branch disappears when the detector grows that profile.",
  "server/src/services/project-scaffold/buildable-from-clean.ts":
    "Lockfile-only subset: decides which install command a scaffolded project needs. " +
    "Not a stack detector; it never asks what ecosystem the repo is.",
};

/** Minimum distinct marker literals before a file counts as a LADDER rather than a probe. */
const LADDER_THRESHOLD = 3;

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (["node_modules", "dist", ".git", "coverage", ".vite", "__tests__"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|mts|cts|js|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

function markerLiteralsIn(source: string): string[] {
  return PROJECT_MARKER_FILES.filter((m) => {
    const escaped = m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`["'\`]${escaped}["'\`]`).test(source);
  });
}

function findLadders(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const pkg of ["shared", "server", "client", "mcp-server"]) {
    for (const file of walk(join(PACKAGES_ROOT, pkg, "src"))) {
      const source = readFileSync(file, "utf8");
      // A ladder PROBES the filesystem for these names. A file that merely mentions
      // several of them (docs, a prompt string, an error message) is not one.
      if (!/existsSync|readdirSync|statSync|readFileSync/.test(source)) continue;
      const markers = markerLiteralsIn(source);
      if (markers.length < LADDER_THRESHOLD) continue;
      found.set(relative(PACKAGES_ROOT, file).replace(/\\/g, "/"), markers);
    }
  }
  return found;
}

describe("stack-marker ladders are declared, so a third cannot appear silently (#695)", () => {
  it("has no marker ladder outside the declared set", () => {
    const found = findLadders();
    const undeclared = [...found.keys()].filter((f) => !(f in KNOWN_LADDERS)).sort();

    expect(
      undeclared,
      undeclared.length === 0
        ? ""
        : [
            "These files enumerate project marker filenames and probe the filesystem with them,",
            "but are not declared in KNOWN_LADDERS — i.e. a new stack-detection ladder appeared.",
            "",
            "Prefer reusing the canonical detector (server/src/services/stack-markers.ts) or, if",
            "layering forbids that, type the table with ProjectMarkerFile and add an entry here",
            "saying WHY this site needs its own mapping. That argument is the point of the list.",
            "",
            ...undeclared.map((f) => `  ${f} (${found.get(f)!.length} markers: ${found.get(f)!.slice(0, 5).join(", ")}…)`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("has no stale exemption for a file that no longer carries a ladder", () => {
    const found = findLadders();
    const stale = Object.keys(KNOWN_LADDERS).filter((f) => !found.has(f)).sort();

    expect(
      stale,
      stale.length === 0
        ? ""
        : [
            "These files are declared as known marker ladders but no longer match — either they",
            "were decomposed (good: delete the entry, the ratchet has tightened) or they moved.",
            "Leaving the entry would silently excuse whatever lands at that path next.",
            "",
            ...stale.map((f) => `  ${f}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("every declared ladder speaks the shared vocabulary and nothing else", () => {
    // A marker literal that is NOT in PROJECT_MARKER_FILES cannot be caught by the scan
    // above (it looks for known names), so an invented marker would be invisible. The
    // ProjectMarkerFile type is what actually prevents that in the typed tables; this
    // asserts the vocabulary is genuinely centralized rather than re-declared.
    const vocabularyFile = readFileSync(
      join(PACKAGES_ROOT, "shared", "src", "lib", "stack-marker-files.ts"),
      "utf8",
    );
    for (const marker of PROJECT_MARKER_FILES) {
      expect(vocabularyFile, `${marker} must be declared in the shared vocabulary`).toContain(marker);
    }
    // The canonical detector must not re-declare the list it was given.
    const detector = readFileSync(join(PACKAGES_ROOT, "server", "src", "services", "stack-markers.ts"), "utf8");
    expect(detector).toContain("stack-marker-files");
    expect(detector).not.toMatch(/const\s+PROJECT_MARKER_FILES\s*=/);
  });
});
