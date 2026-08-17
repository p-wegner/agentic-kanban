# Writing a plugin

Everything needed to build a plugin for this board, assuming no prior knowledge of it. Read
top to bottom the first time; after that, the [checklist](#checklist) and
[the parser rules](#parser-rules-that-reject-a-manifest) are what you come back for.

**A plugin is a git repository with a `kanban-plugin.json` at its root.** Nothing is registered
in the board's code, nothing is published, nothing is compiled. You point the board at a
directory or a git URL and it reads the manifest.

The authoritative contract is `packages/shared/src/lib/plugin-manifest.ts` — types,
`parsePluginManifest` with field-precise errors, and the helpers the server uses. When this
document and that file disagree, the file wins; tell whoever sent you here.

## The one idea to understand first

**The plugin contributes deterministic commands. The board runs the agents.**

A plugin may not spawn agents, and does not want to. Work that spawns agents belongs on the
board, where it is visible on a kanban column, governed by the project's WIP limit and provider
selection, resumable after a restart, and passing whatever gates its workflow declares. A plugin
that ran its own agents would be a second, invisible scheduler competing with the board's.

So the split is:

| The plugin provides | The board does |
|---|---|
| `skills` — prompt bundles on disk, each naming the `workflow` its tickets should follow | junctions them into the project, launches them as tickets on that workflow |
| `scripts` — one-shot shell commands | runs them on demand and shows the captured output |
| `views` — a command that starts an HTTP server | supervises the process, assigns a port, frames it |
| `loops` — a `plan` command printing outstanding work as JSON | turns each unit into a ticket and runs it |
| `butler` — a markdown fragment | appends it to the assistant's prompt for that project |
| `scaffold` — a markdown template | writes it into the project once, and gates on its TODOs |

If your tool already has its own scheduler, the porting work is mostly *deleting* it: expose the
"what is outstanding" query as a `plan` command and let the board own the rest.

## Lifecycle

**Install** (the Plugins tab's **Marketplace**, `Settings → Plugins`, or
`POST /api/plugins {source}`). `source` is a local directory or a git URL; a URL is cloned
shallowly into the board's plugins home. The manifest is parsed and a row is stored. Installing
does nothing to any project.

The marketplace (`GET /api/plugins/marketplace`) lists every installed plugin plus the entries of
a per-machine catalog file, `<plugins home>/marketplace.json` — a JSON array of
`{ name?, slug?, description?, gitUrl }` objects describing plugins that are one click from
installed. There is no remote registry; the catalog is user-maintained, and entries matching an
installed plugin (by slug or normalized git URL) are absorbed into the installed listing.

**Enable per project** (`POST /api/plugins/:id/enable`). This is where the fan-out happens:

1. **Skills** — each `skills[].dir` is junctioned (symlink; copied if that fails) to
   `<repo>/.claude/skills/<basename of dir>`, and added to `.git/info/exclude` so it never shows
   up as an untracked file. An existing directory of that name is left alone and reported as
   `skipped-existing`.
2. **Scaffold** — `profileTemplate` is written to `targetPath` inside the project **only if that
   file does not already exist**, with `{{placeholders}}` substituted. The board counts the
   remaining `TODO:` markers and warns.
3. **Butler fragment** — appended to the assistant prompt for that project.

A preference `plugin_enabled_<slug>_<projectId>` records the state. Disabling removes the skill
junctions and clears the preference; scaffolded files stay (they are the project's now).

**Use** — the **Plugins** toolbar tab (after Workflows) is a dropdown listing every enabled
plugin; each opens that plugin's own view with its capabilities, and the menu also carries
"Install plugin…" and "Marketplace". Scripts run inline; views open in a framed iframe; skills
and loop units become tickets.

## Where output goes

Per project, a plugin's output location is `leading` (default) or `sidecar`:

- **`leading`** — the project's leading repo. For a single-repo project this is simply "in the
  repo".
- **`sidecar`** — a dedicated repo named `<plugin-slug>-requirements`, added to the project's
  repo set and created on first use.

**`{{repoPath}}` resolves to the OUTPUT repo, not the product repo.** A plugin that must READ the
product source while WRITING its artifacts elsewhere — the common shape for an analysis plugin
run in `sidecar` mode — uses **`{{leadingRepoPath}}`** for the source and `{{repoPath}}` for the
output:

```json
"scripts": [
  { "name": "coverage", "command": "npm run coverage", "cwd": "plugin",
    "env": { "SOURCE_ROOT": "{{leadingRepoPath}}", "COVERAGE_ROOT": "{{repoPath}}" } }
]
```

`{{leadingRepoPath}}` always names the project's leading (product) repo, regardless of the
project's output-location choice — in `leading` mode it is the same path as `{{repoPath}}`; in
`sidecar` mode the two diverge. It is populated at every substitution site (enable/scaffold,
`startView`, `runScript`, `advanceLoop`), so it is available anywhere `{{repoPath}}` is.

A multi-repo project cannot yet address a SIBLING repo (one that is neither leading nor the
plugin's own output) from a manifest at all — see [Known gaps](#known-gaps).

## The four capabilities

### skills

A skill is a directory containing `SKILL.md` (plus whatever it needs — `tools/`, `references/`).
On enable it is junctioned into the project; when a ticket runs, the **whole directory** is
copied into that ticket's worktree, so a skill whose `tools/` is missing documents commands that
do not exist.

```json
"skills": [
  { "dir": ".claude/skills/extract",
    "description": "One-line 'what this does', shown next to its Run button.",
    "workflow": "analysis-task" }
]
```

`dir` must be relative and must not escape the plugin root. The directory's **basename** is the
skill name everywhere else — including `loops[].skill`.

#### Running one

Running a skill creates a ticket and launches a workspace against it — the same path as any
other board work. The launcher gets a **title** and a free-text **additional context** box, and
whatever they type is *appended* to the skill's brief under a heading, never substituted for it
(substituting would drop the sentence naming the skill to run and leave the agent guessing). Write
your `SKILL.md` so it still makes sense when a launcher adds "only the billing module" underneath
it — that is the normal case, not the exception.

The API distinguishes the two, and a caller driving this programmatically should know which it
wants: **`prompt` appends** to the generated brief, **`description` replaces it entirely**. The UI
only ever sends `prompt`.

The launch itself takes **minutes** (worktree → the project's setup script → agent launch) while
the ticket exists within milliseconds. The board streams that as progress, so a launcher sees the
ticket number in the first second. You get this for free; it is worth knowing when someone reports
your skill "did nothing" — check the board for the ticket before believing it.

#### `workflow` — choosing the gates

`workflow` names the workflow template tickets from this skill start on: a **builtin key**
(`analysis-task`, `simple-ticket`, `research-task`, …) or a template **name**. It is optional and
only a DEFAULT — the launcher can pick another per run.

Set it. The board's default for a task is `simple-ticket` (implement → review → done), and that
gate is wrong for most plugin work:

| If your skill… | Use | Because |
|---|---|---|
| writes analysis artifacts (registers, ledgers, docs) | `analysis-task` | no product diff exists, so a reviewer can only rubber-stamp it; this template is work → done on a clean exit, with no review and no human consult |
| changes product code | `simple-ticket` (or omit) | there IS a diff, and it should be reviewed |
| needs a human decision mid-flight | `research-task` | its Consult User node is the point — but never for a loop (see below) |

Two traps:

- **Never give a loop's skill a workflow with a human node.** `research-task` parks the ticket at
  Consult User until someone appears; a loop that advances unattended will simply stop converging.
- A name this board has never heard of is **not** an error — the board logs a warning and falls
  back to its own default. That keeps a plugin installable on a board with different templates,
  but it also means a typo degrades silently. Prefer builtin keys, which are stable across boards.

### scripts

A deterministic one-shot command. This is the right shape for anything that does not need
judgment: a status query, a rebuild, a CI-style gate.

```json
"scripts": [
  { "name": "status", "label": "Status", "description": "Read-only: what state is this in?",
    "command": "node tools/status.mjs", "cwd": "plugin",
    "env": { "MY_ROOT": "{{repoPath}}" } }
]
```

`cwd` is `"plugin"` (the plugin's own checkout) or `"repo"` (the output repo); **scripts default
to `"repo"`**, which is usually not what you want if the script ships with the plugin. Set it
explicitly.

Output is **buffered, not streamed**: the run returns one `{ code, stdout, stderr, timedOut }`
when the process closes, with each stream capped at 16 KB (the tail is kept — it is what diagnoses
a failure). The timeout is **5 minutes**, and hitting it returns `code: null, timedOut: true`
rather than raising. So a script is the wrong shape for anything long-running or worth watching
live; that is what a view or a loop is for.

### views

A supervised child process serving HTTP, framed as a board view.

```json
"views": [
  { "id": "coverage", "label": "Coverage", "kind": "iframe",
    "description": "What this panel shows.",
    "serve": { "command": "node tools/serve.mjs", "cwd": "plugin", "portEnv": "PORT",
               "healthPath": "/health",
               "env": { "MY_ROOT": "{{repoPath}}" } } }
]
```

- `kind` must be `"iframe"`; it is the only kind so far.
- `portEnv` names the environment variable the board sets to the port it allocated. It is the
  usual way to receive the port but not the only one: `{{port}}` is substituted into `serve.command`
  and every `serve.env` value too, so `"command": "node tools/serve.mjs --port {{port}}"` works
  with no `portEnv` at all. What you must not do is *pick* a port — the board allocates one and
  frames that exact port.
- `serve.cwd` is `"plugin"` (the plugin's own checkout) or `"repo"` (the output repo); **views
  default to `"plugin"`**, matching the doc comment. If your server ships with the plugin but
  needs to run against the output repo, set `"cwd": "repo"` and reference the script via
  `{{pluginPath}}` in `command` (relative paths otherwise resolve into `cwd`, not the plugin).
- The readiness probe requests `serve.healthPath` (default `/health`) with any status below 500
  counting as healthy. If that path 404s, the probe falls back to `GET /` — so an existing plugin
  with no dedicated endpoint keeps working unchanged. Prefer adding a cheap, dependency-free
  `/health` route (or set a custom `healthPath`) over relying on the fallback: the probe runs on
  every status check, so for a view that renders a large register or hits a data source per
  request, `/` is the single most expensive request your server gets. A route that only your
  index serves is also the one place a legitimately-erroring index (e.g. a data source mid-write)
  can't be mistaken for the server being down.
- **The board waits for you to bind.** `start` polls the readiness probe (up to 15s, tunable via
  `PLUGIN_VIEW_READY_TIMEOUT_MS`) before answering `ready: true`, so a server that needs a second
  to come up is framed only once it is serving instead of rendering a connection-refused page. If
  you exceed the budget the start still succeeds with `ready: false` and the panel polls — but a
  view that takes 30s to bind looks broken, so bind first and load lazily.
- Read your state **fresh per request**. The process is long-lived; a page built at startup shows
  a snapshot of whenever the panel was first opened, which is worse than no panel.
- Be self-contained: inline CSS and JS, no CDN, no external fonts, no remote images.
- **Board data is reachable via `{{boardUrl}}` + `{{projectId}}`.** Pass them through `serve.env`
  (e.g. `"env": { "BOARD_API": "{{boardUrl}}", "PROJECT_ID": "{{projectId}}" }`) and call
  `GET {{boardUrl}}/api/...` — from your server, or from the iframe page itself (the board's CORS
  reflects loopback origins). The URL is the public one even behind the dev proxy, and a worktree
  board hands out its own port.
- **Handle the empty case.** Your view is started before the pipeline that fills it has ever run,
  and "no data yet" is the state a first-time user sees. A 404 body renders as raw `not found`, and
  a server that exits leaves a broken-document icon — both read as "the plugin is broken". Answer
  200 with a page that says what is missing and names the command that produces it.
- **The panel is small; offer fullscreen.** The board's iframe carries `allow="fullscreen"`, so
  `element.requestFullscreen()` works. Fullscreen the whole workbench — toolbar *and* content — not
  just the canvas, or the controls end up off-screen. The API still *rejects* on an older board (the
  frame is cross-origin, where the default permission allowlist is `self`), so catch the rejection
  and fall back to `position: fixed` inside your own frame.
- **Anything bigger than a page needs interaction.** A single static rendering of a whole dataset
  stops being usable almost immediately. Budget for filters, zoom/pan and a detail pane rather than
  drawing everything at once — the UI-map view in refactor-safety-net is a worked example.

### loops

The interesting one: **board-owned converging analysis**.

```json
"loops": [
  { "name": "extract", "label": "Extract (until converged)",
    "description": "What one unit of this loop does.",
    "skill": "extract",
    "workflow": "analysis-task",
    "maxUnitsPerAdvance": 2,
    "plan": { "command": "node tools/loop-plan.mjs --json", "cwd": "plugin",
              "env": { "MY_ROOT": "{{repoPath}}" } } }
]
```

`skill` must be one of your `skills[]` basenames — the manifest parser rejects a loop naming a
skill it does not declare, because its tickets would carry a skill that never materializes in
the worktree.

`workflow` works exactly as it does on a skill, and falls back to the loop's skill's `workflow`
when omitted. It matters **more** here: a loop creates tickets in bulk with nobody at the keyboard,
so the manifest is the only place the choice can come from, and a template with a review or
consult node will strand every round of the loop behind it.

On each **advance** the board runs `plan.command` and expects JSON on stdout:

```json
{
  "units": [
    { "id": "billing:round-3", "title": "Extract billing, round 3", "description": "The brief the skill runs against." }
  ],
  "converged": false,
  "note": "3/19 modules converged"
}
```

Then, per unit: derive `plugin-loop:<slug>:<loop>:<unitId>`, skip any unit whose key already has
a ticket, and create a ticket for the rest (up to the cap) carrying the loop's skill. The board's
monitor starts them within the WIP limit.

The plan may additionally carry four OPTIONAL structured fields (#286–#290) that the board
renders natively on the loop pane — all forward-compatible, all ignored by older boards:

```jsonc
{
  "units": [{ "id": "step-2:v1", "title": "…",
              "artifacts": ["docs/pm/steps/step-2/prd.md"] }],   // repo-relative, rendered + diffed (#288)
  "converged": false,
  "note": "Step 1 awaits review.",
  "gate": {                                                       // human-approval gate (#286)
    "id": "step-1:v1",                                            // NEW id per decision round — it dedupes the notification
    "question": "Approve step 1 — Market analysis (v1)?",
    "artifacts": ["docs/pm/steps/step-1/analysis.md"],
    "actions": [ { "id": "approve", "label": "Approve" },
                 { "id": "revise", "label": "Needs revision", "input": "text" } ],
    "resolve": { "command": "node tools/gate-resolve.mjs", "cwd": "plugin",
                 "env": { "PM_ROOT": "{{repoPath}}" } }
  },
  "progress": { "steps": [                                        // pipeline stepper (#289)
    { "id": "step-1", "label": "Market analysis", "state": "done", "version": "v2",
      "artifacts": ["docs/pm/steps/step-1/analysis.md"] },
    { "id": "step-2", "label": "PRD", "state": "generating" }     // done|generating|awaiting-approval|needs-revision|locked|failed|pending
  ] },
  "checks": [                                                     // CI-style badges (#290)
    { "name": "Verification (step 1)", "verdict": "warn", "detail": "PASS WITH FIXES" }
  ]
}
```

**How the gate works.** A gate is the structured form of "blocked on a person": report it with
`units: [], converged: false`. The board renders an approval card (question, artifact links,
action buttons — an action with `input: "text"` gets a textarea), notifies the user ONCE per new
gate id (toast + WS `plugin_gate` + desktop notification when permitted), and on a decision runs
your `resolve` command like a plan command with `GATE_ID`, `GATE_ACTION` and — for text actions —
`GATE_INPUT_FILE` (the human's text as a temp FILE, never shell-interpolated) in the env. Your
resolver mutates your own state files (tick the checkbox, write the feedback), exits 0, and the
board immediately re-plans, so the response already carries the gate's replacement state. A
stale decision (the file moved on) should exit non-zero with a one-line reason.

**Where this state is visible.** Every advance is persisted to the loop's timeline
(`GET /api/plugins/:id/loops/:name/events?projectId=` — advances, gate-reached/resolved with the
decision and feedback excerpt, pause/resume, convergence, plus a per-unit cost rollup folded from
each session's `stats.totalCostUsd`). The latest advance's gate/progress/checks are also on every
loop status (`GET .../loops`, the project surface), so the panel renders them without re-running
your planner. Declared artifacts are served fresh from the output repo by
`GET .../loops/:name/artifact?projectId=&path=` (content + the diff between its last two
committed versions — commit each generation and revisions become reviewable diffs for free).
Gate decisions go to `POST .../loops/:name/gate/resolve` `{projectId, gateId, actionId, input?}`.

**Hands-off between gates (#296–#299).** Two hooks close the merge gap that used to need a
human between "agent done" and "gate visible": a loop may declare `"autoLand": true` — its
finished tickets (committed changes, builder exit 0) are then merged automatically, still
through the pre-merge verify gate, without the global `auto_merge_in_review` pref; and every
merge of a loop ticket (however it lands) advances the owning loop as soon as the main
checkout is synced, so the next gate appears seconds after the merge instead of on the next
monitor cycle. A finished-but-unlanded loop ticket is reported per loop as `awaitingMerge`
(workspace id + issue) and rendered as its own card with a one-click Merge. `autoLand` is the
right default for document-producing loops (the merge is what makes the artifact visible to
your planner, which reads the MAIN checkout); leave it off when a loop's tickets change
product code you want reviewed.

**The butler as approval concierge (#307–#310).** On every NEW gate the board (pref
`butler_gate_digest`, default on) wakes the project butler and injects a digest turn —
question, verification verdict, artifact list, and the exact resolve call — so approving can
happen conversationally; the hard rule that it resolves ONLY on an explicit user instruction
rides in that prompt and in the MCP tool descriptions (`list_plugin_gates`,
`get_plugin_gate`, `resolve_plugin_gate`, `advance_plugin_loop`). With
`butler_gate_recommendation` (default on) the butler also pre-reads the gate's artifacts and
stores a structured approve/revise verdict (`gate-recommendation` timeline event), which the
gate card shows as a chip with one-click accept. Two more concierge endpoints:
`POST .../loops/:name/gate/draft {gateId, notes}` turns rough notes into submit-ready
revision feedback, and `PUT .../loops/:name/artifact {gateId, path, content}` lets the human
edit a gate artifact in place (committed pathspec-limited) before approving — so a typo
doesn't cost a full revision round. Gate decisions are also mirrored onto the loop ticket as
`gate-decision` comments, and every pending decision across ALL projects is aggregated at
`GET /api/inbox` (rendered in the notification bell's "Waiting on you" section).

Two more authoring conveniences: `POST /api/plugins/validate {source}` parses a LOCAL plugin
directory's manifest and checks every referenced file without installing, and `GET /api/plugins`
reports `manifestDrift: true` when the manifest on disk differs from the cached copy the board
runs (the fix is `POST /api/plugins/:id/update`). The scaffold's unresolved `TODO:` markers are
also editable as a form (`GET|POST /api/plugins/:id/scaffold`) — the Plugins panel shows a
"Setup" entry while any remain, so scaffold authors should write each marker as
`TODO: <short label a form can show>`.

Parsing is tolerant of noise **before** the JSON: the scan walks backwards for the last offset
that parses, so npm notices and tsx warnings ahead of your output do not break you, and a bare
array is accepted as `{units: [...]}`. Exit non-zero or print nothing and the advance fails loudly
with your output attached. There is a **2-minute timeout**.

Two ways that tolerance runs out, both of which fail with the unhelpful `loop plan output is not
JSON`:

- **Nothing may follow the JSON.** The parse must consume to the end of stdout, so a warning, a
  timing line or a shell epilogue printed *after* your plan breaks the whole advance. Print the
  plan last, and route diagnostics to stderr.
- **Captured stdout is capped at 16 KB, keeping the TAIL.** A plan larger than that loses its
  opening `{`, so nothing parses. A planner emitting many units with prose descriptions reaches
  this sooner than you would expect — keep unit descriptions short (they are a brief, not the
  work) and let `maxUnitsPerAdvance` bound the round rather than emitting hundreds of units.

#### Four loop rules that will bite you

Every one of these fails *silently* — the loop looks fine and the work does not happen.

1. **A unit id is a permanent dedupe key.** An advance skips any unit already ticketed — terminal
   or not. Re-reporting `billing` forever is read as "already ticketed" and does nothing. Work
   that needs another pass must get a **fresh id**: `billing:round-3`, `interp:B04#2`. This is
   what makes an infinite ticket loop impossible without the board second-guessing your plan.
2. **`converged` is a claim about the whole job, not about this moment's ready set.** If your
   loop has nothing to do *right now* because something upstream is unfinished, report
   `units: [], converged: false` — the board's "blocked, not done". Same for work blocked awaiting
   a decision: not converged.

   Be clear about what the flag does: `converged: true` **with no units** is the loop's terminal
   verdict and it is **persisted** per project (`plugin_loop_converged_<slug>_<loop>_<projectId>`).
   The monitor then stops advancing that loop, so your planner is not re-run forever. Two things
   this does NOT do: `converged: true` *with* units still creates those tickets (and clears the
   flag — a planner handing out work has not converged), and `converged: false` with no units
   keeps the loop being polled, which is the whole point of the blocked-not-done case. A converged
   loop is restarted by a manual **Advance now**, which never consults the flag; the per-loop
   **pause** (below) remains the way to stop a loop that is still reporting work.
3. **The planner runs on every advance, including the very first, when nothing is set up.** It
   must not throw. Report the precondition as a note (`"profile not filled in"`,
   `"no revision pinned"`) with no units and `converged: false`. A stack trace here blocks the
   advance and tells the user nothing.
4. **`maxUnitsPerAdvance` defaults to 10.** If one unit is expensive — a fan-out of agents, a
   large corpus — set it to 1 or 2. Ten expensive tickets created at once will drain a quota
   window. Capped units simply replan on the next advance; the board warns rather than dropping
   them silently.

#### Loops and the monitor

`advanceDuePluginLoops` (the monitor pass) **continues** loops that already have tickets and
never starts one. A human presses advance once; after that a round is replanned when its tickets
are all terminal.

For hands-off running the project's **Start Mode must be `monitor`**. Under `manual` the monitor
pass skips the project *entirely* — your planner is never run and no tickets are created at all,
which looks identical to a loop that has quietly converged. (The "tickets created but not started"
warning on the advance result only appears when a human presses Advance in the UI, which works
regardless of Start Mode.)

**Pause is the off switch.** Each loop has a per-project pause preference, toggled from its panel
or `POST /api/plugins/:id/loops/:name/pause|resume`. A paused loop is skipped by the monitor —
manual Advance still works — so it is how you stop a loop that is still reporting units. (A loop
that has *reported convergence* stops on its own; see rule 2.) If a loop mysteriously stops
advancing, check pause and the persisted convergence flag before suspecting the planner.

### butler

```json
"butler": { "promptFragment": "butler-fragment.md" }
```

Appended to the assistant's prompt for every project where the plugin is enabled. Write it for
an assistant that must answer questions about your plugin's output and knows nothing else about
it: what the artifacts are, where they live, what the loops do, and — most usefully — **what it
must not decide on the user's behalf**.

### docs

```json
"docs": [{ "file": "docs/overview.html", "title": "Guide: which part when?", "description": "…" }]
```

Plugin-authored pages the board shows in its **Plugins menu** and renders inside the panel
(iframe), served straight from the plugin checkout via `GET /api/plugins/:id/docs/<file>`
(`GET /api/plugins/docs` lists them). Use it for the thing a rail of loops and scripts cannot
say: how the plugin's parts fit together, what to run first, which entry answers which
question. `.html` or `.md`, path relative to the plugin root, must stay inside it. An HTML doc
that honours `:root[data-theme="dark"|"light"]` follows the board's theme (`?theme=` is
stamped on `<html>`). The board holds no doc and no plugin name of its own here — what is
listed is exactly what the installed manifests declare, so a board without your plugin shows
nothing about it.

### scaffold

```json
"scaffold": { "profileTemplate": "profile-template.md", "targetPath": "docs/analysis/_profile.md" }
```

Written into the project on enable, once. Its purpose is to make a human state something the
plugin must not guess: scope, language, which directories matter.

The **`TODO:` markers are a real gate**. The board counts markers outside inline-code spans
(`countScaffoldPlaceholders`) and **refuses to run this plugin's scripts and loops** while any
remain, with an actionable error. Two consequences:

- A template with no `TODO:` markers is treated as "already filled in" — the gate never fires.
- Explain a marker as `` `TODO:` `` in backticks when you are describing the mechanism, or your
  own explanation counts as an unfilled placeholder forever.
- **A missing file is also treated as "filled in".** The gate reads the target and, finding
  nothing, passes. That matters when the output location changes: the scaffold is written once, at
  enable, into whatever the output repo was *then*, and switching to `sidecar` afterwards does not
  re-write it. The plugin then runs against a sidecar with no profile file and no gate. Switch the
  output location **before** enabling, or disable and re-enable after switching.

## `audience` — say which entries are diagnostics

The board renders every enabled capability into one **rail** down the left of the Plugins view.
By default it renders them all at the same weight, which is wrong for most plugins: a real one
ships a selftest, a dry-run planner dump, a status query and the skill its own loop launches —
so the single entry that is the actual workflow ends up buried among four debugging tools, and
a couple of them (running a loop's skill by hand, most of all) actively create duplicate work
when pressed by someone who assumed they were part of the job.

Mark those entries:

```json
"scripts": [
  { "name": "status",   "command": "node tools/status.mjs", "cwd": "plugin" },
  { "name": "selftest", "command": "node tools/selftest.mjs", "cwd": "plugin",
    "audience": "developer" }
],
"skills": [
  { "dir": ".claude/skills/operate" },
  { "dir": ".claude/skills/step-runner", "audience": "developer" }
]
```

- Valid on `skills[]`, `scripts[]` and `views[]`. Values: `"operator"` (default) and `"developer"`.
- **Omitting it means `operator`** — a manifest written before this field existed renders exactly
  as it always did.
- `developer` entries move into a collapsed **Diagnostics** disclosure at the bottom of the rail.
  Nothing is hidden or disabled: the disclosure is one click, and it opens itself whenever the
  selected entry lives inside it.
- **Loops carry no audience.** A loop is the workflow the panel exists to drive, and loops are now
  rendered as the first group in the rail.

Rule of thumb: mark it `developer` when a person *running your pipeline* would never press it —
anything that validates the plugin's own fixtures, dumps internal state, or is launched by a loop
on its own.

## Placeholders and env

Available in every `command` and every `env` value, and in the scaffold template:

| Placeholder | Value |
|---|---|
| `{{repoPath}}` | the **output** repo (leading repo, or sidecar — see above) |
| `{{leadingRepoPath}}` | the project's **leading (product)** repo, regardless of output location |
| `{{projectName}}` | the project's display name (may contain spaces and capitals — slugify it yourself) |
| `{{pluginPath}}` | the plugin's own checkout |
| `{{port}}` | views only, filled at serve time |
| `{{boardUrl}}` | the board API's externally reachable base URL, no trailing slash (e.g. `http://localhost:3001`) — call `{{boardUrl}}/api/...` to read board data. Always the PUBLIC port: in dev the backend binds an internal port behind a proxy, and this is the proxy; a worktree server on 3001+N hands out its own URL. CORS already reflects loopback origins, so an iframe view page can fetch it directly. |
| `{{projectId}}` | the id of the project the view/script/loop was started for — pass it as `projectId` in board API calls |

An unknown placeholder is left as-is. Paths are absolute; on Windows they contain backslashes.
`{{boardUrl}}`/`{{projectId}}` are substituted in view serve commands/env, script commands/env,
loop plan commands/env, and butler fragments — but **not** into the scaffold template: the
scaffold is written once at enable and committed, and a URL frozen at enable time goes stale the
first time the board runs on another port.

Two exceptions worth knowing before you build a path out of one:

- **They point at the MAIN checkout, not the worktree the ticket will run in.** The board hands
  your planner (and scripts, and view servers) the project's own repo path. The agent that later
  picks up the ticket works in a *git worktree* at a different path, and writes outside it are
  blocked by a safety hook. So a unit brief that says "write your findings to
  `<{{repoPath}}>/.myplugin/findings/x.json`" hands the agent a path it is not allowed to touch —
  it plans fine and fails at run time. Have the brief name paths **relative to the repo root** and
  let the agent resolve them inside its own worktree; use the absolute path only for what the
  planner itself reads.
- **In a butler fragment, a sidecar that does not exist yet resolves to the LEADING repo.** The
  fragment site substitutes the output repo like everywhere else, but it resolves it without
  CREATING anything (assembling a prompt must not materialize a repo), so a project set to
  `sidecar` before the sidecar has been created gets the leading repo. Once anything has run —
  enable, a script, a loop — the sidecar exists and the placeholder is correct.

## Plugins that form an *improvement net*

Several plugins are written to work **together** on one job — tool-assisted, ambitious refactoring
of large legacy projects, done safely. The board calls that family an **improvement net**, and
the pattern is worth knowing even if you write only one part of it, because each part has a
place and a hand-off:

| Stage | Job | What the plugin contributes |
|---|---|---|
| **understand & protect** | pin what the system does before touching it | requirement/coverage loops, dashboards (views), page-object skills |
| **measure** | where is the structural debt | metrics scripts, `--post-board` into Quality Metrics (`quality_metrics` table) |
| **find potential** | what should change, and why | analysis loops whose units become tickets (`pattern:`, `refactor:`, `arch:` prefixes) |
| **change safely** | do it without breaking consumers | deterministic refactor verbs materialised as skills into every worktree; the board's review + pre-merge gate + the safety net's tests are the guard |
| **track & learn** | did it help — and what did the tools lack | re-measure → Quality Metrics trend; a *friction-filing* skill that routes a verb gap as a ticket to the toolset's own board project |

Two things make it a **net** rather than four tools: (1) **findings become tickets the board
drives** — a plugin never applies a change itself, it tickets the unit and the board's builder,
review and merge gate do the rest; (2) **it runs in both directions** — downstream, findings
→ tickets → safe changes; upstream, what a project needs but the tools lack goes back to the tool
as backlog (today reactively, via the friction skill; the planned next step is forecasting it from
an imported project's tickets against the toolset's capability matrix). Ship a `docs[]` page
(see [docs](#docs)) that says which part answers which question — the board shows it in the
Plugins menu, and it is the single most useful thing for an operator picking a plugin.

## Design guidance from the plugins that exist

**Keep per-project state out of the plugin checkout.** One install should serve any number of
projects. If your tool writes its state next to its own code, N projects means N clones, each
carrying one project's history. Take the location from an env var (`{{repoPath}}/.myplugin`) and
default to the checkout only when running standalone.

**Do not ticket free work.** If your plan DAG contains deterministic steps — a gate, a rebuild,
an index — run them inline inside whichever ticket reaches them. A ticket per gate costs an agent
launch and buys nothing.

**Agents run in worktrees.** Loop tickets get their own git worktree of the project repo. Two
consequences: writes outside that worktree are blocked by a safety hook, and if your state is a
single mutable JSON file that every unit rewrites, parallel units will conflict. Prefer
append-only files with a derived snapshot, or state that lives in one place outside the
worktrees.

**Make the unit brief self-contained.** The agent that picks up a ticket has the description, the
skill, and the repo. Say which unit it is, which invariants apply, what to do when it finishes,
and — for a retry — what *not* to redo.

## Ship an operator skill, not just work skills — RECOMMENDED

Every plugin today declares skills that do the WORK inside a ticket, and a `butler.promptFragment`
that tells an agent how to CONSUME the output. Nothing tells an agent how to **drive the plugin
itself** — enable it, advance a loop, run the resulting tickets, know when it has converged. So an
agent asked to "run the extraction on this project" has to rediscover the board's plugin API and
its sharp edges from source, every time. Both requirement-extraction plugins were driven that way
once and it cost hours; the notes below are what that cost bought.

**The convention:** ship one more skill whose subject is the plugin's own operation. It reads
`kanban-plugin.json` for the loop names, `maxUnitsPerAdvance` and script names rather than
hardcoding them, and it encodes the operating sequence plus the traps. Name it after the plugin
(`<plugin>-operate`) so it is obvious which one drives which.

### The operating sequence

```
GET  /api/plugins?projectId=<p>                     → installed AND enabled-for-this-project?
POST /api/plugins/:id/enable        {projectId}     → enabling junctions the skills into the repo
GET  /api/plugins/:id/loops?projectId=<p>           → loop names, open/closed counts, paused
POST /api/plugins/:id/loops/:name/advance {projectId}
     → { planned, created[], skippedExisting[], capped, converged, note, warnings[] }
POST /api/workspaces               {issueId, skillName, skipSetup}   → provision a worktree
POST /api/workspaces/:id/launch    {}               → start the agent
GET  /api/workspaces/:id                            → sessionStatus / lastSessionAt
POST /api/plugins/:id/scripts/:name/run {projectId} → the plugin's own status scripts
```

### Traps, each of which has cost a real session

- **`advance` creates ISSUES, not running work.** With board monitoring disabled it provisions no
  workspace at all, so a sweep looks stalled while the loop keeps planning. Provision + launch
  explicitly, or check monitoring first — do not assume "created" means "running".
- **Session state is NOT on the workspace LIST endpoint.** `GET /api/workspaces?projectId=…` omits
  `sessionStatus` and `lastSessionAt`; only `GET /api/workspaces/:id` joins them. Polling the list
  reports every workspace as idle, so a driver skips its wait and advances over agents that are
  still writing.
- **Wait for the wave before the next advance.** A converging loop plans round N+1 from what round
  N left behind. Advancing mid-round replans the round in flight.
- **A failed write may already have committed.** A call that returns
  `dev_server_backend_unavailable` can have created the issue and lost only the response.
  Re-check by title before retrying, or you double-create.
- **The loop dedupes by `externalKey`, which hand-made tickets do not have.** Mixing manual
  `skills/run` tickets with loop-driven ones therefore always duplicates the unit.
- **`prompt` appends to the skill's brief; `description` REPLACES it.** A driver almost always
  wants `prompt`.
- **`skipSetup` for read-only work.** A docs/analysis mining task does not need the project's build;
  a cold build per worktree across N modules is pure critical-path cost.
- **Untracked files are invisible in a worktree.** If the plugin reads a config the target has not
  committed (a profile, a context map), a fresh worktree cannot see it and the skill silently falls
  back to its built-in defaults — which are another stack's. Seed it, or commit it.
- **The public port is a proxy.** A dev server serves the UI on one port and the API on
  `port + 10000`; when the backend dies the proxy still answers and every write returns
  `dev_server_backend_unavailable`. Check the backend port directly before believing the board is up.
- **The CLI and a checkout dev server can use different databases.** `pnpm cli -- list` is not
  evidence about what the running server sees; ask the API.

### What a driver should reuse rather than reinvent

- the **manifest** (`loops[]`, `scripts[]`, `maxUnitsPerAdvance`) — it is the machine-readable
  contract for what this plugin can be told to do;
- the plugin's own **status scripts** (`loop-status`, `driver-health`) over ad-hoc commands;
- the **butler fragment** for consumer-side vocabulary, so the operator skill can stay purely about
  operation and link to it instead of restating it.

## A minimal plugin, end to end

```
my-plugin/
  kanban-plugin.json
  butler-fragment.md
  profile-template.md
  .claude/skills/my-analysis/SKILL.md
  tools/loop-plan.mjs
  tools/status.mjs
  tools/serve.mjs
```

`kanban-plugin.json`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "One paragraph: what this is for, shown in Settings → Plugins.",
  "skills": [
    { "dir": ".claude/skills/my-analysis",
      "description": "Analyse one module and write its findings.",
      "workflow": "analysis-task" }
  ],
  "loops": [
    { "name": "analyse", "label": "Analyse (until converged)",
      "description": "One ticket per module, until every module is covered.",
      "skill": "my-analysis", "workflow": "analysis-task", "maxUnitsPerAdvance": 2,
      "plan": { "command": "node tools/loop-plan.mjs", "cwd": "plugin",
                "env": { "MY_ROOT": "{{repoPath}}", "MY_PROJECT": "{{projectName}}" } } }
  ],
  "views": [
    { "id": "findings", "label": "Findings", "kind": "iframe",
      "description": "What has been found so far.",
      "serve": { "command": "node tools/serve.mjs", "cwd": "plugin", "portEnv": "PORT",
                 "healthPath": "/health",
                 "env": { "MY_ROOT": "{{repoPath}}" } } }
  ],
  "scripts": [
    { "name": "status", "label": "Status", "description": "Read-only progress.",
      "command": "node tools/status.mjs", "cwd": "plugin",
      "env": { "MY_ROOT": "{{repoPath}}" } }
  ],
  "butler": { "promptFragment": "butler-fragment.md" },
  "scaffold": { "profileTemplate": "profile-template.md", "targetPath": "docs/analysis/_my-plugin.md" }
}
```

`tools/loop-plan.mjs` — the whole planner contract in one file:

```js
#!/usr/bin/env node
// Prints outstanding work as JSON. Deterministic, spawns nothing, never throws.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.MY_ROOT;
const emit = (units, converged, note) => {
  console.log(JSON.stringify({ units, converged, note }, null, 2));
  process.exit(0);
};

// Rule 3: preconditions are a NOTE, never a throw.
if (!root || !existsSync(root)) emit([], false, 'MY_ROOT is not set or does not exist');

const profile = join(root, 'docs/analysis/_my-plugin.md');
if (!existsSync(profile)) emit([], false, 'profile not written — enable the scaffold for this project');
// Same rule the board applies: markers outside inline code.
const todos = (readFileSync(profile, 'utf8').replace(/`[^`\n]*`/g, '').match(/TODO:/g) ?? []).length;
if (todos) emit([], false, `${todos} unfilled TODO(s) in the profile — a human decides scope`);

const state = existsSync(join(root, '.my-plugin/state.json'))
  ? JSON.parse(readFileSync(join(root, '.my-plugin/state.json'), 'utf8'))
  : { done: [], rounds: {} };

const modules = readdirSync(join(root, 'src'), { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => e.name);
const outstanding = modules.filter(m => !state.done.includes(m));

// Rule 1: a fresh id per pass. Rule 2: converged only when the JOB is done.
emit(
  outstanding.map(m => {
    const round = (state.rounds[m] ?? 0) + 1;
    return {
      id: `${m}:round-${round}`,
      title: `Analyse ${m} (round ${round})`,
      description: `Run the \`my-analysis\` skill against \`src/${m}\`.\n\n`
        + `Write findings to \`.my-plugin/findings/${m}.json\` and add "${m}" to \`state.done\` `
        + `when the module is saturated. Append; never rewrite another module's entry.`,
    };
  }),
  outstanding.length === 0,
  `${state.done.length}/${modules.length} modules done`,
);
```

## Testing a plugin before it touches a board

Two scripts, both worth writing. The `reqextract` plugin has working versions
(`tools/plugin/validate.mjs`, `tools/plugin/selftest.mjs`) if you would rather copy than write.

**Validate the manifest with the board's own parser** — then check every declared path exists,
and *run every planner*, because a manifest can be perfect and still ship a planner that throws
on a fresh project:

```sh
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const { parsePluginManifest } =
  await import('file://<board>/packages/shared/dist/lib/plugin-manifest.js');
const m = parsePluginManifest(readFileSync('kanban-plugin.json', 'utf8'));
console.log('manifest ok:', m.id, (m.loops?.length ?? 0) + ' loop(s)');
"
```

Notes that cost time to rediscover: `--input-type=module` is required for the top-level `await`,
the import needs a `file://` URL for an absolute path, and this uses `dist/` — so the board's
shared package must be built (`pnpm -r build`). Without a built board, re-implement the rules
locally; they are short and the error messages are worth copying.

**Self-test the surface** against a scratch copy of a fixture project, offline, with no board and
no agents. Cover, at minimum:

- an unfilled scaffold blocks every loop, and creates nothing
- the first advance on a bare project returns a sensible plan instead of throwing
- unit ids are unique within a plan, and a retry gets a *fresh* id
- `converged` is `false` while anything is outstanding or blocked, and `true` only when done
- the view server binds `PORT`, answers `/health`, and reflects live state
- no state leaked into the plugin checkout

## Checklist

- [ ] `kanban-plugin.json` at the repo root; `id` matches `^[a-z0-9-]+$`
- [ ] every `skills[].dir` exists and contains `SKILL.md`, with a one-line `description`
- [ ] every `skills[].workflow` set — `analysis-task` for doc-writing work; omitting it means
      implement → review → done, whose review gate has nothing to judge
- [ ] no loop's workflow contains a human node (`research-task` stalls a loop at Consult User)
- [ ] every `loops[].skill` is one of those skill basenames
- [ ] `SKILL.md` still reads correctly with a launcher's extra context appended under it
- [ ] `scripts[].cwd` set explicitly (it defaults to `"repo"`)
- [ ] every diagnostic entry (selftest, dry run, a loop's own skill) marked `"audience": "developer"`
- [ ] `views[].serve.portEnv` set; the server binds it, answers `/health` (or `serve.healthPath`),
      and re-reads state per request
- [ ] every view renders a useful page BEFORE the pipeline has ever run, and offers fullscreen
- [ ] the planner never throws, reports preconditions as notes, and returns `converged: false`
      when blocked
- [ ] unit ids are fresh per pass
- [ ] `maxUnitsPerAdvance` matched to what one unit actually costs
- [ ] scaffold template has `TODO:` markers outside inline code
- [ ] no per-project state written inside the plugin checkout
- [ ] butler fragment says what the plugin must *not* decide for the user
- [ ] a self-test that runs offline, and passes

## Parser rules that reject a manifest

`parsePluginManifest` fails loudly with a field-precise message rather than accepting something
half-valid. The rules that are easy to trip:

- `id` must match `^[a-z0-9-]+$`; `name` is required.
- Every path field — `skills[].dir`, `butler.promptFragment`, `scaffold.profileTemplate`,
  `scaffold.targetPath` — must be **relative**, must not contain `..`, and must not end with a
  slash (the trailing slash breaks the basename a skill's NAME is derived from).
- `scaffold.targetPath` may not write inside `.git/`.
- `loops[].name` must match `[A-Za-z0-9._-]+` — no colon, since the name is a segment of the
  `:`-joined ticket dedupe key and unit ids legitimately contain colons.
- **Duplicate ids are errors**, not last-wins: `views[].id`, `scripts[].name`, `loops[].name`.
- `loops[].skill` must be one of your `skills[]` basenames.
- `maxUnitsPerAdvance` must be a positive integer.
- `views[].kind` must be `"iframe"`.
- `audience` (on `skills[]`, `scripts[]`, `views[]`) must be `"operator"` or `"developer"` when
  present; absent means `"operator"`.
- In a plan: every unit needs an `id` and a `title`, and duplicate unit ids **within one plan**
  are an error.
- **Unknown top-level fields are ignored**, deliberately — a manifest using a newer field stays
  loadable on an older board (that field simply does nothing, which is why a `workflow` this board
  has never heard of degrades rather than failing).

## Reference implementations

| Plugin | Shows |
|---|---|
| **refactor-safety-net** | the first plugin: many skills, several views, a large script surface, one loop |
| **reqextract** | four loops (one per pipeline tier) with a bootstrap unit, retry ids, state outside the checkout via an env var, a manifest validator and an offline end-to-end self-test |

## Where this lives in the board

| Concern | File |
|---|---|
| the contract (types, parser, helpers) | `packages/shared/src/lib/plugin-manifest.ts` |
| install, enable, fan-out, views, scripts, skills | `packages/server/src/services/plugin.service.ts` |
| loop advance: plan → dedupe → tickets | `packages/server/src/services/plugin-loop.service.ts` |
| the monitor pass that continues loops | `packages/server/src/services/plugin-loop-monitor.ts` |
| running a plugin command | `packages/server/src/services/plugin-exec.ts` |
| REST surface | `packages/server/src/routes/plugins.ts` |
| the panes that launch skills/loops/scripts | `packages/client/src/components/PluginActionPanes.tsx` |
| workflow templates a `workflow` name resolves against | `packages/server/src/db/builtin-workflows.ts` |

Endpoints you will use while developing (all take the plugin ROW id — see below):

| Endpoint | For |
|---|---|
| `POST /api/plugins {source}` | install / re-read a local manifest |
| `DELETE /api/plugins/:id` | remove the row and disable it (files kept) |
| `POST /api/plugins/:id/enable\|disable {projectId}` | per-project on/off |
| `GET\|POST /api/plugins/:id/output-location` | read/set `leading` vs `sidecar` — the only way to choose |
| `GET /api/plugins/:id/loops?projectId=` | per-loop ticket counts (planner NOT run) |
| `POST /api/plugins/:id/loops/:name/advance` | one advance |
| `POST /api/plugins/:id/loops/:name/pause\|resume` | stop/allow monitor auto-advance |
| `POST /api/plugins/:id/scripts/:name/run` | run a script |
| `POST /api/plugins/:id/skills/:name/run` | launch a skill — body `{ projectId, title?, prompt?, description?, workflowTemplateId? }`, add `?stream=1` for SSE progress |
| `POST /api/plugins/:id/views/:viewId/start\|stop` | supervise a view |
| `GET /api/projects/:projectId/plugin-surface` | everything enabled for a project, as the panel sees it |
| `GET /api/workflows/templates?projectId=` | the `workflow` names you can target |

**`:id` in every one of those routes is the plugins-table row UUID, not your manifest `id`.** The
slug lives in the row's `pluginId` column. Passing the slug gets a 404; read the real id from
`GET /api/plugins` or the plugin surface.

**Editing the manifest of an installed plugin does not update the board.** The parsed manifest is
stored in the `plugins` row at install time. Use **Update** (the button on the plugin's
marketplace card, or `POST /api/plugins/:id/update`): for a git-sourced plugin it runs
`git pull --ff-only` in the clone under `~/.agentic-kanban/plugins/` and then re-reads the
manifest; for a local-directory plugin it only re-reads the manifest (your checkout is never
pulled). When the pull actually moves HEAD, the plugin's running view servers are stopped so the
next start serves the new code. An update whose manifest `id` changed upstream is refused —
per-project enablement is keyed by the slug, so that case is uninstall + reinstall. (Re-running
`POST /api/plugins` with the same source still works as a manifest re-read for local
directories, but for git URLs the clone step is skipped when the directory exists — no fetch, no
pull — so `update` is the right verb.)

Because the upsert key is the manifest `id`, two plugins sharing an `id` silently overwrite each
other's row. Namespace it.

### Known gaps

- **No way to address a SIBLING repo.** `{{leadingRepoPath}}` (product repo) and `{{repoPath}}`
  (output repo, leading or sidecar) are both explicit now (see
  [Where output goes](#where-output-goes)), but a multi-repo project's OTHER siblings — repos that
  are neither leading nor the plugin's own output — have no placeholder at all. A plugin that
  needs to analyse two repos still cannot name the second one.
- **Loop dedupe rides on `issues.externalKey`** (#201), a column documented and rendered as a
  genuine external-tracker link. Safe today because the key is namespaced and loop tickets never
  set `externalUrl`; a second "machine-created, dedupe on re-run" feature should get its own
  column.
- **`views[].kind` is `"iframe"` only.**
- **A skill cannot declare typed inputs.** The launcher gets one free-text box. A skill that really
  wants "which module?" as a choice can only ask for it in prose and hope, and a loop's planner
  cannot be parameterised from the UI at all.
- **`workflow` cannot ship its own template.** A plugin can only name a workflow the board already
  has. If none of the builtins fit your shape of work, the operator has to build the template by
  hand in the Workflows view before your `workflow` name resolves — and until then it silently
  falls back to the board default.
- **`analysis-task` has no human beat.** Its only edge into Done is `auto_on_exit_0`, so a round
  the agent exits cleanly from is Done with nobody looking; the plugin's own convergence check and
  the board's merge preflight are the only remaining gates. That is the right trade for unattended
  loops and the wrong one if you want a human to see each round.
