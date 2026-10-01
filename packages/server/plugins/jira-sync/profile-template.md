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

Never written here. Enter the site URL, project key, JQL, account email and API token in the
board's plugin settings (Settings → Plugins → Jira Sync). The token and email are stored
encrypted in `kanban.db` and handed to `bootstrap`/`plan`/`pull`/`push` as environment
variables; no board restart or shell environment is needed.

- `JIRA_EMAIL` — the Atlassian account email (Jira Cloud basic auth)
- `JIRA_API_TOKEN` — an API token (Jira Cloud) or a Personal Access Token (Jira Server/Data
  Center)

A hand-set `JIRA_SITE_URL` / `JIRA_PROJECT_KEY` / `JIRA_JQL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` in
the board host's environment still works for headless setups.
