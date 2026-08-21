/**
 * The project MARKER FILE vocabulary — the filenames whose presence at a repo root
 * identifies its ecosystem. One list, in `shared`, because more than one package needs
 * it (#590's rule for what belongs here).
 *
 * Why it lives here rather than beside the detector (#695): the canonical detector is
 * `server/src/services/stack-markers.ts`, and a `shared` module cannot import from
 * `server`. So `container-dep-volumes.ts` — which maps markers to the dependency
 * DIRECTORIES a containerized builder must relocate — could not reuse the detector's
 * list and grew a second copy of the vocabulary instead. That is a genuine second
 * ladder, and it survived the detector consolidation precisely because the layering
 * made it invisible: nothing in `server` could see it, and nothing checked.
 *
 * This module is the part the two CAN share. Pure data, no `fs`, no DB — so it is
 * client-safe and carries no import direction of its own.
 *
 * What is deliberately NOT unified: what each consumer DERIVES from a marker. The
 * detector derives verify/setup commands; `container-dep-volumes` derives dependency
 * directories; `buildable-from-clean` cares only about lockfiles. Those are different
 * questions with different answers, and collapsing them would be a worse abstraction
 * than the duplication it removed. The vocabulary is the shared part; the mapping is not.
 *
 * `stack-marker-ladder-ratchet.test.ts` fails on a THIRD file growing its own marker
 * list, which is the thing that had no guard at all.
 */

export const PROJECT_MARKER_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.toml",
  "go.mod",
  "requirements.txt",
  "Pipfile",
  "pyproject.toml",
  "uv.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "mix.exs",
  "composer.json",
  "composer.lock",
  "Makefile",
  "justfile",
  "Taskfile.yml",
] as const;

/**
 * A filename from the vocabulary. Consumers type their own tables with this, so a typo
 * or an ecosystem added in only one place is a COMPILE error rather than a marker that
 * silently never matches.
 */
export type ProjectMarkerFile = (typeof PROJECT_MARKER_FILES)[number];
