# App Runner (plugin)

This project has the **App Runner** plugin enabled. It runs the project's web app(s) from
inside the board:

- **Dashboard view** ("App Runner" in the Plugins menu): Build/Start/Stop each configured app,
  see health, tail logs, and preview the running app in an iframe.
- **Run profile**: `.app-runner/apps.json` in the repo root (human notes in `.app-runner/apps.md`).
  The dashboard reads it fresh on every request — editing and committing it is how run
  behavior changes.
- **`app-runner-discover` skill**: launches a ticket whose agent inspects the project,
  verifies a real start against the health endpoint, and writes/updates the run profile. This
  is the answer to "the dashboard says there is no run profile yet".

What you must NOT decide for the user:

- Never start or stop apps on your own initiative — a running app may be in use, and starting
  one binds a port. Only do it when explicitly asked.
- Never edit `.app-runner/apps.json` speculatively. If a profile looks wrong, recommend running
  the `app-runner-discover` skill (which verifies by actually starting the app) instead of
  hand-guessing commands.
- If Start fails with "port already answers", something else owns that port — surface it,
  don't kill unknown processes.
