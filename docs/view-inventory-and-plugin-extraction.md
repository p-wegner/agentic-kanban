# Board View Inventory — What Earns Its Slot, and What to Extract

Preparation doc for thinning the board's view surface. It answers two questions:
**which views are genuinely helpful vs. clutter**, and **which of the clutter can actually
become plugins** given what the plugin system supports today.

Status: assessment + sequenced plan. Nothing has been extracted yet.

## The numbers

| Measure | Today |
|---|---|
| Views in `VIEW_REGISTRY` | **41** |
| Primary toolbar tabs | 14 |
| Behind the "More" overflow | 27 |
| Single-key shortcuts consumed | **22** (of 26 letters) |
| View component LOC | ~14,200 across 38 files |
| Registry + secondary-render plumbing | 824 + 429 LOC |

Two costs follow from that, and they are different costs:

1. **Attention cost.** A 14-tab toolbar plus a 27-entry dropdown means the six views you
   actually use during a drive are no easier to reach than the starfield.
2. **Keyboard cost.** 22 of 26 letters are spent on view switching, which is why `c`, `x`
   and `capacity`/`activity` already collide (see the "reserved global board action"
   comments in the registry). The next genuinely useful view has no letter left.

Note what we *cannot* measure: there is **no view-usage telemetry** anywhere in client or
server. Every judgment below is from structure and role, not from observed use. If we want
evidence rather than argument, a usage counter is a ~1-hour change and should precede any
deletion we're unsure about.

## Verdicts

### A. Core — the board itself. Never extract. (17)

`kanban` · `backlog` · `table` · `graph` · `agents` · `butler` · `workflows` ·
`plugin-views` · `drive` · `monitor-history` · `health-events` · `strategy` · `focus` ·
`stale-work` · `agent-flight-recorder` · `digest` · `runbooks`

These either *are* the product (board/backlog/table), hold **write authority** over board
state (`graph` edits dependencies, `stale-work` nudges via `/turn`, `strategy` writes the
Bullseye prefs that every monitor reads, `workflows` writes templates), or need in-process
streaming a sandboxed iframe cannot have (`agents`, `butler` SSE, `agent-flight-recorder`).

`runbooks` is the weakest member — it only reads project markdown — but it is also 207 LOC
and answers "how do I operate this project", so it stays.

### B. Genuinely useful, but the wrong *domain* for the board. Extract. (3)

| View | LOC | Why it doesn't belong here |
|---|---|---|
| `crime-scene` (Hotspots) | 384 | Churn/complexity city view. This is `code-metrics` territory. |
| `quality-metrics` | 273 | Renders metrics a *skill* (`quality-metrics-collector`) POSTs in. The board is just a display case. |
| `flaky-tests` | 360 | Test-health radar with its own parse endpoint. Test health, not board state. |

This is the **only group where extraction is clearly the right call** rather than a lateral
move. All three are code-health analysis of the *project*, which is exactly what a plugin
is for — and `refactor-safety-net` / `code-metrics-skill` already exist as the natural
homes, already ship their own tooling, and would already be running a server for their
own views. Moving these there makes the board smaller *and* puts them next to the analysis
that produces their data.

### C. Redundant analytics — consolidate, don't extract. (12)

**Eight single-chart views**, each one chart + one endpoint + one toolbar slot:
`throughput` · `provider-mix` · `lead-time` · `scorecard-distribution` · `provider-cost` ·
`agent-throughput` · `burndown` · `calendar` (~1,900 LOC total)

**Four aggregate dashboards** that are the obvious homes for them:
`metrics` (board + code footprint) · `insights` (agent cost/tokens/success) ·
`workflow-analytics` (stage trends, funnel, CFD) · `milestones`

Turning these into plugins would be **actively worse**: eleven analytics views as plugin
views means eleven supervised child node processes to render eleven bar charts. The right
move is a single **Analytics** view with tabs, absorbing the eight single-charts into the
four dashboards they already thematically belong to. That reclaims 8 registry entries and
~7 shortcuts at zero feature loss, and it is a pure client refactor — no plugin
prerequisites, no rewrite.

### D. Six competing event streams — pick two. (redundancy, not extraction)

`activity` · `cross-repo-activity` · `digest` · `monitor-history` · `health-events` ·
`agent-flight-recorder`

This is the sharpest redundancy in the registry: six reverse-chronological "what happened"
feeds, differing mainly in which table they read. Nothing here should become a plugin —
they all read board-internal state — but the set needs a deliberate decision about which
two survive as first-class and which become filters on those two. `cross-repo-activity`
additionally shows nothing at all on a single-repo project and should at minimum be
**conditionally hidden** rather than permanently occupying a slot.

### E. Decorative — zero information. The honest clutter. (4)

| View | LOC | What it tells you |
|---|---|---|
| `constellation` (Stars) | 451 | Nothing the board doesn't. Animated starfield. |
| `fireworks` | 391 | Nothing. |
| `momentum` | 281 | Priority lanes — a weaker `swimlane`. |
| `garden` | 112 | Nothing. Plants. |

~1,235 LOC and two single-key shortcuts (`v`, `e`) for decoration. These are also the
**best technical extraction candidates in the whole registry**: they are prop-driven with
no API calls of their own, need no write access, and losing them costs nothing
operationally. If we want one proof-of-concept "views can live in a plugin" bundle, this
is it — a single `board-whimsy` plugin serving all four.

`swimlane` (345 LOC, priority × status) is a genuine alternative layout, not decoration —
keep it, and fold `momentum` into it or drop `momentum`.

### F. Conditional — keep, but gate visibility. (2)

`capacity` (sprint capacity planner) · `cross-repo-activity` (multi-repo only)

## The blocker nobody has hit yet

**Plugin views are `kind: "iframe"` only** (`PluginViewDef` in
`packages/shared/src/lib/plugin-manifest.ts`) — a supervised child HTTP server whose page
is embedded in a sandboxed iframe. So "extract a view into a plugin" is never a *move*: it
is a **rewrite** of a React component into a standalone web app.

Two concrete prerequisites before any data-driven view can be extracted at all:

1. **No `{{boardUrl}}` or `{{projectId}}` placeholder.** The substitution set is
   `{{repoPath}}` / `{{leadingRepoPath}}` / `{{projectName}}` / `{{pluginPath}}` /
   `{{port}}` (`plugin-manifest.ts:467-471`). A plugin view therefore has **no sanctioned
   way to find the board's API or know which project it is showing** — it would have to
   hardcode `localhost:3001`, which breaks on every worktree port. This is the single
   prerequisite ticket for group B and E.
2. **CORS is fine.** The API allowlist reflects any loopback origin
   (`packages/server/src/lib/cors-origin.ts`), and a plugin view server *is* on loopback —
   so once a view knows the board URL, it can read the API. No change needed here.

There is also no **view-visibility mechanism** at all: no `hidden_views` pref, no
per-project gating. Curating the toolbar today means editing `viewRegistry.tsx`. For a
board whose whole point is per-project configuration, that is the gap doing the most
damage — and it is cheaper than any extraction.

## Recommended sequence

Cheapest-first, each step independently valuable:

1. **View visibility prefs** (`hidden_views_<projectId>`) + a Settings picker. Nothing is
   deleted, nothing is rewritten, and every "clutter" verdict above becomes the user's
   call instead of ours. Highest value per hour in this whole document.
2. **Consolidate group C** into one tabbed Analytics view. −8 registry entries, ~7
   shortcuts reclaimed, pure client refactor.
3. **Resolve group D** — decide which two event feeds are first-class; make the rest
   filters. Gate `cross-repo-activity` on multi-repo.
4. **Add `{{boardUrl}}` + `{{projectId}}` to the placeholder contract.** Unblocks every
   remaining extraction; small, well-tested surface.
5. **Extract group E as one `board-whimsy` plugin.** The proof of concept — no data
   dependency beyond `/api/projects/:id/board`, no write access, nothing lost if it fails.
6. **Extract group B into the existing code-health plugins.** The real win, and the step
   that should only be attempted after 4 and 5 have proven the path.

Do **not** attempt 6 before 5. Rewriting `crime-scene` blind, against a placeholder
contract that can't name the board, is how this becomes a stalled epic.

## What this explicitly does not recommend

- **Extracting the analytics charts to plugins.** Eleven node processes to draw eleven bar
  charts is a worse system than the one we have.
- **Deleting anything in step 1.** Visibility prefs make deletion an option we can defer
  until usage data exists.
- **Adding a plugin view kind that renders React in-bundle.** It would solve the rewrite
  cost by re-importing exactly the coupling the iframe boundary exists to prevent.
