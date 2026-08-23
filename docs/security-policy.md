# Dependency security & licence policy

The scan: `pnpm security` (`scripts/security-scan.mjs`), run in CI by
`.github/workflows/security-scan.yml` on every PR into `master`, on pushes to
`master`, weekly on a schedule, and on demand. `pnpm security:json` /
`pnpm security -- --json` emits the same result machine-readably.

The **policy of record is the `POLICY` object at the top of
`scripts/security-scan.mjs`** — one place. The workflow contains no thresholds of
its own; it runs the script. A laptop and CI therefore cannot disagree.

## Why this exists (#741)

The board is published to npm with a real dependency tree and **no advisory scan
had ever run against it**, here or in CI. External metrics tooling reported
`skipped:no_lockfile` because it looks for `package-lock.json` / `Gemfile.lock` /
a Python lock; this repo's lockfile is `pnpm-lock.yaml`. pnpm has a native audit,
so the gap was wiring, not tooling.

The same run answers the licence question. Note that the earlier "40 of 50
dependencies have no readable licence" figure was an artefact of an *offline*
reader that could not resolve metadata — it was not a property of this tree.
`pnpm licenses list` reads the licence field of the actually-installed packages;
measured, the number is **3 unknown out of 558** in the whole tree and **2 out of
265** in the production graph.

## Failure policy

> **Fail on `high` or `critical` severity in the PRODUCTION dependency graph.
> Everything else is reported and never fails the build.**

Reasons:

- **A gate that cannot fail is decoration.** So something must be blocking.
- **A gate that fails on every transitive `low` is noise**, and a noisy gate gets
  disabled or routinely overridden within a week — which is worse than none,
  because it also removes the signal.
- **Production vs. dev is the meaningful line for this package.** Production deps
  are installed into other people's repos by `npm i agentic-kanban`; a
  vulnerability there is *our* shipped risk. Dev-only advisories (vite, esbuild,
  vitest, and friends) execute on a developer's own machine against a checkout
  that machine already trusts, and the classic examples — "the dev server can be
  reached by any website you visit" — are not part of what we distribute. They
  are reported on every run so nobody has to guess whether they were measured.
- **`moderate` reports rather than blocks** because in this tree it is dominated
  by algorithmic-complexity DoS in libraries we do not expose to untrusted input.
  A moderate worth acting on gets a ticket, not a global threshold change.

### Dev-only advisories are accepted as a class (#786)

Not "ignored" and not "unmeasured" — **accepted, as a class, with a reason**.
They are printed on every run (the whole-tree line), so the number is always
visible; what the policy says is that a `high` reachable only from a
devDependency does not block a merge and does not need a per-advisory
exemption entry.

The reason is the production/dev line above: `vite`, `vitest`, `postcss`,
`nanoid`, `js-yaml` via `@changesets/cli`, and the 1.x/5.x `brace-expansion`
lines under `eslint` / `typescript-eslint` execute on a developer's machine,
against a checkout that machine already trusts, and none of them ship in the
npm tarball. The classic exploit text — "any website you visit can reach your
dev server" — describes a risk we take by running a dev server at all, not one
this package distributes.

What this buys is that the count is a *decision* rather than a drifting
remainder. Two things keep it honest:

- The **production** graph is not accepted as a class. It is gated, ratcheted,
  and currently at zero — see below.
- A dev-only advisory still gets fixed when the fix is cheap (a devDep bump, an
  override floor). Class acceptance is what happens to the ones left over, not
  a reason to stop bumping.

### The acceptance list makes the gate a ratchet

Four high-severity advisories already existed in the production graph when the
gate was introduced. They are enumerated in `POLICY.acceptedProdAdvisories`,
keyed by **GHSA id** (stable across pnpm's numeric re-issues), each with a reason
and the date it was accepted. The effective rule is therefore **"no NEW
high/critical in production"**.

The list is **shrink-only**: an entry whose advisory is no longer reported *fails
the scan*, so a fixed advisory cannot leave a stale exemption behind for the next
one to hide inside. Both failure modes — an unaccepted advisory and a stale
acceptance — are verified to exit non-zero.

Adding an entry to make a red build green is not the intended use. Fix the
dependency, or file a ticket and add the entry in the same commit that explains
why not.

## Licence policy

Scope is again the production graph, because that is what gets redistributed.

| Class | Handling |
|---|---|
| Strong copyleft / source-available (`AGPL`, `GPL-`, `SSPL`, `BUSL`, `CC-BY-NC`, `EUPL`, `OSL`, `CPAL`) | **Fail.** It would change the licensing of anything that installs us. |
| Weak copyleft (`MPL-`, `LGPL`, `EPL-`, `CDDL`) | Reported for a human call — linking is normally fine, vendoring is not. |
| No readable SPDX id (`Unknown`) | Capped by `POLICY.licences.prodUnknownCeiling`, currently **2**. |

The two current unknowns are `@anthropic-ai/claude-agent-sdk` and its
`win32-x64` binary — proprietary Anthropic terms, deliberately depended on. The
ceiling exists so a *third* one cannot arrive unnoticed; it is a shrink-only
number like the advisory list.

Dev-only copyleft is not gated: it never leaves the developer's machine. Today
that is `lightningcss` (MPL-2.0, via the client build) and `argparse`
(Python-2.0).

## Measured baseline — 2026-08-22

| | packages | critical | high | moderate | low | advisories |
|---|---|---|---|---|---|---|
| whole tree | 784 | 1 | 21 | 13 | 3 | 36 |
| production | 287 | 0 | 4 | 6 | 2 | 12 |

Licences: 558 packages classified whole-tree with 3 unknown; 265 in production
with 2 unknown; 0 strong copyleft anywhere; 2 weak-copyleft (MPL-2.0) packages,
both dev-only.

The single `critical` is dev-only: `shell-quote` (GHSA-w7jw-789q-3m8p) via
`concurrently`, a root devDependency. It is not in the production graph.
