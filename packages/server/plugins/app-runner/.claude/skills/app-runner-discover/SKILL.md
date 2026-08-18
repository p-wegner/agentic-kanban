---
name: app-runner-discover
description: Discover how to build/run this project's app(s), verify a real start against a health endpoint, and write .app-runner/apps.json + .app-runner/apps.md for the App Runner dashboard.
---

# app-runner-discover

Your job: make this project runnable **from the board's App Runner dashboard**. The dashboard
(this plugin's view) reads `.app-runner/apps.json` from the repo root and offers Build/Start/Stop,
health checks, logs and a live preview for each declared app. You produce that file — and you
**verify it by actually starting the app** before you commit anything.

## Steps

1. **Inspect.** Read README/CLAUDE.md/docs, build files (`package.json`, `build.gradle.kts`,
   `pom.xml`, `pyproject.toml`, `Cargo.toml`, `docker-compose.yml`, …) and the entry point.
   Answer for each runnable app in the repo (a repo can hold several — backend + frontend):
   - How is it **built** (one-shot command, skippable when artifacts are current)?
   - How is it **started in the foreground** (the process must keep running, not daemonize)?
   - Which **port** does it bind — fixed in code, or configurable via an env var?
   - Is there a cheap **health endpoint** (`/health`, `/actuator/health`, `/api/health`)? If
     none, `/` is the fallback — note that in `apps.md`.

2. **Verify by running.** Start the app headlessly exactly as your profile will say
   (background process, `windowsHide` semantics — never open a terminal window, never
   `Start-Process`), poll the health URL until it answers, then **kill the whole process
   tree** (`taskkill /pid <pid> /T /F` on Windows). A profile you did not see become healthy
   is a guess, not a profile. Record how long it took to become healthy and set
   `startTimeoutSec` to roughly double that.

3. **Write `.app-runner/apps.json`** (create the `.app-runner/` directory if needed):

   ```json
   {
     "version": 1,
     "apps": [
       {
         "id": "backend",
         "name": "Helpdesk backend",
         "cwd": ".",
         "build": "gradlew.bat installDist -x test",
         "start": "build\\install\\helpdesk\\bin\\helpdesk.bat",
         "port": 8080,
         "healthPath": "/health",
         "openPath": "/",
         "startTimeoutSec": 60,
         "notes": "Ktor/Netty, H2 in-memory — data resets on restart."
       }
     ]
   }
   ```

   Field rules:
   - `id` — `[a-z0-9-]+`, unique. `name` — human label. `cwd` — repo-relative (default `.`).
   - `start` — a single shell command, run by the dashboard via the platform shell in the
     app's `cwd`. It must run the app **in the foreground, inside its own process tree**.
   - Port: prefer `"portEnv": "PORT"` (or whatever var the app reads) so the dashboard can
     allocate a free port; use fixed `"port": N` only when the port is hardcoded.
   - `build` — optional one-shot build the dashboard offers as a button. Keep `start` fast by
     moving slow compilation into `build`.
   - `env` — optional extra env vars for `start`.

4. **Write `.app-runner/apps.md`** — the human/agent-facing notes the JSON can't carry: what the
   app is, prerequisites (JDK version, node version, a database?), why you chose this start
   command, known gotchas, and what you verified (health URL + time-to-healthy).

5. **Commit both files** (pathspec-limited to the two files) with a message like
   `chore: add App Runner run profile (.app-runner/apps.json)`.

## Traps that produce broken profiles

- **`gradlew run` / `mvn spring-boot:run` detach via a daemon.** The Gradle daemon starts the
  app JVM as *its* child, outside your process tree — the dashboard's tree-kill then can't
  stop the app and the port stays bound. Build a distribution instead
  (`gradlew installDist`) and `start` the generated `bin/<app>.bat` / `bin/<app>` script, or
  `java -jar` a fat jar. Same reasoning for any launcher that hands off to a daemon.
- **Dev-watchers are usually the wrong `start`.** `npm run dev` with HMR is fine for a
  frontend; a watcher that respawns the server on file changes is fine too — but a command
  that opens a browser, prompts interactively, or exits after forking is not.
- **Don't guess the health path.** Probe it. A 404 on `/health` with a real `/` is fine —
  set `healthPath` to `/`.
- **Never bind 0.0.0.0 assumptions into `openPath`/notes** — the dashboard always talks to
  `127.0.0.1`.
- **Clean up your verification run.** Leaving your probe process alive makes the dashboard's
  first Start fail with "port already answers".
- **Windows**: never `Start-Process`, never leave a console window flashing; spawn hidden and
  kill by pid tree.

## When you cannot produce a working profile

Write `.app-runner/apps.md` anyway, documenting what you tried and what is missing (e.g. "needs a
local Postgres", "build requires credentials"), and say so in your final summary. Do **not**
commit an unverified `apps.json` — a dashboard full of broken Start buttons is worse than the
empty state, which at least points here.
