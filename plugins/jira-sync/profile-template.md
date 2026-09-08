# Jira Sync profile

Filled in once per project, by a human. The sync commands refuse to guess any of this.

## Site

TODO: Jira site URL (e.g. `https://yourteam.atlassian.net`)

## Project

TODO: Jira project key (e.g. `ENG`)

## Filter

TODO: JQL filter restricting which issues sync (leave as "default" to sync the whole project,
ordered by last-updated)

## Credentials

Never written here. Set these as environment variables wherever `pull`/`push` run:

- `JIRA_SITE_URL` — same value as above, read by the tools directly (the board does not yet
  resolve `sync.config` into env for you — see `sync` in `kanban-plugin.json`)
- `JIRA_EMAIL` — the Atlassian account email (Jira Cloud basic auth)
- `JIRA_API_TOKEN` — an API token (Jira Cloud) or a Personal Access Token (Jira Server/Data
  Center — omit `JIRA_EMAIL` in that case, the token is sent as a bearer token instead)
- `JIRA_PROJECT_KEY` — same value as above
- `JIRA_JQL` — optional, same value as above

TODO: confirm the credential env vars above are set in the environment `pull`/`push` run in,
never committed to this repo or to `kanban.db`
