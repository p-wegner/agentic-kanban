---
module: project-registration
name: Project Registration & Stack Profiles
capability: Onboard any git repo as a board project and derive the per-stack scripts (install / verify / smoke / scaffold) that let AI agents build in it hands-off
files: 14
source_paths:
  - packages/server/src/services/project-registration.ts
  - packages/server/src/services/stack-detector.service.ts
  - packages/server/src/services/stack-profile.service.ts
  - packages/server/src/services/stack-profile/*.ts
  - packages/server/src/services/project-setup.service.ts
  - packages/server/src/services/project-scaffold.ts
  - packages/server/src/services/gradle-detect.service.ts
  - packages/server/src/services/cold-clone-build-check.service.ts
  - packages/server/src/repositories/{project-registration,stack-profile,project-setup,project-scaffold}.repository.ts
entry_points:
  - "packages/server/src/services/project-registration.ts:144 — registerProject (called by POST /api/projects)"
  - "packages/server/src/services/project-registration.ts:231 — repairProjectRegistration (backfill onto already-registered projects)"
  - "packages/server/src/services/stack-profile.service.ts:13 — detectStackProfile / profile resolver façade"
analyzed_sha: 29e016dc
depends_on: [issues-board, workspaces, review-merge, preferences-config]
structure: scattered
---

# Project Registration & Stack Profiles

## Purpose & business capability

The board's core promise is "point it at a repo and let AI agents build in it
hands-off." That promise only holds if the board *understands an arbitrary repo
well enough to operate it without a human configuring anything*: how to install
its dependencies in a fresh worktree, how to prove a change is correct before
merging, how to boot it and confirm it still serves, and how to keep the main
branch clean so auto-merge isn't blocked by stray artifacts. This module is what
turns a bare `git` directory into a drivable project — the **"turnkey
multi-stack driver" foundation** that lets the board drive Node, Rails, Go,
Rust, JVM (Gradle/Maven/Kotlin/KMP), and Python repos, not just its own
TypeScript monorepo.

The capability has two halves. **Onboarding** (`project-registration.ts`)
creates the DB project row, seeds the canonical workflow statuses, picks a
default branch, attaches the onboarding skill, and kicks off profile derivation.
**Stack intelligence** (`stack-detector` + `stack-profile/*` + `gradle-detect` +
`project-scaffold`) reverse-engineers the repo's tech stack from on-disk marker
files into one durable descriptor — the **StackProfile** — and derives every
downstream script from it: the worktree **setup/install** command, the merge-gate
**verify** command, the **smoke** boot-and-respond check, an **edit-time feedback
rules** file, a **runnable test scaffold**, and per-stack **.gitignore** guards.

If this module vanished, the board could still drive *its own* monorepo (which
has hand-tuned config), but every *other* project would fail at the first step:
worktrees wouldn't install deps, the auto-merge gate would have nothing to run
(so broken code would merge), non-Node build artifacts would dirty main and
block merges, and new projects would get no statuses/default-branch and be
silently undriveable (#772). Consumers: `workspaces` (worktree provisioning reads
`setup_script`), `review-merge` (the pre-merge gate reads `verify_script` + the
smoke check), and the monitors/Conductor (which only auto-start a project that is
fully driveable).

## Ubiquitous language

| Term | Meaning *as used here* | Defined at |
|------|------------------------|------------|
| Stack profile | The single durable descriptor of a repo's tech stack (family, package manager, install/build/test/dev commands, web-ness, ports, test dir/runner). The ONE thing every downstream harness piece reads. | `packages/shared/src/types/api.ts:100`; computed `stack-detector.service.ts:281` |
| Marker files | The on-disk root files that identify a stack (`package.json`, `Cargo.toml`, `go.mod`, `build.gradle`, `pyproject.toml`, …). Detection is rule-based off this set. | `project-setup.service.ts:11` |
| Stack family | The coarse `stack` field. Two scopes: the rule-based detector (`detectOtherProfile`, `stack-detector.service.ts:175-258`) only recognizes `node`/`rust`/`go`/`java`/`python` (no Gemfile/`mix.exs` branch); `ruby`/`elixir` exist only as downstream-map families (per-stack gitignore + source-pattern) or LLM-supplied, never rule-detected. The full keyed set (`node`/`rust`/`go`/`python`/`java`/`ruby`/`elixir`) appears in the gitignore map. | `stack-detector.service.ts:175-258`; gitignore map `project-scaffold.ts:73` |
| Setup script | Monorepo-aware install command run ONCE in a fresh worktree before the first build (`pnpm install -r`, `cargo fetch`, `gradlew assemble`, …). Persisted to the project's `setup_script` column. | `stack-profile/setup-script.ts:59` |
| Verify script / merge gate | The keystone auto-merge gate command (`testCommand && buildCommand`). A non-zero exit withholds `readyForMerge`. Persisted to the `verify_script_<projectId>` preference. | `stack-profile/verify-script.ts:27` |
| Smoke check | A project-agnostic "does it boot and respond/render" check: boot the dev command, poll a health URL, assert HTTP 200 (+ HTML shell for browser UIs). Only for web/service projects. | `stack-profile/smoke-check.ts:31` |
| Smart-hooks rules | Generated `.claude/smart-hooks-rules.json` mapping source-file globs → quick edit-time checks (typecheck / quick test), giving a driven project's builder the same incremental feedback board builders get. | `stack-profile/smart-hooks-rules.ts:63` |
| Test scaffold | One trivially-passing, runnable test written in the project's REAL test dir + runner syntax, so a fresh project has a green test from ticket #1. | `stack-profile/test-scaffold.ts:236` |
| Cold-clone build check | An opt-in review gate that clones the committed branch into a fresh temp dir (no junctioned `node_modules`, no warm store) and runs install+build — catching failures that only appear on a truly clean clone (#783-class). | `cold-clone-build-check.service.ts:72` |
| Buildable-from-clean scaffold | Per-package-manager edits (pnpm `onlyBuiltDependencies`, bun `trustedDependencies`, `packageManager` pin) so a clean clone builds with NO manual approval prompts. | `project-scaffold.ts:770` |
| profile source | `"detected"` (rule-based) vs `"llm"` (LLM gap-filled a sparse profile). Signals confidence/provenance. | `stack-detector.service.ts:295`, `persistence.ts:118` |

## Domain model & invariants

The module owns the **StackProfile** value object (persisted as JSON in the
`project_stack_profile_<projectId>` preference) and the registration side-effects
on the `projects` table (default branch, statuses, default skill, `setup_script`).

| Invariant / rule / policy | Why (business reason, inferred) | Enforced at |
|---------------------------|----------------------------------|-------------|
| A project must never be registered with a null `defaultBranch` | A null branch makes `POST /api/workspaces` 400 "No default branch configured" and the monitor swallows the auto-start silently — the project looks registered but is undriveable (#772). Falls back to the actually checked-out branch. | `project-registration.ts:39`, `:168` |
| Registration is idempotent per git root | Re-registering the same repo (even a subdirectory, legacy) returns the existing project rather than creating a duplicate; duplicates fragment a repo's issues/skills across two projects. | `project-registration.ts:150`, `deduplicateProjects:71` |
| Every new project gets the canonical 7-status set (incl. Backlog at −1) | Missing statuses make `POST /api/issues/batch` 400 "No statuses found", and Backlog-pull auto-start needs the Backlog lane to exist (#772). | `project-registration.ts:190` |
| Every new project gets `board-navigator` as default skill | Without it, a fresh project's worktrees are skill-less and the Builder works blind on how to use the board (#531). Degrades gracefully to null if unseeded. | `project-registration.ts:174` |
| Profile derivation is best-effort and must never slow or fail registration | Onboarding latency and reliability matter more than a complete profile; the optional LLM gap-fill especially must not block. Fired-and-forgotten with `.catch()`. | `project-registration.ts:199` |
| Rule-based detection wins; the LLM only fills gaps | Deterministic marker-rule facts are trusted over the LLM; the LLM is invoked ONLY when the profile is "sparse" (no stack, or no test AND no build command) and merges in only where rules had null. | `persistence.ts:22`, `:102` |
| All script derivation no-ops on "nothing derivable" and never clobbers an existing value | A pure no-op (empty string / unset key) is safer than a wrong/empty gate. `populate*` functions skip when the target is already set, so user/AI overrides survive re-runs. | `verify-script.ts:53-58`, `setup-script.ts:81-86`, `test-scaffold.ts:272` |
| The verify gate = `testCommand && buildCommand` (test first, fast) | Tests are the cheaper, more behavioral correctness signal; build catches compile/bundle breakage. A non-zero exit is the keystone that withholds auto-merge so broken code can't be auto-approved. | `verify-script.ts:27`, consumed `pre-merge-gate.service.ts:56` |
| Setup/install must be monorepo-aware | A monorepo build needs ALL workspaces'/modules' deps materialized, not just the root — pnpm `-r`, Gradle multi-module `assemble` (root `dependencies` only resolves the root project). | `stack-detector.service.ts:43`, `:200`; `setup-script.ts:55` |
| Per-edit blocking checks are skipped/downgraded for the slow JVM family | Gradle/Maven cold-daemon startup (and KMP `allTests` fanning out to every target) would stall a builder for minutes per keystroke-batch; the merge-time verify gate stays the real correctness gate instead. | `smart-hooks-rules.ts:74-98` |
| Smoke check only fires for a bootable web/service project with a resolvable health URL | A CLI/library has nothing to "boot and hit over HTTP"; checking it would be a false signal. Returns null (skip) otherwise. | `smoke-check.ts:31-34` |
| Build artifacts and agent scratch files must be gitignored before the first build | A non-Node toy leaving `target/`/`__pycache__/`/`dist/` (or agent `verify-*.png`/`*.log`) untracked dirties the main checkout and blocks auto-merge on `dirty_main` (#811, #825). | `project-scaffold.ts:24`, `:73`, `ensureAgentGitignore:187` |
| A clean clone must build with no manual approval prompts | pnpm/bun refuse untrusted native postinstall (`ERR_PNPM_IGNORED_BUILDS`); without approval + a `packageManager` pin, a fresh clone of a Vite/TS toy fails where the warm worktree passed (#777/#783/#789). | `project-scaffold.ts:770` |
| Scaffold files are committed in the main checkout so future worktrees fork clean | If the board-authored `.claude/`, `.gitignore`, `CLAUDE.md` stay uncommitted, every new worktree starts dirty and auto-merge fails on `dirty_main`. Commits only scaffold paths, no-op on detached HEAD. | `project-scaffold.ts:114` |
| The test scaffold is never written into a test dir that already has tests | A redundant `ScaffoldTest` regenerated on every profile refresh becomes a stray untracked file that re-blocks auto-merge (observed on the kmp-toolkit drive). | `test-scaffold.ts:270`, `:282` |

## Key workflows / use cases

### 1. Onboarding a repo (POST /api/projects → registerProject)

```mermaid
sequenceDiagram
  participant API as POST /api/projects (issues-board)
  participant Reg as registerProject
  participant DB as projects table
  participant Prof as populateStackProfile
  participant Gate as populateVerifyScript / populateSetupScript

  API->>Reg: path, name?
  Reg->>Reg: detectRepoInfo (git root, branch, remote)
  Reg->>Reg: dedup check (exact path OR same git root) → return existing if found
  Reg->>Reg: resolveDefaultBranch (detected || current branch; never null)
  Reg->>DB: insert project (+ defaultSkillId = board-navigator)
  Reg->>DB: initializeProjectStatuses (canonical 7)
  Reg->>DB: set activeProjectId
  Reg-->>API: {project, created:true}  (returns immediately)
  Note over Reg,Gate: fire-and-forget, non-blocking
  Reg->>Prof: detect → (LLM gap-fill if sparse) → persist profile JSON
  Prof->>Prof: writeSmartHooksRules + writeTestScaffold (side-effects of save)
  Reg->>Gate: derive+persist verify_script and setup_script from SAME profile
```

Trigger: a user/CLI/MCP registering a repo. Outcome: a fully driveable project
with statuses, branch, skill, a persisted profile, and a live merge gate +
install script. Failure handling: the profile/gate population runs detached and
non-fatally; if it throws, the project is still created — `repairProjectRegistration`
can backfill later.

### 2. Profile derivation (detect → enrich → persist)

`detectStackProfile` (`stack-detector.service.ts:281`) reads marker files and
branches: `package.json` → `detectNodeProfile` (package manager from lockfile,
scripts → build/test/lint/typecheck/dev, workspaces → monorepo, deps → web-ness +
dev port); else `detectOtherProfile` for Cargo/Go/Gradle/Maven/Python. The Gradle
branch delegates the gnarly heuristics to `gradle-detect.service.ts` (Kotlin vs
Java, KMP `allTests` vs `test`, Spring `bootRun` vs `application`-plugin `run`,
platform-correct wrapper `.\gradlew.bat` vs `./gradlew`, dev-port scan).
`populateStackProfile` (`persistence.ts:48`) then LLM-enriches only if sparse and
persists; saving also (re)writes the smart-hooks rules and test scaffold.

### 3. How the derived scripts feed worktree + merge (cross-module)

- **setup_script** → `workspaces` runs it in a fresh worktree before the first
  build so deps are present (`workspace-provision.service.ts` /
  `workspace-create.service.ts` consume it via `runSetupScript`).
- **verify_script** → `review-merge`'s `pre-merge-gate.service.ts:56` runs it in
  the worktree; a non-zero exit fails the gate and `exit-workflow.ts` withholds
  `readyForMerge` — broken code can't auto-merge.
- **smoke check** → `pre-merge-gate.service.ts:81` builds it from the profile and
  boots/polls web projects as part of review.
- **cold-clone check** → opt-in (`cold_clone_check_<projectId>`) extra review
  gate that re-runs install+build on a truly clean clone.

### 4. Backfill (repairProjectRegistration)

Idempotently brings an old/partial project up to driveable state: seed statuses
if none, set default branch if null, populate profile + verify + setup scripts if
unset (`project-registration.ts:231`). Each step is independently guarded and
non-fatal.

## Entry points

| Entry point | Kind | What it lets a caller do | `file:line` |
|-------------|------|--------------------------|-------------|
| `registerProject` | API (via POST /api/projects, owned by issues-board) | Onboard a repo: create project, statuses, branch, skill; kick off profile/gate derivation | `project-registration.ts:144` |
| `repairProjectRegistration` | API/internal | Backfill driveable state + profile/scripts onto an already-registered project | `project-registration.ts:231` |
| `deduplicateProjects` | startup event | Merge duplicate registrations sharing one git root (runs on boot) | `project-registration.ts:71` |
| `detectStackProfile` / profile façade | service call | Resolve/derive a repo's stack profile and all derived-script helpers | `stack-profile.service.ts:13` |
| `runColdCloneBuildCheckForProject` | service call (review-merge) | Opt-in clean-clone build gate | `cold-clone-build-check.service.ts:139` |

## Logic-bearing code (where the real decisions live)

| File / function | What decision/logic it holds | `file:line` |
|-----------------|------------------------------|-------------|
| `stack-detector.service.ts` `detectNodeProfile` / `detectOtherProfile` | The whole "what stack is this and how do you run it" rule table — package-manager inference, monorepo detection, per-ecosystem install/build/test/dev commands. Highest-blast: every downstream script derives from its output. | `:115`, `:175` |
| `gradle-detect.service.ts` | The platform-sensitive JVM heuristics (Kotlin/KMP/Spring/Ktor, wrapper-on-Windows, KMP `allTests`, dev-port scan). The single most fragile part of detection. | whole file |
| `stack-profile/persistence.ts` `populateStackProfile` / `enrichWithLlm` | The detect→enrich→persist lifecycle and the sparse-profile policy that decides whether to spend an LLM call; merge rule (rules win, LLM fills gaps). | `:48`, `:72` |
| `stack-profile/verify-script.ts` `deriveVerifyScriptFromProfile` | The keystone merge gate composition (`testCommand && buildCommand`) and its no-clobber/no-empty persistence. | `:27`, `:47` |
| `stack-profile/setup-script.ts` `deriveSetupScriptFromProfile` | Monorepo-aware install command selection and marker fallback. | `:59`, `:75` |
| `stack-profile/smoke-check.ts` `buildSmokeCheck` | When a project is bootable-and-checkable, and what to assert (200 + HTML shell only for browser stacks). | `:31`, `:48` |
| `project-scaffold.ts` `ensureBuildableFromClean` / `ensureAgentGitignore` / `commitProjectScaffoldArtifacts` | The dirty-main / clean-clone hardening that keeps auto-merge from breaking on a fresh non-board repo (#777/#783/#789/#811/#825). | `:770`, `:187`, `:114` |
| `stack-profile/smart-hooks-rules.ts` `buildSmartHooksRules` | Edit-time feedback policy: cheapest-signal-first, and the slow-JVM downgrade. | `:63` |
| `cold-clone-build-check.service.ts` `runColdCloneBuildCheck` | The clean-clone gate that catches build breakage the warm worktree hides. | `:72` |

## Dependencies & bounded-context relationships

**Upstream (what this needs):**
- `git-info.service` / `git-service` / `git-exec` — repo introspection (root,
  branch, clone). Anti-corruption adapter: all git spawning via the shared
  `git-exec` port.
- `claude-cli.service` (`invokeClaudePrompt`) — the LLM gap-fill and the legacy
  `generateSetupScript`/`generateVerifyScript`/`generateTeardownScript` prompts.
- `preferences-config` — profile, `verify_script_<id>`, `cold_clone_check_<id>`
  are stored as preferences; `project-runtime-config.service.ts` (NOT documented
  here — owned by preferences-config) is the typed reader of these.
- `issues-board` — owns the `projects`/`projectStatuses` tables and the
  POST /api/projects route door; `initializeProjectStatuses` lives in its
  issue.repository.

**Downstream (what needs this):**
- `workspaces` — Customer-Supplier: reads `setup_script` to provision a worktree;
  the profile's per-stack gitignore keeps the worktree's main clean.
- `review-merge` — Customer-Supplier: `pre-merge-gate.service.ts` consumes
  `verify_script` + `buildSmokeCheck` + the opt-in cold-clone check as the
  auto-merge gate (`exit-workflow.ts` withholds `readyForMerge` on failure).
- monitors / Conductor (`monitor-cycle.ts`, `drive*.service.ts`) — only auto-start
  a project this module made fully driveable.

**Integration style:** the StackProfile is a **Published Language** — one JSON
descriptor (`packages/shared/src/types/api.ts:100`) that every consumer reads
rather than re-deriving. The `stack-profile.service.ts` façade is a **Shared
Kernel** export surface kept byte-identical across the #911/#853 splits so its ~21
importers are unaffected.

**Hidden coupling:** `saveStackProfile` (`persistence.ts:142`) has filesystem
side-effects (writes `.claude/smart-hooks-rules.json` + the test scaffold into the
repo) that no type signature advertises — a reader expecting a pure DB write will
miss that persisting a profile mutates the working tree.

## File topology

| Sub-responsibility | Implemented in | Layer |
|--------------------|----------------|-------|
| Onboarding orchestration (create project, statuses, branch, skill; trigger derivation) | `services/project-registration.ts` | service |
| Dedup of same-git-root registrations | `services/project-registration.ts:71` | service |
| Backfill onto old projects | `services/project-registration.ts:231` | service |
| Marker-file detection | `services/project-setup.service.ts:18` (`detectProjectMarkers`) | service |
| Stack detection (Node + Cargo/Go/Gradle/Maven/Python) | `services/stack-detector.service.ts` | service |
| JVM/Gradle/Kotlin/KMP/Spring/Ktor heuristics | `services/gradle-detect.service.ts` | service |
| Profile lifecycle: detect → LLM enrich → persist + read | `services/stack-profile/persistence.ts` | service |
| Profile resolver / public façade | `services/stack-profile.service.ts` | service (barrel) |
| Setup (install) script derivation | `services/stack-profile/setup-script.ts` | service |
| Verify (merge-gate) script derivation | `services/stack-profile/verify-script.ts` | service |
| Smoke (boot-and-respond) check derivation | `services/stack-profile/smoke-check.ts` | service |
| Edit-time feedback rules generation | `services/stack-profile/smart-hooks-rules.ts` | service |
| Runnable test scaffold generation | `services/stack-profile/test-scaffold.ts` | service |
| Legacy LLM setup/teardown/verify prompts + rule-based verify | `services/project-setup.service.ts` | service |
| New-project scaffold: gitignore, CLAUDE.md/AGENTS.md, hooks, clean-build hardening, scaffold commit | `services/project-scaffold.ts` | service |
| Clean-clone build gate (opt-in review) | `services/cold-clone-build-check.service.ts` | service |
| Project row CRUD, status remap/move, dedup persistence | `repositories/project-registration.repository.ts` | repository |
| `setup_script` column read/write | `repositories/stack-profile.repository.ts` | repository |
| Project repo-info reads (for prompts) | `repositories/project-setup.repository.ts` | repository |
| board-navigator skill id lookup | `repositories/project-scaffold.repository.ts` | repository |
| StackProfile / SmokeCheck / StackProfileResponse types | `packages/shared/src/types/api.ts:100` | shared types |

## Risks, gaps & open questions

- **Two parallel verify/setup derivers exist.** `project-setup.service.ts` keeps
  an older rule-based `deriveVerifyScript` + LLM `generateVerifyScript`/
  `generateSetupScript`/`generateTeardownScript` (`:92`, `:136`, `:27`, `:49`),
  while `stack-profile/verify-script.ts` + `setup-script.ts` are the
  profile-driven path used at registration. The verify-script module *reuses* the
  old `deriveVerifyScript` only as a fallback — but the LLM `generate*` functions
  are a separate, route-driven path. *Both coexist by design*: the LLM `generate*`
  path serves the manual user "regenerate" action (`routes/projects.ts:147,155,163`
  → `generateSetupScript`/`generateVerifyScript`/`generateTeardownScript`), while
  the profile-driven `populate*` path runs at registration/repair.
- **Profile staleness.** The profile is computed at registration/repair and only
  refreshed on explicit re-detect (`?refresh=true`). A repo that changes stack
  (adds a lockfile, switches package manager) keeps a stale profile — and thus a
  stale merge gate — until someone refreshes. No automatic invalidation observed.
  *(inferred, unverified)*
- **Side-effecting save.** `saveStackProfile` writing files into the repo (above)
  means a read-path that "just persists JSON" also regenerates scaffold/test
  files; the test-scaffold guard mitigates the worst dirty-main case but the
  coupling is implicit.
- **LLM trust boundary.** Enrichment parses free-form LLM JSON
  (`parseLlmJson`, `persistence.ts:124`); a `testCommand` filled in from that JSON
  (`persistence.ts:108`) becomes the project's `verify_script`, which is executed
  via `runSetupScript` as `spawn("cmd.exe", ["/c", script])` /
  `spawn("/bin/sh", ["-c", script])` (`setup-script.ts:11-15`) — a full shell with
  no allow-list/sanitization beyond "rules win where present". A hallucinated or
  hostile command could thus become the shell-executed gate for a sparse-stack
  project. Caveat: exploitation requires both a profile sparse enough to trigger
  the LLM path (no stack, or no test AND no build command) and a hostile/hallucinated
  command in that path.
- **Dev-port heuristics are best-effort.** `detectDevPort` /
  `detectGradleDevPort` fall back to regex scans and a hard-coded 8080; a project
  on a non-standard port may get a smoke check that polls the wrong URL and
  fails/false-negatives. Generic by design, but a known soft spot.
- **gradle multi-module `assemble` as install** is heavier than a pure dependency
  resolve and can be slow; chosen deliberately to materialize all subproject deps
  (`stack-detector.service.ts:200`) — a latency/correctness tradeoff, not a bug.
