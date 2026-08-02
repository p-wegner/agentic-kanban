# Writing a plugin

Everything needed to build a plugin for this board, assuming no prior knowledge of it. Read
top to bottom the first time; after that, the [checklist](#checklist) and the
[field reference](#manifest-field-reference) are what you come back for.

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
selection, resumable after a restart, and subject to the normal review and merge gates. A plugin
that ran its own agents would be a second, invisible scheduler competing with the board's.

So the split is:

| The plugin provides | The board does |
|---|---|
| `skills` — prompt bundles on disk | junctions them into the project, launches them as tickets |
| `scripts` — one-shot shell commands | runs them on demand, streams the output |
| `views` — a command that starts an HTTP server | supervises the process, assigns a port, frames it |
| `loops` — a `plan` command printing outstanding work as JSON | turns each unit into a ticket and runs it |
| `butler` — a markdown fragment | appends it to the assistant's prompt for that project |
| `scaffold` — a markdown template | writes it into the project once, and gates on its TODOs |

If your tool already has its own scheduler, the porting work is mostly *deleting* it: expose the
"what is outstanding" query as a `plan` command and let the board own the rest.

## Lifecycle

**Install** (`Settings → Plugins`, or `POST /api/plugins {source}`). `source` is a local
directory or a git URL; a URL is cloned shallowly into the board's plugins home. The manifest is
parsed and a row is stored. Installing does nothing to any project.

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

**Use** — the **Plugins** board view is where all four capabilities are started. Scripts run
inline; views open in a framed iframe; skills and loop units become tickets.

## Where output goes

Per project, a plugin's output location is `leading` (default) or `sidecar`:

- **`leading`** — the project's leading repo. For a single-repo project this is simply "in the
  repo".
- **`sidecar`** — a dedicated repo named `<plugin-slug>-requirements`, added to the project's
  repo set and created on first use.

**`{{repoPath}}` resolves to the OUTPUT repo, not the product repo.** There is no separate
placeholder for the leading repo. So a plugin that must READ the product source while WRITING
its artifacts elsewhere cannot express that in sidecar mode — both paths would point at the
sidecar, and the plugin would analyse an empty repository and honestly report nothing. Until the
contract grows a `{{leadingRepoPath}}`:

- if your plugin reads the source, document that it requires `leading` (the default), and
- if it needs its output elsewhere, take an absolute path in its own env var rather than
  switching the board's output location.

## The four capabilities

### skills

A skill is a directory containing `SKILL.md` (plus whatever it needs — `tools/`, `references/`).
On enable it is junctioned into the project; when a ticket runs, the **whole directory** is
copied into that ticket's worktree, so a skill whose `tools/` is missing documents commands that
do not exist.

```json
"skills": [
  { "dir": ".claude/skills/extract", "description": "One-line 'what this does', shown next to its Run button." }
]
```

`dir` must be relative and must not escape the plugin root. The directory's **basename** is the
skill name everywhere else — including `loops[].skill`.

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

### views

A supervised child process serving HTTP, framed as a board view.

```json
"views": [
  { "id": "coverage", "label": "Coverage", "kind": "iframe",
    "description": "What this panel shows.",
    "serve": { "command": "node tools/serve.mjs", "cwd": "plugin", "portEnv": "PORT",
               "env": { "MY_ROOT": "{{repoPath}}" } } }
]
```

- `kind` must be `"iframe"`; it is the only kind so far.
- `portEnv` names the variable the board sets — **without it the board cannot tell your server
  which port to use** and the view will not come up.
- `serve.cwd` is **currently ignored**: a view server always runs in the plugin checkout. The
  field parses, so writing `"plugin"` is harmless and future-proof; writing `"repo"` will not do
  what it says.
- The readiness probe is `GET /` with any status below 500. You do not need a `/health` route,
  though one is convenient for your own tests.
- Read your state **fresh per request**. The process is long-lived; a page built at startup shows
  a snapshot of whenever the panel was first opened, which is worse than no panel.
- Be self-contained: inline CSS and JS, no CDN, no external fonts, no remote images.

### loops

The interesting one: **board-owned converging analysis**.

```json
"loops": [
  { "name": "extract", "label": "Extract (until converged)",
    "description": "What one unit of this loop does.",
    "skill": "extract",
    "maxUnitsPerAdvance": 2,
    "plan": { "command": "node tools/loop-plan.mjs --json", "cwd": "plugin",
              "env": { "MY_ROOT": "{{repoPath}}" } } }
]
```

`skill` must be one of your `skills[]` basenames — the manifest parser rejects a loop naming a
skill it does not declare, because its tickets would carry a skill that never materializes in
the worktree.

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

Parsing is deliberately tolerant: the **last** JSON value in stdout wins, so npm notices and
tsx warnings do not break you, and a bare array is accepted as `{units: [...]}`. Exit non-zero
or print nothing and the advance fails loudly with your output attached. There is a **2-minute
timeout**.

#### Four loop rules that will bite you

Every one of these fails *silently* — the loop looks fine and the work does not happen.

1. **A unit id is a permanent dedupe key.** An advance skips any unit already ticketed — terminal
   or not. Re-reporting `billing` forever is read as "already ticketed" and does nothing. Work
   that needs another pass must get a **fresh id**: `billing:round-3`, `interp:B04#2`. This is
   what makes an infinite ticket loop impossible without the board second-guessing your plan.
2. **`converged` is a claim about the whole job, not about this moment's ready set.** If your
   loop has nothing to do *right now* because something upstream is unfinished, report
   `units: [], converged: false` — the board's "blocked, not done". Reporting `true` ends the
   loop, and an ended loop needs a human to restart it. Same for work that is blocked awaiting a
   decision: not converged.
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
are all terminal. And for hands-off running the project's **Start Mode must be `monitor`** —
otherwise tickets are created and never started, which the advance result warns about.

### butler

```json
"butler": { "promptFragment": "butler-fragment.md" }
```

Appended to the assistant's prompt for every project where the plugin is enabled. Write it for
an assistant that must answer questions about your plugin's output and knows nothing else about
it: what the artifacts are, where they live, what the loops do, and — most usefully — **what it
must not decide on the user's behalf**.

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

## Placeholders and env

Available in every `command` and every `env` value, and in the scaffold template:

| Placeholder | Value |
|---|---|
| `{{repoPath}}` | the **output** repo (leading repo, or sidecar — see above) |
| `{{projectName}}` | the project's display name (may contain spaces and capitals — slugify it yourself) |
| `{{pluginPath}}` | the plugin's own checkout |
| `{{port}}` | views only, filled at serve time |

An unknown placeholder is left as-is. Paths are absolute; on Windows they contain backslashes.

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
    { "dir": ".claude/skills/my-analysis", "description": "Analyse one module and write its findings." }
  ],
  "loops": [
    { "name": "analyse", "label": "Analyse (until converged)",
      "description": "One ticket per module, until every module is covered.",
      "skill": "my-analysis", "maxUnitsPerAdvance": 2,
      "plan": { "command": "node tools/loop-plan.mjs", "cwd": "plugin",
                "env": { "MY_ROOT": "{{repoPath}}", "MY_PROJECT": "{{projectName}}" } } }
  ],
  "views": [
    { "id": "findings", "label": "Findings", "kind": "iframe",
      "description": "What has been found so far.",
      "serve": { "command": "node tools/serve.mjs", "cwd": "plugin", "portEnv": "PORT",
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
- [ ] every `loops[].skill` is one of those skill basenames
- [ ] `scripts[].cwd` set explicitly (it defaults to `"repo"`)
- [ ] `views[].serve.portEnv` set; the server binds it, answers `GET /`, and re-reads state per
      request
- [ ] the planner never throws, reports preconditions as notes, and returns `converged: false`
      when blocked
- [ ] unit ids are fresh per pass
- [ ] `maxUnitsPerAdvance` matched to what one unit actually costs
- [ ] scaffold template has `TODO:` markers outside inline code
- [ ] no per-project state written inside the plugin checkout
- [ ] butler fragment says what the plugin must *not* decide for the user
- [ ] a self-test that runs offline, and passes

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

Useful endpoints while developing: `POST /api/plugins` (install),
`POST /api/plugins/:id/enable`, `GET /api/plugins/:id/loops`,
`POST /api/plugins/:id/loops/:name/advance`, `POST /api/plugins/:id/scripts/:name/run`,
`POST /api/plugins/:id/views/:viewId/start`, `GET /api/projects/:projectId/plugin-surface`.

### Known gaps

- **No `{{leadingRepoPath}}`.** A plugin cannot read one repo and write another (see
  [Where output goes](#where-output-goes)).
- **Loop dedupe rides on `issues.externalKey`** (#201), a column documented and rendered as a
  genuine external-tracker link. Safe today because the key is namespaced and loop tickets never
  set `externalUrl`; a second "machine-created, dedupe on re-run" feature should get its own
  column.
- **`views[].serve.cwd` is parsed but ignored** — `startView` always runs in the plugin checkout.
  Either honour it or drop it from the type.
- **`views[].kind` is `"iframe"` only.**
- **The view readiness probe hits `GET /`**, so a server that returns 5xx on its index (but is
  otherwise healthy) reads as down.
