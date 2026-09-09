# Jira Sync plugin

A `kanban-plugin.json` plugin (see `docs/plugin-development.md` in the board repo for the full
contract) declaring the `sync` capability: pull tickets from a Jira project into the board via
JQL, push status transitions and comments back.

## What's here

```
kanban-plugin.json       manifest — scripts, sync.pull/push, scaffold, butler fragment
profile-template.md      scaffolded once per project: site URL, project key, JQL — TODO-gated
butler-fragment.md       what the assistant should (and must not) do with this plugin
tools/
  bootstrap.mjs           script: validate credentials + connectivity, read-only
  plan.mjs                script: dry-run of a Jira-side-only pull diff, prints JSON
  selftest.mjs            script (developer): exercises the client offline against fixtures
  sync/pull.mjs           sync.pull: map Jira issues through the field map and write board issues
  sync/push.mjs           sync.push: apply a local outbox of transitions/comments
  lib/
    jira-client.mjs        the zero-dependency Jira REST client (search, get, transition, comment)
    auth.mjs                Jira credential resolution (env) + auth header construction
    errors.mjs              HTTP/network failures normalized to one JiraApiError shape
    fixtures.mjs            fixture-backed Jira fetch for offline testing
    field-map.mjs           the declared Jira -> board field map (#1078) + status/priority mapping
    board-client.mjs        thin REST client for the BOARD's own API (create/update issues, tags)
    board-fixtures.mjs      in-memory fake of the board API, for `--self-test` pull runs
    sync-engine.mjs         the pull itself: fetch, map, create/update by externalKey, report conflicts
    pull-plan.mjs           the Jira-side-only diff behind plan.mjs (no board involved)
    state.mjs               JSON state file helpers (pull state, outbox)
    profile.mjs             the same TODO-marker gate the board's scaffold uses
  fixtures/                 recorded JSON Jira responses used offline
__tests__/                  unit tests (node:test) — auth, pagination, backoff, error normalization,
                            field mapping, and the sync engine (create/idempotent/update/conflict)
```

## Credentials

Never persisted anywhere by this plugin. Set as environment variables wherever `bootstrap`,
`plan`, `pull` or `push` run:

- `JIRA_SITE_URL`, `JIRA_PROJECT_KEY`, `JIRA_JQL` (optional — defaults to the whole project)
- `JIRA_EMAIL` + `JIRA_API_TOKEN` for Jira Cloud (basic auth), or just `JIRA_API_TOKEN` for a
  Jira Server/Data Center Personal Access Token (sent as a bearer token)
- `JIRA_SYNC_BOARD_URL` + `JIRA_SYNC_BOARD_PROJECT_ID` for `sync/pull.mjs` — where and which
  board project to write issues into. The manifest's `sync.pull.env` already fills these from
  `{{boardUrl}}`/`{{projectId}}` once something invokes `sync.pull` through the board (still
  unwired — see "Known gaps" below); set them by hand for a manual run.

The board does not yet resolve `sync.config`/`sync.secrets` into these for you (see the `sync`
"Known gaps" note in `docs/plugin-development.md`) — this plugin reads them directly from its
own process environment.

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

Every run returns `{ created, updated, skipped, conflicted, reportedOutOfScope, details }`.

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
node --test __tests__
```

Every command prints one JSON object to stdout and exits non-zero on failure — safe to run from
the board's `scripts`/`sync` machinery or straight from a shell.
