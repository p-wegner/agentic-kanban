# app-runner — run your project's web apps from inside the agentic-kanban board

A [board plugin](https://github.com/p-wegner/agentic-kanban): one dashboard for
build/start/stop, health checks, log tail and a live preview of whatever web app(s) a project
contains — plus an agent skill that discovers and documents *how* each project is run, so the
glue is written once per project and committed with it.

## Parts

| Part | What |
|---|---|
| **App Runner view** | Supervised dashboard (`tools/serve.mjs`, zero-dep Node). Reads `.app-runner/apps.json` from the project's leading repo fresh per request. Start/Stop (Windows-safe process-tree kill), optional Build button, health probe, per-app log ring buffer, embedded preview iframe, fullscreen. Running pids are registered in the OS tmpdir so a restarted dashboard adopts orphans instead of losing them. |
| **`app-runner-discover` skill** | Ticket-launched agent brief: inspect the repo, verify a real start against the health endpoint, write `.app-runner/apps.json` + `.app-runner/apps.md`, commit. Encodes the traps (Gradle-daemon detach, dev-watchers, guessed health paths). |
| **`status` script** | Read-only validity check of the run profile. |
| **`selftest` script** | Offline end-to-end test against a temp fixture app (`node tools/selftest.mjs`). |

## Run profile (`.app-runner/apps.json`)

```json
{
  "version": 1,
  "apps": [{
    "id": "backend", "name": "Helpdesk backend",
    "build": "gradlew.bat installDist -x test",
    "start": "build\\install\\helpdesk\\bin\\helpdesk.bat",
    "port": 8080, "healthPath": "/health", "startTimeoutSec": 60,
    "notes": "Ktor/Netty, H2 in-memory — data resets on restart."
  }]
}
```

Prefer `"portEnv": "PORT"` (dashboard allocates a free port) over a fixed `"port"` when the
app supports it. `start` must keep the app in the foreground **inside its own process tree**
(`gradlew run` detaches via the daemon — use `installDist` + the generated script instead).

## Install

Settings → Plugins → Install, source = this directory (or its git URL). Enable per project,
then either run the `app-runner-discover` skill or hand-write `.app-runner/apps.json`.
