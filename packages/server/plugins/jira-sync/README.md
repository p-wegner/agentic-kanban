# Jira Sync plugin

A `kanban-plugin.json` plugin (see `docs/plugin-development.md` in the board repo for the full
contract) declaring the `sync` capability: pull tickets from a Jira project into the board via
JQL, push status transitions and comments back.

## What's here

```
kanban-plugin.json       manifest — scripts, loops.sync-conflicts, sync.pull/push, scaffold, butler fragment
profile-template.md      scaffolded once per project: site URL, project key, JQL — TODO-gated
butler-fragment.md       what the assistant should (and must not) do with this plugin
.claude/skills/
  sync-conflict/SKILL.md  what the sync-conflicts loop's tickets run: resolve one conflict/failure
tools/
  bootstrap.mjs           script: validate credentials + connectivity, read-only
  plan.mjs                script: dry-run of a Jira-side-only pull diff, prints JSON
  loop-plan.mjs           loops.sync-conflicts' plan command (#1080) — see below
  selftest.mjs            script (developer): exercises the client offline against fixtures
  sync/pull.mjs           sync.pull: map Jira issues through the field map and write board issues
  sync/push.mjs           sync.push: apply a local outbox of transitions/comments
  lib/
    jira-client.mjs        the zero-dependency Jira REST client (search, get, transition, comment, create)
    auth.mjs                Jira credential resolution (env) + auth header construction
    errors.mjs              HTTP/network failures normalized to one JiraApiError shape
    fixtures.mjs            fixture-backed Jira fetch for offline testing
    field-map.mjs           the declared Jira -> board field map (#1078) + status/priority mapping
    board-client.mjs        thin REST client for the BOARD's own API (create/update issues, tags)
    board-fixtures.mjs      in-memory fake of the board API, for `--self-test` pull runs
    sync-engine.mjs         the pull itself: fetch, map, create/update by externalKey, report conflicts
    pull-plan.mjs           the Jira-side-only diff behind plan.mjs (no board involved), shared with pull.mjs
    push-plan.mjs           the deterministic push apply/describe logic, shared by push.mjs
    transitions.mjs         resolves a target status name to a Jira transition id via the graph
    comment-marker.mjs      attribution marker so a pushed comment isn't re-imported as new
    state.mjs               JSON state file helpers (pull state, outbox, writebacks, cursor, registers)
    conflict-register.mjs  pure round-tracking shared by the conflict/failure registers (#1080)
    loop-plan.mjs           pure plan-building logic behind tools/loop-plan.mjs (#1080)
    profile.mjs             the same TODO-marker gate the board's scaffold uses
  fixtures/                 recorded JSON Jira responses used offline
__tests__/                  unit tests (node:test) — auth, pagination, backoff, error normalization,
                             field mapping, sync engine (create/idempotent/update/conflict),
                             transition resolution, comment marker, push plan, writebacks,
                             conflict/failure register round-tracking, loop plan
```

## Credentials

Never persisted by this plugin. Enter the site URL, project key, JQL, email and API token in
Settings → Plugins → Jira Sync (with a **Test connection** button): the board keeps the secrets
encrypted in `kanban.db` and injects them, plus the config as `SYNC_CONFIG_*`, into `bootstrap`,
`plan`, `pull` and `push`. For a headless run, set these environment variables instead (they
win over the injected values):

- `JIRA_SITE_URL`, `JIRA_PROJECT_KEY`, `JIRA_JQL` (optional — defaults to the whole project)
- `JIRA_EMAIL` + `JIRA_API_TOKEN` for Jira Cloud (basic auth), or just `JIRA_API_TOKEN` for a
  Jira Server/Data Center Personal Access Token (sent as a bearer token)
- `JIRA_SYNC_BOARD_URL` + `JIRA_SYNC_BOARD_PROJECT_ID` for `sync/pull.mjs` — where and which
  board project to write issues into. The manifest's `sync.pull.env` already fills these from
  `{{boardUrl}}`/`{{projectId}}` whenever the board invokes `sync.pull` (the panel's Pull now and
  the schedule, #1625); set them by hand for a manual run.

`JIRA_SITE_URL`, `JIRA_PROJECT_KEY` and `JIRA_JQL` fall back to `SYNC_CONFIG_SITEURL`,
`SYNC_CONFIG_PROJECTKEY` and `SYNC_CONFIG_JQL` when unset.

## Inbound sync (`sync/pull.mjs`)

Maps every Jira issue matching `JIRA_JQL` (or `project = <JIRA_PROJECT_KEY> ORDER BY updated ASC`)
through the declared field map (`tools/lib/field-map.mjs`): summary -> title, description ->
description, status category -> board status (matched by name against the target project's
statuses, falling back to its default), priority -> priority, labels -> tags, assignee -> a
`assignee:<name>` tag (the board has no dedicated assignee column). Board issues are keyed by
`externalKey` (the Jira issue key), so re-running is idempotent: unchanged issues are skipped,
changed ones are updated, and new ones are created.

**Never deletes.** A Jira issue this project synced before but that has since moved out of the
JQL's scope is listed in the run summary's `reportedOutOfScope`, not removed from the board.

**Never silently overwrites a local edit.** `pull-state.json` (under `JIRA_SYNC_STATE_DIR`) records
the board issue's `updatedAt` at the moment of our own last write. If the board issue's current
`updatedAt` has since moved — someone edited it on the board after our last sync — the issue is
reported as `conflicted` and left alone, even though Jira also changed.

Every run returns `{ created, updated, skipped, conflicted, reportedOutOfScope, details }`. A
successful (non-dry-run) run also persists the outstanding `conflicted` details into
`conflict-register.json` and stamps `cursor.json`'s `lastPullAt` — see "The sync-conflicts loop"
below.

## Outbound sync (`sync/push.mjs`)

Applies queued outbox entries (`outbox.json`) one at a time — a status transition, an attributed
comment, or creating a Jira issue for a board issue with no `external_key` yet — and reports
`{ applied, failed, remaining }`. A successful (non-dry-run) run persists `failed` entries into
`failure-register.json` and stamps `cursor.json`'s `lastPushAt`.

## The sync-conflicts loop (#1080)

The manifest's `loops.sync-conflicts` turns whatever's outstanding in the conflict/failure
registers into board tickets, one per entry, carrying the `sync-conflict` skill. Its `plan`
command (`tools/loop-plan.mjs`) is pure and offline — it only reads
`${JIRA_SYNC_STATE_DIR}/cursor.json` + `conflict-register.json` + `failure-register.json`, never
touches Jira or the board, and never throws:

- **No successful pull yet** (`cursor.json` absent/`lastPullAt` null) → `{ units: [], converged:
  false }` — blocked, not done; nothing to plan until a pull has run at least once.
- **Nothing outstanding** → `{ units: [], converged: true }` — the loop stops advancing until
  something goes wrong again (a manual **Advance now** always re-plans regardless).
- **Something outstanding** → one unit per register entry, id `conflict:<jiraKey>:r<round>` or
  `push-failed:<identity>:r<round>`. `round` comes from the register (`tools/lib/conflict-register.mjs`):
  it stays the same while an entry is continuously outstanding (so the loop never re-tickets an
  already-ticketed problem), and increments only when an entry is resolved and then recurs later
  — which is what gives a genuine re-occurrence a fresh, ticketable id instead of being read as
  "already handled".

A unit's own ticket (the `sync-conflict` skill) never writes back "resolved" anywhere — closing it
does NOT resolve the conflict (#1643). Only the sync does: it recomputes the register from what's
actually still outstanding. That is the "state carried by the tickets, not a private run log"
property: the register is a snapshot of current reality, not an append-only log.

The loop declares `reconcileUnits`, so the board keeps its tickets in step with the plan:

- A unit whose ticket is **Done** while the register still lists it is not skipped: the next
  advance opens round 2 (`conflict:KD-49:r2`), whose brief points back at the round that did not
  settle it. (`Cancelled` stays a skip: that is a human's "won't do".)
- An open ticket whose unit has left the plan (the cause went away, e.g. a status map fixed by
  hand) is closed with a "Resolved by sync at <time>" comment. An empty-but-not-converged plan
  ("no pull yet") never closes anything.

### Resolving from an agent (`sync/resolve.mjs`, #1643)

A conflict ticket's agent has no Jira credentials and cannot run `sync/pull.mjs` itself. The board
runs `sync.resolve` for it, credentials injected server-side:
`POST /api/plugins/:id/sync/resolve { projectId, key, keep? }`.

- no `keep`: read-only; returns the three-way field table per mapped field (board now / last sync /
  Jira now). The conflict register records the same table when the pull finds the conflict, and the
  ticket brief renders it.
- `keep: "jira"`: force-pulls that one issue, overwriting the board issue.
- `keep: "board"`: writes the board's mapped fields (title, description, priority, type) to Jira
  once, the one sanctioned field write (push never sends field edits). Status moves stay with push.

Both write modes re-baseline the issue's sync state and mark its conflict entry resolved, so the
next pull reports no conflict.

## Resolving a conflict

A conflict (the board issue and Jira both changed a mapped field) is listed in the panel and in
`conflict-register.json`, and the sync-conflicts loop opens one ticket per entry. Resolve it by
asking `sync.resolve` (`POST /api/plugins/:id/sync/resolve { projectId, key, keep? }`, #1643):

1. Without `keep`, read the three-way field table (board now / last sync / Jira now).
2. Pick a winner: `keep: "jira"` overwrites the board issue from Jira; `keep: "board"` writes the
   board's title, description, priority and type to Jira once.
3. Either choice re-baselines the issue and marks the entry resolved; the next pull reports no
   conflict. Closing the loop's ticket alone resolves nothing - a Done ticket whose conflict is
   still registered re-opens as the next round.

## Running it

```sh
# from this directory
node tools/bootstrap.mjs               # validate credentials + connectivity
node tools/plan.mjs                    # dry-run: what would a pull do
node tools/sync/pull.mjs --dry-run     # same, via the manifest's own pull command
node tools/sync/pull.mjs               # actually pull and persist state
node tools/sync/push.mjs --dry-run     # what the outbox would send

# offline, no network and no real credentials required:
node tools/selftest.mjs --self-test
JIRA_SYNC_SELF_TEST=1 node tools/bootstrap.mjs
node --test __tests__/*.test.mjs   # the bare directory form fails on Node 24
```

Every command prints one JSON object to stdout and exits non-zero on failure — safe to run from
the board's `scripts`/`sync` machinery or straight from a shell.

## Known gaps

- **Operating it.** Settings → Plugins → Jira Sync has Pull now / Push now / Dry run, the last run
  per direction (counts, failures, conflicts linked to Jira) and the outbox length (#1625). The
  schedule is the `Pull every (min)` / `Push every (min)` settings (empty or 0 = off); the board's
  minute scheduler fires it. It is not yet shown in `status --watch`.
- **Settings are the source of truth.** With site URL and project key saved in the settings, the
  scaffold profile's TODOs no longer block Test connection, pull or push. A profile that is
  still all TODOs is only enforced for headless runs that set neither. The same holds for the
  board's loops and the plugin view (#1635): complete settings mean the profile reports no open
  fields and does not gate *Sync conflicts & failed pushes*.
- **Conflicts are field-level (#1635).** A moved board `updatedAt` is only a conflict when the
  mapped fields (title, description, priority, type, status) differ from the last-synced snapshot
  AND from what Jira now says. Equal to Jira = resolved and re-baselined; unchanged vs the snapshot
  = a plain update. **Board field edits are not pushed to Jira** (push sends status transitions,
  comments and creates only), so a board-side edit stays local until Jira is changed to match.
- **Run summary contract.** The board normalizes pull output (`created/updated/skipped/conflicted`,
  `details`) and push output (`appliedCount/failedCount`, `applied/failed`) into counts, issues,
  conflicts and failures, and a failed run records the script's `step`/`reason` plus the stderr
  tail. Jira browse links are built from the saved site URL.
- **Search API.** `searchIssues` uses `POST /rest/api/3/search/jql` with `nextPageToken` paging
  (#1622, `tools/lib/jira-client.mjs`). That endpoint returns no `total`, so `bootstrap` reports
  the size of the page it fetched (`moreAvailable` says whether there are more).
- **Never deletes.** Jira issues that leave the JQL scope are reported, not removed from the board.
- **Outbox is filled by the plugin (#1623).** `tools/lib/outbox-producer.mjs` queues board-side
  status transitions, comments and creates into `outbox.json`; push applies what is there. Board
  field edits (title, description, priority, type) are still not queued - see "Conflicts are
  field-level" above and "Resolving a conflict" below.
- **Health surfaces (#1673).** `status --watch` shows one SYNC line per project with Jira Sync
  enabled (last pull/push, open conflicts, failed pushes, outbox, next run) and ATTENTION lists a
  failed scheduled run, a direction silent for 3 schedule intervals, or conflicts open over a
  day. Both read the stored run summaries and local registers; no Jira calls.
