# Board run — greenfield bootstrap strategy (cost tuning)

**Date:** 2026-07-26 · **Provider:** claude / sonnet · **Goal:** find the cheapest way to bootstrap a
fresh ~2–4k LOC project via the board, and confirm the board is functional end-to-end for a new stack (PHP).

## Setup

Three equivalent plain-PHP layered apps (Support / Domain / Persistence / Application / Http / Console;
PSR-4, PHPUnit, PDO+SQLite), each scaffolded (composer.json + phpunit.xml + a `SPEC.md`/README), git-init'd,
registered via **REST** (the CLI writes the wrong DB on this box — see below), configured PHP stack + setup
(`composer install`) + verify (`php vendor/bin/phpunit`), then driven through the board.

| Project | Strategy | Tickets |
|---|---|---|
| `quillcms` (A) | fine-grained, layer-per-ticket | 6, dependency-chained |
| `notekeep` (B) | monolith one-shot | 1 mega ticket, single builder |
| `linkstash` (C) | foundation → parallel fanout | foundation ticket, then HTTP + CLI/feed leaves in parallel |

## Result (cost is the clean signal; wall-clock confounded by manual gating)

| Approach | $ | LOC | tests | $/KLOC | wall |
|---|---|---|---|---|---|
| A — 6 fine tickets | 12.41 | 4354 | 96 | 2.85 | ~90m (serial) |
| B — 1 mega ticket | **3.87** | 3731 | 102 | **1.04** | ~14m |
| C — foundation + 2 parallel | 10.73 | 4718 | 140 | 2.27 | ~58m |

**A single mega ticket is ~2.7× cheaper per KLOC than fine-grained decomposition, with equal/better
coverage and a full green suite.** The cost driver is **not ticket count** — C's 3 tickets cost nearly
as much as A's 6. Every extra ticket pays: a builder cold-reading the growing codebase, its own review
session, its own worktree setup, and (for parallel leaves on a shared file) fix-and-merge conflict
overhead. One mega ticket builds in one warm context and pays none of it. Parallel fanout (C) buys
wall-clock, not tokens.

Decision rule folded into the **`drive-new-project`** skill (new **Step 0**): mega ticket for anything
that fits one context (~2–4k LOC); coarse sequential chunks or foundation+fanout only for larger apps;
never fine-grained layer chains.

## Board functionality — all mechanics worked

Worktree provisioning · per-stack setup (`composer install`, PHP detected/configured) · agent auto-launch ·
**auto-review** · **auto-merge** · conflict **detection** (withheld the C2 merge: "branch is N commits
behind master") · **fix-and-merge** auto-resolution (rebased C2, resolved a `FeedService` collision from
the two parallel leaves into one coherent class, merged). Final suites green: quillcms 96 / notekeep 102 /
linkstash 140 tests.

## Gaps filed

- **#177** — PHP stack profile emits Windows-broken `vendor/bin/phpunit`; the pre-merge verify gate failed
  on it. Must be `php vendor/bin/phpunit` (portable — the extensionless Composer shim isn't cmd-executable).
- **#178** — REST `POST /api/projects` skips the stack detection that CLI `register` runs, so stack profile /
  setup / verify land null. Bites because on this box the running server serves the home-fallback DB while
  the CLI writes the local-checkout DB, so REST is the only registration path that reaches the live board.

## Round 2 — multi-repo TypeScript, 5k-LOC target

Three projects, each **backend Hono repo (leading, verify-gated) + frontend React/Vite repo (sibling)**,
in-memory repos, Vitest. **All 6 repos ended green** (typecheck+test). Cost per KLOC (total $):

| Project | Strategy | Tickets | $ | LOC | $/KLOC |
|---|---|---|---|---|---|
| habithub | repo-mega (1 mega ticket per repo) | 2 | 6.75 | 3377 | **2.00** |
| bugtrack | coarse sequential (found → feat → FE) | 3 | 9.83 | 3761 | **2.61** |
| pantry | contract-first fanout (contract → 3-wide wave → leaf) | 5 | 17.02 | 4095 | **4.16** |

Replicates Round 1: **$/KLOC rises steeply with ticket count** (fanout = 2×/KLOC vs minimal). New at scale:
a single context **builds to coherence, not a LOC target** — per-repo megas plateaued ~1.7k LOC/repo, none
of the three reached 5k, and the *more*-decomposed run got closest. So the mega sweet spot is per-context;
above it, **coarse sequential** (near the mega floor, far below fanout) is the value pick — fanout only when
wall-clock matters. Rules folded into `drive-new-project` Step 0.

**Driving gap:** the in-process monitor would not auto-start Backlog wave tickets for a `start_mode=monitor`
project — tickets were `issueType:feature` (monitor skips those, #773) and `dependency_auto_chain` was off
(gates the post-merge cascade). Drove via a manual stateful loop instead; auto-review/auto-merge/fix-and-merge
were event-driven and worked. Both gates added as blocking preflight rows in `drive-new-project` Step 1.

Fixtures kept: `{habithub,pantry,bugtrack}-{backend,frontend}` at `C:\projects\andrena\exp\` — multi-repo TS
refactor fixtures.

## Artifacts

Fixtures kept at `C:\projects\andrena\exp\{quillcms,notekeep,linkstash}` (registered) — realistic ~4k-LOC
PHP apps for refactor-skill (PHP tier) tuning: namespaced classes, interface/impl pairs, an
`AbstractPdoRepository` inheritance family.
