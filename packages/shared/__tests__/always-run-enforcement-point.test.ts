// @gate:always-run — reads `package.json`, `scripts/gate-always-run.mjs` and the two
// `direct-master` SKILL.md copies; it imports none of them, so `vitest related` is blind to it.
//
// #817 — the `@gate:always-run` guard set had NO enforcement point on the direct-master path.
//
// The marker declares a suite that must run for every diff reaching its package, because what
// it checks is not reachable through the module graph. Two mechanisms force that set to run —
// `pre-merge-gate.service.ts` and `scripts/test-mine.mjs` — and BOTH sit on the merge path. A
// commit made directly on master goes through neither, and a large share of this repo's work
// lands exactly that way.
//
// Measured, not hypothesised: the server nloc ring landed at `086a41b6bc` with its baseline
// measured at that commit, and within the same day three baselined functions grew past their
// entries on plain master commits (`createSessionLifecycle` 614→615, `createRemoteAgentService`
// 573→594, `createWorkerAgentRunner` 404→410). `git merge-base --is-ancestor 086a41b6bc <each>`
// is true for all three: the ring was in their history and caught all three — retroactively, as
// a red suite the next person to merge anything inherited.
//
// The chosen remedy (over a `pre-commit` hook, which would serialise the several agents that
// share this checkout and would be `--no-verify`'d the first time it cost a minute) is a named
// command plus a step in the `direct-master` skill. That remedy is only real while BOTH halves
// exist, and both are plain text a refactor can quietly drop:
//
//   - the command (`pnpm gate:always-run` → `scripts/gate-always-run.mjs`), and
//   - the skill step that tells an agent to run it.
//
// A command nobody is told to run is a script; a step naming a command that does not exist is a
// broken instruction. This holds the two together, and it is deliberately a LOCKSTEP check
// rather than a content assertion — it says nothing about how the step is worded, only that the
// skill still names the command and the command still runs the declared guard set.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");

const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

/** Both copies: `.codex/skills` is a committed mirror of `.claude/skills` (codex-skills-parity). */
const SKILL_COPIES = [
  ".claude/skills/direct-master/SKILL.md",
  ".codex/skills/direct-master/SKILL.md",
];

const SCRIPT_NAME = "gate:always-run";
const SCRIPT_PATH = "scripts/gate-always-run.mjs";

describe("the @gate:always-run guard set has an enforcement point on the direct-master path (#817)", () => {
  it(`\`pnpm ${SCRIPT_NAME}\` exists and points at ${SCRIPT_PATH}`, () => {
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(
      pkg.scripts?.[SCRIPT_NAME],
      `the root package.json must define a "${SCRIPT_NAME}" script — it is the only way a ` +
        `direct-master commit runs the guard set at all (#817).`,
    ).toContain(SCRIPT_PATH);
  });

  it("that script really runs the DECLARED guard set, not a hand-listed one", () => {
    const src = read(SCRIPT_PATH);
    // It must delegate to test-mine's guards-only mode. Re-deriving the set here would be the
    // exact drift #538 removed: the marker scan and what actually runs must stay one mechanism.
    expect(
      src,
      `${SCRIPT_PATH} must delegate to scripts/test-mine.mjs' KANBAN_TEST_GUARDS_ONLY mode, so ` +
        `the set it runs cannot drift from the set the pre-merge gate forces.`,
    ).toContain("KANBAN_TEST_GUARDS_ONLY");
    expect(src).toContain("test-mine.mjs");
  });

  it("the direct-master skill tells the agent to run it — both committed copies", () => {
    for (const rel of SKILL_COPIES) {
      expect(
        read(rel),
        `${rel} must name \`pnpm ${SCRIPT_NAME}\`. Without the step, the command is a script ` +
          `nobody is told to run, and direct-master work goes back to growing baselined ` +
          `functions that only the NEXT merger discovers (#817).`,
      ).toContain(`pnpm ${SCRIPT_NAME}`);
    }
  });
});
