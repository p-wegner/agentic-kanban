# Jira Sync

This project has the Jira Sync plugin enabled. It pulls tickets from a Jira project into this
board via JQL, and can push status transitions and comments back.

- The plugin's `sync.pull`/`sync.push` commands (`plugins/jira-sync/tools/sync/{pull,push}.mjs`)
  are deterministic — they never spawn an agent and never make a judgment call about ticket
  content.
- Credentials (`JIRA_API_TOKEN`, `JIRA_EMAIL`) live only in the environment the commands run in.
  They are never stored in the board's database and you must never ask the user to paste one into
  chat or into a file in this repo.
- `docs/jira-sync/_profile.md` names the Jira site, project key and JQL filter for this project.
  If it still contains `TODO:` markers, the sync commands refuse to run — tell the user which
  field is missing rather than guessing a value.
- You must not decide the JQL filter, the conflict rule for a field edited on both sides, or
  which Jira transition a board status maps to — those are configuration a human sets in the
  profile, not something to infer from ticket content.
- To check whether the connection works, run the `bootstrap` script; to see what a pull would do
  without changing anything, run the `plan` script (or `pull --dry-run`).
