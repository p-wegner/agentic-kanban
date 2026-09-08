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
  plan.mjs                script: dry-run of a pull, prints structured JSON
  selftest.mjs            script (developer): exercises the client offline against fixtures
  sync/pull.mjs           sync.pull: diff Jira against last-seen state, optionally apply
  sync/push.mjs           sync.push: apply a local outbox of transitions/comments
  lib/
    jira-client.mjs        the zero-dependency REST client (search, get, transition, comment)
    auth.mjs                credential resolution (env) + auth header construction
    errors.mjs              HTTP/network failures normalized to one JiraApiError shape
    fixtures.mjs            fixture-backed fetch for offline testing
    pull-plan.mjs           the deterministic pull diff, shared by plan.mjs and pull.mjs
    state.mjs               JSON state file helpers (pull state, outbox)
    profile.mjs             the same TODO-marker gate the board's scaffold uses
  fixtures/                 recorded JSON responses used offline
__tests__/                  unit tests (node:test) — auth, pagination, backoff, error normalization
```

## Credentials

Never persisted anywhere by this plugin. Set as environment variables wherever `bootstrap`,
`plan`, `pull` or `push` run:

- `JIRA_SITE_URL`, `JIRA_PROJECT_KEY`, `JIRA_JQL` (optional — defaults to the whole project)
- `JIRA_EMAIL` + `JIRA_API_TOKEN` for Jira Cloud (basic auth), or just `JIRA_API_TOKEN` for a
  Jira Server/Data Center Personal Access Token (sent as a bearer token)

The board does not yet resolve `sync.config`/`sync.secrets` into these for you (see the `sync`
"Known gaps" note in `docs/plugin-development.md`) — this plugin reads them directly from its
own process environment.

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
