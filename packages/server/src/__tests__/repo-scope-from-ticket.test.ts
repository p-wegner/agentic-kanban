/**
 * #629 — the ticket already said which repos it touches; nothing read it back.
 *
 * `POST /api/issues` has accepted `reposTouched` since #94 and stores it as `repo:<name>`
 * tags. Workspace creation never looked, so `resolveScopedSiblingRepos` saw an omitted scope
 * and did the zero-regression thing: all repos. Measured on `comet`, a 17-repo project —
 * `POST /api/workspaces/preview` for a ticket whose work is entirely in the leading
 * `documentation` repo returned all 17 with `selected: true`, each meaning a real worktree and
 * a real dependency install (one Maven repo measured 209 s warm).
 *
 * The write half was fine. This is the read half, and the precedence around it.
 */
import { describe, it, expect } from "vitest";
import { resolveEffectiveRepoScope, resolveScopedSiblingRepos } from "../services/workspace-repos.service.js";
import type { RepoRow } from "../repositories/repo.repository.js";

const LEADING = "documentation";

function repos(...names: string[]): RepoRow[] {
  return names.map((name, i) => ({ id: `r${i}`, path: `C:/projects/comet/${name}`, name })) as unknown as RepoRow[];
}

describe("resolveEffectiveRepoScope (#629)", () => {
  it("uses the ticket's repos when the caller named none — the monitor's path", () => {
    // `plugin-loop-start.service` and the monitor call createWorkspace({ issueId }) with
    // nothing else, so this branch is the one that produced "all 17 repos".
    expect(resolveEffectiveRepoScope({ reposTouched: ["api"], leadingRepoName: LEADING }))
      .toEqual([LEADING, "api"]);
  });

  it("always includes the leading repo, which is what distinguishes a scope from 'all'", () => {
    // An EMPTY scope means "all repos" downstream, so a scope has to be non-empty to mean
    // anything — and the leading repo is provisioned unconditionally regardless.
    const scope = resolveEffectiveRepoScope({ reposTouched: ["web"], leadingRepoName: LEADING })!;
    expect(scope[0]).toBe(LEADING);
    expect(resolveScopedSiblingRepos(repos("api", "web"), scope).map((r) => r.name)).toEqual(["web"]);
  });

  it("does not duplicate the leading repo when the ticket already names it", () => {
    expect(resolveEffectiveRepoScope({ reposTouched: [LEADING, "api"], leadingRepoName: LEADING }))
      .toEqual([LEADING, "api"]);
    expect(resolveEffectiveRepoScope({ reposTouched: ["DOCUMENTATION"], leadingRepoName: LEADING }))
      .toEqual([LEADING]);
  });

  it("an EXPLICIT scope always wins, including one that widens beyond the tags", () => {
    // A human who named the repos has more context than the tags — including the right to
    // add one the ticket never mentioned.
    expect(resolveEffectiveRepoScope({
      explicit: [LEADING, "api", "web"], reposTouched: ["api"], leadingRepoName: LEADING,
    })).toEqual([LEADING, "api", "web"]);
  });

  it("a leading-ONLY explicit scope is honoured, not widened back to the tags", () => {
    const scope = resolveEffectiveRepoScope({
      explicit: [LEADING], reposTouched: ["api", "web"], leadingRepoName: LEADING,
    })!;
    expect(resolveScopedSiblingRepos(repos("api", "web"), scope)).toEqual([]);
  });

  it("falls back to the LEADING repo alone when the ticket declares nothing (#633 landed)", () => {
    // This was "all repos" while "Repos touched" could only be set at creation time: an
    // untagged ticket that genuinely spanned repos would otherwise get one worktree and an
    // agent unable to see the code it was sent to change. #633 made the field editable on an
    // existing issue, so an absent tag is now the ticket's own statement of scope rather than
    // an artefact of when it was filed — and the universal cost (17 worktrees + 16 sequential
    // installs per untagged ticket on `comet`) outweighs the rare confusing one. Widening is
    // one field on the ticket; unwinding 17 worktrees is not.
    expect(resolveEffectiveRepoScope({ reposTouched: [], leadingRepoName: LEADING })).toEqual([LEADING]);
    expect(resolveEffectiveRepoScope({ explicit: [], reposTouched: [], leadingRepoName: LEADING })).toEqual([LEADING]);
    expect(resolveScopedSiblingRepos(repos("api", "web"), [LEADING])).toEqual([]);
  });

  it("still means ALL repos when there is no leading repo name to scope to", () => {
    // A scope is a list of names; with nothing to put in it the only honest answer is the
    // unscoped default, never an empty array (which downstream reads as "all" anyway).
    expect(resolveEffectiveRepoScope({ reposTouched: [], leadingRepoName: "" })).toBeUndefined();
  });

  it("ignores blank entries rather than minting an empty scope from them", () => {
    expect(resolveEffectiveRepoScope({ reposTouched: ["  ", ""], leadingRepoName: LEADING })).toEqual([LEADING]);
    expect(resolveEffectiveRepoScope({ reposTouched: [" api "], leadingRepoName: LEADING }))
      .toEqual([LEADING, "api"]);
  });

  it("cuts a 17-repo project down to what the ticket names — the measured comet case", () => {
    const all = repos(...Array.from({ length: 16 }, (_, i) => `repo${i}`));
    const scope = resolveEffectiveRepoScope({ reposTouched: ["repo3"], leadingRepoName: LEADING })!;
    expect(resolveScopedSiblingRepos(all, scope).map((r) => r.name)).toEqual(["repo3"]);
  });
});
