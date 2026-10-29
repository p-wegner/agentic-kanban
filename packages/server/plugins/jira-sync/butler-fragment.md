# Jira Sync

This project has the Jira Sync plugin enabled. It pulls tickets from a Jira project into this
board via JQL, and can push status transitions, comments and (per `syncDirection`) mapped field edits back.
  Jira Cloud only; Server/Data Center is not supported.

- The plugin's `sync.pull`/`sync.push` commands (`plugins/jira-sync/tools/sync/{pull,push}.mjs`)
  are deterministic — they never spawn an agent and never make a judgment call about ticket
  content.
- Credentials (`JIRA_API_TOKEN`, `JIRA_EMAIL`) live only in the environment the commands run in.
  The board keeps the ones entered in Settings -> Plugins -> Jira Sync encrypted in `kanban.db`
  and injects them into the commands. You must never ask the user to paste one into chat or into
  a file in this repo.
- `docs/jira-sync/_profile.md` names the Jira site, project key and JQL filter for this project.
  While site URL and project key are not saved in the plugin settings, `TODO:` markers in it
  block the sync commands - tell the user which field is missing rather than guessing a value.
  Once the settings are complete the markers no longer block anything.
- You must not decide the JQL filter, the conflict rule for a field edited on both sides, or
  which Jira transition a board status maps to — those are configuration a human sets in the
  profile, not something to infer from ticket content.
- To check whether the connection works, run the `bootstrap` script; to see what a pull would do
  without changing anything, run the `plan` script (or `pull --dry-run`).
