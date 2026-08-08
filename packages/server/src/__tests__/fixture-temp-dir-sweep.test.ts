import { describe, expect, it } from "vitest";
import { matchedNamespace, SWEPT_TEMP_NAMESPACES } from "./helpers/reap-fixture-child-servers.js";

/**
 * #364 — the sweep must own the NAMESPACE, not a whitelist of prefixes.
 *
 * #352 fixed nine `plugin-*` prefixes and #362 fixed one production call site, but the measured
 * state was 8,448 live `kanban-*` directories across ~14 distinct fixture prefixes, from ~250
 * `mkdtemp` call sites. The regression this locks down is a new fixture prefix appearing and
 * being invisible to the sweep — which is how the 8,448 accumulated while a sweep was already
 * in place and working correctly for its own nine prefixes.
 */
describe("fixture temp-dir sweep namespaces (#364)", () => {
  // Every prefix in this list was COUNTED on the machine in #364's measurement.
  const measuredLeakedPrefixes = [
    "kanban-mrr-lead-",
    "kanban-mrr-sib-",
    "kanban-api-fixture-",
    "kanban-rebase-lead-",
    "kanban-foundational-wt-",
    "kanban-verify-gate-",
    "kanban-backup-test-",
    "kanban-close-multi-lead-",
    "kanban-strand-sib-",
    "kanban-lead-stamp-",
    "ak-bisect-",
    "ak-mcp-db-",
    "ak-artifacts-",
  ];

  it.each(measuredLeakedPrefixes)("sweeps %s", (prefix) => {
    expect(matchedNamespace(`${prefix}abc123`), `${prefix} is not covered by any swept namespace`).not.toBeNull();
  });

  it("keeps the plugin prefixes on the short 60s age — they are paired with a process reap", () => {
    // An orphan `serve.mjs` holds its dir as cwd, so reaping the dir promptly (right after the
    // process is killed) is the whole point of #352's fix; a 2h wait would undo it.
    expect(matchedNamespace("plugin-test-plugin-x")?.minAgeMs).toBe(60_000);
  });

  it("gives the broad namespaces two hours, so a concurrent worktree's suite is never reaped", () => {
    // A prefix list is a whitelist of dirs we understand; a namespace is not. `kanban-*` also
    // covers another worktree's live run and the per-fork `kanban-api-fixture-*` repo, so the
    // cutoff has to exceed any plausible suite duration (~40 min measured here).
    expect(matchedNamespace("kanban-anything-new-x")?.minAgeMs).toBe(2 * 60 * 60_000);
    expect(matchedNamespace("ak-anything-new-x")?.minAgeMs).toBe(2 * 60 * 60_000);
  });

  it("leaves unrelated tooling in %TEMP% alone", () => {
    // %TEMP% holds ~247,000 dirs on this machine, the overwhelming majority from other
    // toolchains. Only the board's own namespaces may ever be touched.
    for (const name of ["npm-cache-abc", "vscode-typescript", "chrome_BITS_1234", "tmp-xyz", "pip-req-build-1"]) {
      expect(matchedNamespace(name), `${name} must not be swept`).toBeNull();
    }
  });

  it("orders the namespaces so the specific plugin prefixes win over the broad ones", () => {
    // `matchedNamespace` returns the FIRST match; if the broad entry came first, a
    // hypothetical `kanban-`-prefixed plugin fixture would silently inherit the 2h age.
    expect(SWEPT_TEMP_NAMESPACES[0].minAgeMs).toBeLessThan(SWEPT_TEMP_NAMESPACES[1].minAgeMs);
  });
});
