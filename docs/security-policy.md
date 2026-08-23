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
measured, the number is **3 unknown out of 557** in the whole tree and **2 out of
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

### The acceptance list makes the gate a ratchet — and it is now EMPTY

`POLICY.acceptedProdAdvisories` enumerates the production-graph advisories that
are knowingly tolerated, keyed by **GHSA id** (stable across pnpm's own numeric
re-issues), each with a reason and the date it was accepted. Its effect is to
turn the threshold into a ratchet: **"no NEW high/critical in production"**.

**Today that list is empty, and an empty list is the healthy state.** It is not
a gap in the policy — it is the policy having nothing left to excuse. The gate
still fails on any high/critical in the production graph; there is simply
nothing currently reported for it to fail on.

The gate was born with four entries (`GHSA-mh99-v99m-4gvg` and
`GHSA-rgw5-rvv9-x895` brace-expansion, `GHSA-7p8r-x3mc-p8w7` fast-uri,
`GHSA-mwp4-54f8-5fhr` ip-address). All four were cleared in **#760** by raising
override floors rather than by accepting them, and #786 then cleared the last
remaining production advisory of any severity (`GHSA-v422-hmwv-36x6`
body-parser, a `low`). Their entries were removed in the same commits.

Removing them was not tidiness — it was **forced**. The list is **shrink-only**:
an entry whose advisory is no longer reported *fails the scan*, so a fixed
advisory cannot leave a stale exemption behind for the next one to hide inside.
Both failure modes — an unaccepted advisory and a stale acceptance — are
verified to exit non-zero. That property is what keeps the list empty by itself,
without anyone having to remember to prune it.

Adding an entry to make a red build green is not the intended use. Fix the
dependency, or file a ticket and add the entry in the same commit that explains
why not.

### The override floors in `pnpm-workspace.yaml` are the mechanism of record

Every transitive fix behind the empty acceptance list is one `overrides:` entry
in `pnpm-workspace.yaml` (that file, not `package.json` — pnpm no longer reads
the `pnpm` field there). Each entry carries the GHSA ids it clears, so an
override that has stopped being needed is visible rather than silently
inherited. Current entries: `hono`, `@hono/node-server`, `fast-uri`, `ws`,
`brace-expansion@2`, `ip-address`, `qs`, `body-parser`.

Two of them are worth knowing about specifically:

- **`ip-address` deliberately forces past an exact pin.**
  `express-rate-limit@8.4.1` pins `ip-address: "10.1.0"` exactly, so *any*
  patched version is out of range by construction and there is no non-forcing
  fix short of an upstream release. This is a knowingly accepted risk, recorded
  here and in the override's own comment: ip-address 10.x is semver-minor
  throughout and express-rate-limit uses it only to normalise the client IP for
  keying. Re-check if it starts depending on 10.1-specific behaviour.
- **Everything else merely raises a floor.** `body-parser: "^2.3.0"` is in range
  of express's declared `^2.2.1`; `brace-expansion@2` is scoped on purpose
  because 1.x and 5.x lines are also present in the dev tree and forcing all of
  them to 2.x would break their consumers.

`hono` and `@hono/node-server` are pinned EXACTLY rather than by range, and must
stay in step with `packages/server/package.json` (#761): an override replaces the
direct dependency's spec too, so a caret range here would outrank that manifest's
exact pin and the manifest would stop describing what actually installs.

## Licence policy

Scope is again the production graph, because that is what gets redistributed.

| Class | Handling |
|---|---|
| Strong copyleft / source-available (`AGPL`, `GPL-`, `SSPL`, `BUSL`, `CC-BY-NC`, `EUPL`, `OSL`, `CPAL`) | **Fail.** It would change the licensing of anything that installs us. |
| Weak copyleft (`MPL-`, `LGPL`, `EPL-`, `CDDL`) | Reported for a human call — linking is normally fine, vendoring is not. |
| No readable SPDX id (`Unknown`) | Must match a named pattern in `POLICY.licences.acceptedProdUnknownLicences`, each carrying a reason. |

The current unknowns are all the Anthropic Claude Agent SDK — the base package
plus one binary per platform — under proprietary Anthropic terms, deliberately
depended on.

**This was a numeric ceiling (`prodUnknownCeiling: 2`) and the count turned out
to be the wrong unit.** The SDK ships one package per platform, so the number
moves whenever it adds a build target, with no change in who we depend on or
under what terms. On 2026-08-23 `-linux-x64-musl` appeared, the count went
2 → 3, and CI failed over our own dependency growing a target. A count is also
weaker in the other direction: it says "three unknowns are acceptable" without
saying *which*, so removing a known one silently makes room for an unrelated
supplier to arrive under the ceiling.

Accepting by name fixes both ends — a new platform variant of an already-accepted
SDK passes, and a package from a genuinely new supplier fails however few
unknowns there are. Acceptances are stale-checked the same way the advisory ones
are: a pattern matching nothing fails the scan, so a dependency we have dropped
cannot leave behind a rule that pre-accepts some future package.

Dev-only copyleft is not gated: it never leaves the developer's machine. Today
that is `lightningcss` (MPL-2.0, via the client build) and `argparse`
(Python-2.0).

## Measured baseline — 2026-08-23

Re-measured with `pnpm security` (PASS, exit 0) after #760, #761 and #786.

| | packages | critical | high | moderate | low | advisories |
|---|---|---|---|---|---|---|
| whole tree | 789 | 0 | 16 | 7 | 1 | 22 |
| production | 289 | 0 | 0 | 0 | 0 | **0** |

Licences: 557 packages classified whole-tree with 3 unknown; 265 in production
with 2 unknown; 0 strong copyleft anywhere; 2 weak-copyleft (MPL-2.0) packages,
both dev-only.

**The production graph reports zero advisories of any severity**, and
`POLICY.acceptedProdAdvisories` is empty — nothing is being excused to get
there.

The 16 remaining highs are all dev-only and accepted as a class (see above):
`vite` and the `postcss`/`nanoid` that ride with it, `js-yaml` via
`@changesets/cli`, and the 1.x/5.x `brace-expansion` lines under `eslint` and
`typescript-eslint`. None of them appear in the production graph or in the npm
tarball.

For the record, two findings that earlier versions of this document called out
are gone. The `shell-quote` **critical** (GHSA-w7jw-789q-3m8p, dev-only via
`concurrently`) was cleared by bumping `concurrently` to `^10.0.5`, which ships
shell-quote 1.9.0; and the four accepted production highs described above were
cleared by override floors. Neither is a live finding — they are recorded here
only so a reader comparing against an older copy of this file can see what
happened to them.
