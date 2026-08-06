# Board View Inventory — What Earns Its Slot, and What to Extract

Preparation doc for thinning the board's view surface. It answers two questions:
**which views are genuinely helpful vs. clutter**, and **which of the clutter can actually
become plugins** given what the plugin system supports today.

Status: assessment + sequenced plan; steps 2 (#234), 3 (#235), 4 (`{{boardUrl}}`/`{{projectId}}`),
and 5 (#237, the `board-whimsy` extraction — see the learnings section at the end) are executed.
The registry counts in "The numbers" below describe the original state (41 views); current count: 27.

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

## Decision (#235): which two event feeds are first-class

Executed 2026-08-06 as step 3 of the sequence above (step 2, the Analytics
consolidation, landed as #234).

**The two survivors, split by DOMAIN rather than by table:**

| First-class view | Registry id | Tabs (former views) |
|---|---|---|
| **Activity** (board feed) | `activity` | Activity (status changes/merges) · Digest (`digest`) · Cross-Repo (`cross-repo-activity`, offered only on multi-repo projects) |
| **Runtime** (operational feed) | `runtime` (new id) | Flight Recorder (`agent-flight-recorder`) · Monitor Cycles (`monitor-history`) · Health Events (`health-events`) |

**Rationale.** The six feeds answered two different questions: "what happened
to the BOARD" (issues moved, merged, landed across repos — activity, digest,
cross-repo) and "what is the MACHINERY doing" (agent runtime events, monitor
cycle actions, health notifications — flight-recorder, monitor-history,
health-events). Users arrive with one of those two questions, so that is the
split — not endpoint kinship. Notably `monitor-history` and `health-events`
read the same endpoint (`/api/projects/:id/board-health-events`) and were the
most redundant pair; they become adjacent tabs of the Runtime feed. The
Runtime feed keeps `monitor-history`'s former primary toolbar slot (one
operational feed stays one click away); Activity stays in the More overflow.

**No information is lost:**
- Every prior feed is a tab, preselectable via command-palette actions
  ("Activity Feed: Digest", "Runtime Feed: Health Events", …) and deep-linkable
  via `?tab=`. Legacy routes (`/digest`, `/monitor-history`,
  `/health-events`, `/agent-flight-recorder`, `/cross-repo-activity`) resolve
  to the surviving view with the right tab preselected.
- `cross-repo-activity` is gated on repo count (`useProjectRepos.isMultiRepo`):
  the tab and its palette action are absent on single-repo projects, fixing the
  "permanently occupies a slot while showing nothing" complaint from group D.
- The digest's former `d` single-key shortcut is **freed** (not reassigned) —
  reclaiming letters is the point of this epic; digest remains reachable via
  palette and `?tab=digest`.

Registry effect: 5 entries removed (`digest`, `cross-repo-activity`,
`monitor-history`, `health-events`, `agent-flight-recorder`), 1 added
(`runtime`) → 35 → 31 views, exactly 2 event-feed entries remaining.

Rejected alternative: keeping `agent-flight-recorder` and `activity` as the two
ids with monitor/health folded into flight-recorder's own filter bar. Rejected
because monitor cycles and health events are lists with their own drill-downs
and category filters, not flight-recorder severities — forcing them into one
stream would rewrite three components; tabs re-parent them unchanged.

## Execution (#237): group E extracted as the `board-whimsy` plugin — learnings

Executed 2026-08-06 as step 5 of the sequence, immediately after step 4
(`{{boardUrl}}`/`{{projectId}}`, commit `0dc0d5d382`) landed. This section is the
write-up the ticket asked for: what the extraction actually cost, what it proved,
and what step 6 (#238, the code-health views) should expect.

### What was built

- **New repo `C:\projects\andrena\board-whimsy`** (separate git repo, not inside the
  board checkout): a manifest declaring **one** iframe view served by **one**
  dependency-free node stdlib server (`tools/serve.mjs`, no `package.json`, no deps),
  tabbed across the visualizations — not four child processes. The server takes
  `BOARD_URL={{boardUrl}}` / `PROJECT_ID={{projectId}}` via `serve.env`, binds the
  board-allocated `PORT`, answers a cheap `/health`, and proxies
  `GET {BOARD_URL}/api/projects/{PROJECT_ID}/board` at `/data` so the iframe page
  fetches same-origin and never thinks about CORS or the board's port.
- **Three visualizations ported** as inline vanilla canvas/DOM JS: constellation,
  fireworks, garden. Faithful-enough, not pixel-identical: same layouts, colors
  (chartColors values copied), animation behaviors, hover tooltips; issue-click
  (which opened the board's issue panel) is gone — an iframe can't open board UI.
- **Momentum was NOT ported — dropped.** Verified against `SwimlaneView`: swimlane
  is priority lanes × status columns, i.e. a strict superset of momentum's
  priority-lanes-with-status-sorted-cards. Porting it would have preserved a
  duplicate the inventory above already called "a weaker swimlane".
- **Board side:** the four registry entries, four components, garden's test, their
  lazy-view exports, render branches, and app routes deleted. Registry 31 → **27**;
  shortcuts **`v` and `e` freed** (guarded by a new registry test). Legacy paths
  (`/fireworks` etc.) now resolve to no view — deliberate, unlike the #234/#235
  tab-redirects, because there is no in-board target to redirect to.
- **Offline self-test** (`tools/selftest.mjs`, reqextract pattern): mock board
  server + the real serve.mjs; asserts health-before-data, the tabbed page renders
  (and has NO Momentum tab), `/data` proxies and the mock board actually received
  `GET /api/projects/:id/board`, and an unreachable board yields a friendly
  `{ok:false}` 200 instead of a raw 500. All 12 checks pass. The three tabs were
  additionally verified visually via playwright screenshots against fixture data.

### What was easy

- **The board-side deletion.** The registry consolidation (#116/#109) did its job:
  removing a view = one union member, one icon, one registry entry, one route line,
  one lazy export, one render branch, then mechanical test-count updates. ~30
  minutes including tests, no surprises, typecheck caught every dangling reference.
- **The placeholder contract (step 4) worked first try.** `{{boardUrl}}` +
  `{{projectId}}` through `serve.env` is exactly enough; nothing else was missing.
  Sequencing 4 before 5 was correct — this extraction would have been blocked
  without it, precisely as predicted above.
- **The board endpoint needed no changes.** `GET /api/projects/:id/board` returns
  `StatusWithIssues[]` (array of `{id, name, count, issues[]}`) — exactly the
  `columns` prop the components already took. The props-only design of group E
  meant the data contract was already the public API.
- **Server-side proxying instead of iframe-CORS.** Having the plugin server fetch
  the board and re-serve at `/data` (rather than the iframe fetching
  `{{boardUrl}}` cross-origin) made the empty/error case trivial to shape
  (`{ok:false, error}` always 200) and made the self-test able to assert "the
  board endpoint was called" without a browser. Recommended pattern for #238.

### What was painful

- **"Extract" is a rewrite, as the blocker section above predicted.** ~1,120 LOC of
  React/Tailwind became ~560 LOC of hand-written vanilla JS/CSS inside a template
  literal in serve.mjs. React idioms (refs, ResizeObserver, hooks deps) port
  mechanically, but Tailwind classes all become hand-rolled CSS, and there is no
  type checking inside the embedded page script — two typo-level bugs (garbage CSS
  from editing, template-literal escaping of `\u{...}` emoji) that tsc would have
  caught cost a syntax-check round. Mitigation that worked: extract the inline
  `<script>` and run `node --check` on it in the self-test loop.
- **Interactivity loss is real, not theoretical.** `onIssueClick` (open the issue
  panel) has no plugin-side equivalent — there is no board→iframe or iframe→board
  message channel. For decoration this costs nothing; for #238's views (crime-scene
  drills into hotspots, flaky-tests triggers a parse endpoint) it is THE design
  problem. Decide per view: link out (`window.open` the board route), or accept
  view-only, or add a postMessage contract first (a new prerequisite ticket if
  wanted).
- **Two sources of truth now exist for board vocabulary.** STATUS_COLORS /
  TYPE_COLORS / priority meta are copied into the plugin and will drift if the
  board's palette changes. Acceptable for whimsy; for #238 consider serving a tiny
  `/api/theme`-ish constants payload, or just accept drift.

### What step 6 (#238) should expect

1. **Budget the rewrite honestly.** Whimsy's three views were prop-driven and
   still took a full session. `crime-scene` (384 LOC + its own endpoint),
   `quality-metrics` (273 + POST ingestion), `flaky-tests` (360 + parse endpoint)
   each carry SERVER routes that must either stay in the board (plugin calls them
   via `{{boardUrl}}`) or move into the plugin's own server. Inventory those
   endpoints first; that decision, not the component port, is the real scope.
2. **Reuse the whimsy skeleton.** Manifest shape, `/health` + `/data` proxy +
   inline-page pattern, the selftest.mjs harness (mock board, spawn server, assert
   endpoint hit, assert empty state) and the `node --check` page-script guard are
   all copy-pasteable. That skeleton is now the "views can live in a plugin" proof
   the sequence asked for.
3. **Resolve the interactivity question before porting, not after** (see above —
   link-out vs postMessage). crime-scene without drill-down is a screenshot.
4. **Home the views with their data producers** as planned above:
   refactor-safety-net / code-metrics-skill already run view servers; add tabs to
   an existing server rather than minting new processes — the whimsy tab pattern
   shows one server carrying several views comfortably.
5. **Registry effect available:** after #238 the registry would drop to 24
   (crime-scene, quality-metrics, flaky-tests), freeing `y` and `k`.

### Verification status

- Verified: plugin self-test (12/12, offline), manifest parsed by the board's own
  `parsePluginManifest` (from built `shared/dist`), all three tabs rendered in a
  real browser against a mock board (playwright screenshots), client `tsc --noEmit`
  clean, `viewRegistry.test.tsx` + `appRoutes.test.ts` green (19 tests).
- NOT verified: the full board-side loop — install the plugin on a running board,
  enable for a project, start the view from the Plugins tab, and see the iframe
  framed with real `{{boardUrl}}`/`{{projectId}}` substitution. That needs a live
  dev server; nothing in the code path is novel (the placeholder substitution has
  its own tests from step 4), but until someone clicks it once, treat "installable
  end-to-end" as unproven.
- Cosmetic residue (out of #237's scope): the four views still appear in
  `docs/user-manual/USER-MANUAL.md`, `CHANGELOG.md` history, and
  `docs/verification/_test-index.json`; the user manual should be regenerated.
