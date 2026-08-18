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

  it("falls back to today's all-repos default when the ticket declares nothing", () => {
    // Deliberately NOT leading-only, which is what the ticket proposed: a ticket that
    // genuinely spans repos but carries no tags would get one worktree and an agent that
    // cannot see the code it was sent to change. Slow beats confusing until #633 makes the
    // field editable and tagging is reliable.
    expect(resolveEffectiveRepoScope({ reposTouched: [], leadingRepoName: LEADING })).toBeUndefined();
    expect(resolveEffectiveRepoScope({ explicit: [], reposTouched: [], leadingRepoName: LEADING })).toBeUndefined();
    expect(resolveScopedSiblingRepos(repos("api", "web"), undefined).map((r) => r.name)).toEqual(["api", "web"]);
  });

  it("ignores blank entries rather than minting an empty scope from them", () => {
    expect(resolveEffectiveRepoScope({ reposTouched: ["  ", ""], leadingRepoName: LEADING })).toBeUndefined();
    expect(resolveEffectiveRepoScope({ reposTouched: [" api "], leadingRepoName: LEADING }))
      .toEqual([LEADING, "api"]);
  });

  it("cuts a 17-repo project down to what the ticket names — the measured comet case", () => {
    const all = repos(...Array.from({ length: 16 }, (_, i) => `repo${i}`));
    const scope = resolveEffectiveRepoScope({ reposTouched: ["repo3"], leadingRepoName: LEADING })!;
    expect(resolveScopedSiblingRepos(all, scope).map((r) => r.name)).toEqual(["repo3"]);
  });
});
