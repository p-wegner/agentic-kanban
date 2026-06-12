# Board run: space-invaders-html5

Hands-off "build a new app via the board" run, driven through the `drive-new-project` skill.

## Summary
- **Game:** Space Invaders (classic Atari/Taito), vanilla HTML5 + Canvas + JS, no build step.
- **Repo:** `C:\andrena\space-invaders-html5`
- **Board projectId:** `60f55d52-c3aa-4beb-aa83-dd006efb5a49`
- **Final master sha:** `6531676` (`npm test` green — 8 checks incl. functional collision/scoring/lives/wave/UFO/barrier behavior run in a VM sandbox).
- **Provider:** codex:default (board default).
- **Tickets:** 1 meta (#1) + 10 build (#2–#11), all 10 build tickets Done.

## Epic shape (fan-out, not a chain)
- **#2 shell** (engine loop + game state machine + system registry) — no deps.
- **Parallel wave (#3–#9)** — each depends ONLY on #2, each owns a disjoint `src/*.js`:
  player, invaders, bullets, barriers, ufo, audio, hud. After #2 merged, all 7 were
  simultaneously unblocked (verified via `/dependency-waves`: each blocked by [2] only).
- **#10 integration** — blocked by all 7 wave tickets; wired collisions/scoring/lives/
  waves/game-over into game.js, and added a VM-sandbox functional test harness.
- **#11 retro/polish** — blocked by #10; README + smoke coverage + a start-screen test.

Real parallelism achieved: 3 builders ran concurrently during the wave (WIP target 3).

## Friction / where the board needed help (honest)
1. **Dependency race at seed time.** The autodrive monitor started #1/#2/#3 within
   seconds of batch-creating the issues, *before* the dependency edges were POSTed, so a
   wave ticket (#3) launched against the empty engine stub. Fix: stopped + deleted #3's
   workspace, returned it to Todo (now correctly blocked). Seeding should create issues +
   edges atomically, or pause autodrive until edges exist.
2. **`no-auto-start` tag not honored from batch.** `create_issues_batch` dropped the
   `tags` field, so the meta-ticket #1 got a builder launched against it twice. Fix:
   assigned the built-in `no-auto-start` tag via the tag endpoint + stopped/deleted its
   workspace. Batch create should accept tags.
3. **smoke.test.js merge-conflict pileup.** Every wave ticket appended assertions to the
   single shared `test/smoke.test.js`, so 5 branches in review hit concurrent conflicts.
   The board's parallel fix-and-merge thrashed: only one merge wins per master advance,
   and the losing fix-and-merge sessions closed/idled their workspaces WITHOUT landing,
   stranding #5/#8/#9 (some with no open workspace at all). The board flow genuinely
   failed to converge here.
   - **Recovery:** lowered WIP to 1 to stop the thrash; #5 merged via the plain board
     `merge` endpoint once its conflict cleared; #8/#9 had no workspace + a real conflict,
     so I fell back to **manual `git merge` on master** resolving the trivial
     smoke.test.js append by hand (keeping all assertions), then PATCHed the issues to
     Done + closed workspaces. Logged in the merge commit messages.
   - **Lesson:** a shared append-only test file is a hot file — either give each ticket
     its own test file, or serialize merges (WIP 1) for the conflicting wave.
4. **Codex plan-mode slowness on #10.** The `dependency-waves/start-next` launch path did
   not pass `planMode:false`, so #10 spent ~6 min in plan-implement (wrote a PLAN.md,
   explored) before writing code. Looked like a stall (the watcher fired a 6-min
   no-change warning) but session output was growing — confirmed live, not hung. It then
   produced a strong integration + a real functional test suite.
5. **Transient 503s** from the server during heavy review/merge load — momentary, self-
   recovered; the watcher tolerated them with `|| true`.

## What worked well
- Fan-out structure delivered genuine 3-way parallel builds.
- Auto-review caught a real bug in #11's review (`Fix bomb collision respawn crash`,
  committed by review-auto-fix).
- The resident watch (a Monitor poll loop) surfaced every stall and let me recover the
  narrowest one each time, exactly per the skill's Step 5.

## Close-out
- 10/10 build tickets Done; `git log master` confirms all merges; `npm test` green.
- Meta-ticket #1 moved to Review only after N/N Done + git + test verification.
