---
name: release
description: Pre-release verification + gated GitHub + npm release for agentic-kanban. Runs all checks, summarizes changes, drafts release notes, then PAUSES for explicit user confirmation before pushing the git tag, the GitHub release, and the npm publish.
---

# /release

End-to-end release workflow. The skill does the verification + drafting work automatically; **publishing is gated on the user typing "yes" / "ship it"** at each gate. Never push tags or publish without explicit confirmation.

## Inputs

- Optional: `/release patch` (default), `/release minor`, `/release major` — semver bump direction.
- Reads the current version from `packages/server/package.json`.

## Stage 1 — Pre-release verification (parallel where safe)

Fail-fast: any check below fails → STOP and report. Do not proceed to drafting.

### 1.1 Clean state checks

```bash
git status --short            # must be clean of tracked changes (untracked OK)
git branch --show-current     # must be 'master'
git fetch origin              # no-op if no remote, but keep
```

If on a feature branch or working tree dirty: ABORT.

### 1.2 No in-flight kanban work

```bash
curl -s http://127.0.0.1:3001/api/projects/d28f01c9-3fd3-488b-9eb4-d66268c4f7d4/board \
  | python -c "import sys,json; b=json.load(sys.stdin); n=sum(len(c['issues']) for c in b if c['name'] in ('In Progress','In Review','AI Reviewed')); print(f'active={n}')"
```

If active > 0, list them and ABORT — finish or merge them before releasing. (Override only on user `--force`.)

### 1.3 Conflict marker scan

```bash
grep -rl "<<<<<<< HEAD" packages/server/src/ packages/client/src/ packages/shared/src/ packages/shared/drizzle/meta/_journal.json 2>/dev/null
```

Any match → ABORT (run board-monitor section 1 first).

### 1.4 Typecheck

```bash
pnpm -r exec tsc -b --noEmit
```

Run across all packages. ABORT on any error.

### 1.5 Test suite

```bash
pnpm --filter agentic-kanban test:mine   # excludes documented-flaky suites (#89)
```

If `test:mine` doesn't exist yet (pre-#89), fall back to:
```bash
pnpm --filter agentic-kanban test
```
…and tolerate ONLY the suites listed in CLAUDE.md "Known Flaky Test Suites". Any new failure → ABORT.

### 1.6 Build

```bash
pnpm build
```

Follow the existing [[skill-publish]] step 2 verification:
- `grep -c "agentic-kanban/shared" packages/server/dist/cli.js` → must be 0
- tarball check via `cd packages/server && npm pack --dry-run` → expected files, ~400KB, no invalid bin warnings

ABORT on any deviation.

### 1.7 App-runs smoke test

```bash
# Ensure dev server is up; if not, start via the dev-server skill
curl -s http://127.0.0.1:3001/health | grep -q '"ok"' || { echo "ABORT: dev server not running"; exit 1; }
```

Then visual verification via playwright-cli:
```bash
playwright-cli open http://127.0.0.1:5173
sleep 4
playwright-cli --raw eval "document.querySelector('main')?.innerText?.substring(0,200)"
playwright-cli close
```

Expect: board content (Todo / In Progress / Backlog visible). Empty/missing → ABORT.

### 1.8 Vulnerability scan (production deps)

```bash
pnpm audit --prod --json > /tmp/audit-prod.json 2>&1 || true
node -e "const a=require('/tmp/audit-prod.json'); const m=a.metadata?.vulnerabilities||{}; const fail=(m.critical||0)+(m.high||0); console.log(JSON.stringify(m)); process.exit(fail>0?1:0);"
```

- **critical or high** in prod deps → **ABORT** and list the affected packages + advisories.
- **moderate** → WARN, surface to the user, allow continue.
- **low / info** → log and continue.

Don't run `pnpm audit fix` automatically — let the user decide whether to upgrade vs. accept-and-document.

### 1.9 SBOM generation (CycloneDX, attached to GitHub release)

```bash
# Generate a CycloneDX SBOM for the published server package
mkdir -p /tmp/release-artifacts
npx --yes @cyclonedx/cyclonedx-npm \
  --package-lock-only \
  --output-format json \
  --output-file /tmp/release-artifacts/sbom-vX.Y.Z.cdx.json \
  packages/server
```

The SBOM is uploaded as a release artifact in Stage 6 (gh release create --add-asset). Don't fail the release on SBOM generation failure — log a warning and continue (the npm publish doesn't require the SBOM, only the GitHub release attachment does).

### 1.10 License audit

```bash
npx --yes license-checker --production --summary --excludePrivatePackages 2>&1 | head -30
```

Check for licenses incompatible with our use:
- ABORT on: GPL-2.0 / GPL-3.0 / AGPL-3.0 (copyleft) in `dependencies` (not devDependencies).
- WARN on: unknown / UNLICENSED — investigate before continuing.
- OK: MIT, Apache-2.0, BSD-*, ISC, MPL-2.0, CC0, Unlicense.

If unsure, prompt the user.

### 1.11 Migrations apply cleanly

```bash
pnpm db:migrate    # idempotent — should report 'No pending migrations' OR apply cleanly
```

ABORT on error. Run `pnpm db:repair` first if it complains about WAL/lock.

## Stage 2 — Drafting (no side effects yet)

### 2.1 Compute next version

Read current version from `packages/server/package.json`. Apply the bump direction:
- `patch` (default): `0.1.7` → `0.1.8`
- `minor`: `0.1.7` → `0.2.0`
- `major`: `0.1.7` → `1.0.0`

Print the proposed new version.

### 2.2 Generate release notes from git log

```bash
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
RANGE=${LAST_TAG:+$LAST_TAG..HEAD}
RANGE=${RANGE:-HEAD}
git log --pretty=format:'%h %s' $RANGE
```

Bucket commits by conventional-commit prefix:

```
## Features
- feat(X): … (commit hash)

## Fixes
- fix(X): … (commit hash)

## Internal / Chore / Docs / Refactor / Tests
- (collapsed list)
```

Drop merge commits and the routine "Merge branch '…'" noise. Highlight breaking changes (`feat!:` / `BREAKING CHANGE:` footer) at the top with ⚠.

### 2.3 Update docs (in-memory diff first, not committed yet)

Prepare edits:
- `docs/state.md` — append a "## vX.Y.Z (date)" section with the release notes summary.
- `packages/server/package.json` — version bump.
- `packages/server/README.md` — only if a feature in the notes changes installation/usage; otherwise leave alone.
- `CHANGELOG.md` — if it exists, prepend the new release section; if not, do NOT create one unless the user asks.

Show a single diff summary of all proposed edits. Do not write to disk yet.

## Stage 3 — User gate #1 (review the plan)

Print the full summary:
```
Release plan
============
Version: 0.1.7 → 0.1.8 (patch)
Commits since v0.1.7: 24
- 8 features
- 6 fixes
- 10 internal

Doc updates: docs/state.md (+12 lines), packages/server/package.json (version)

Type 'yes' to apply the doc updates + create local git tag.
Type anything else to abort.
```

WAIT for user input. If anything other than `yes` / `y` / `ship it` → STOP, exit cleanly, no side effects.

## Stage 4 — Apply edits + local tag

```bash
# Apply the doc edits prepared in 2.3
# (use the Edit/Write tools)

git add packages/server/package.json docs/state.md packages/server/README.md CHANGELOG.md 2>/dev/null
git commit -m "release: vX.Y.Z

<release notes summary>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git tag -a vX.Y.Z -m "vX.Y.Z"
```

Tag is LOCAL only. Not pushed yet.

## Stage 5 — User gate #2 (publish to npm + GitHub)

Print:
```
Local release commit + tag vX.Y.Z ready.
About to:
  - npm publish --access public  (cwd: packages/server)
  - git push origin master
  - git push origin vX.Y.Z
  - gh release create vX.Y.Z --notes-file <draft>

Type 'ship it' to publish. Anything else aborts (tag stays local, easy to delete with `git tag -d vX.Y.Z`).
```

WAIT for user input. If not `ship it` / `yes ship` → STOP. Tag is still local.

## Stage 6 — Publish (gated, atomic-ish)

Order matters: **npm first** (reversible only via deprecate), **git push next**, **GitHub release last**.

```bash
cd packages/server
npm publish --access public
# On EOTP/E403: ask user to set NPM token, then retry.

cd <repo-root>
git push origin master
git push origin vX.Y.Z

gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes-file /tmp/release-notes-vX.Y.Z.md \
  --target master \
  /tmp/release-artifacts/sbom-vX.Y.Z.cdx.json
```

The trailing positional argument(s) attach files to the release. If the SBOM generation in 1.9 was skipped (failure tolerated), omit the trailing path.

## Stage 7 — Verify

```bash
npm view agentic-kanban version       # should match
gh release view vX.Y.Z                # should exist
git ls-remote origin refs/tags/vX.Y.Z # should resolve
```

Print:
```
✓ npm: agentic-kanban@X.Y.Z published
✓ GitHub release: https://github.com/<repo>/releases/tag/vX.Y.Z
✓ git tag pushed
```

## Recovery / abort cases

- **Stage 1 failure** — nothing was changed; fix the issue and re-run.
- **Stage 2/3 abort** — nothing was changed.
- **Stage 4 done, Stage 5 aborts** — local commit + tag remain. To undo:
  ```bash
  git tag -d vX.Y.Z
  git reset --hard HEAD^
  ```
- **npm published, git push fails** — npm CAN be deprecated:
  ```bash
  npm deprecate agentic-kanban@X.Y.Z "release aborted, see vX.Y.Z+1"
  ```
  Then bump again and re-run from Stage 1.
- **npm + git push done, gh release create fails** — re-run just the `gh release create`; idempotent on `--clobber`.

## Recurring traps

- `npm publish` from the wrong cwd publishes the wrong package — always `cd packages/server`.
- `git push origin master` may fail if origin is behind; do NOT force-push. Instead: `git pull --ff-only origin master` and retry (something else got pushed in between).
- `gh release create` requires `gh auth status` to be green. Ask the user to `gh auth login` if it fails.
- The npm token can be local (in `.npmrc`) or env (`NPM_TOKEN`). Don't print it.
- A failing playwright smoke check often means the dev server is still hot-reloading from a recent merge — wait 10s and re-check before aborting.
- `pnpm audit` against the npm public registry can be slow on cold cache; allow up to 60s before treating as a hang.
- `@cyclonedx/cyclonedx-npm` needs a real `package-lock.json` or `pnpm-lock.yaml`; if both absent → fail open (skip SBOM, log warning), don't abort the release.
- `license-checker` reports every transitive dep — focus on `dependencies` (the `--production` flag), not devDependencies. A GPL devDep is fine for a published library; a GPL runtime dep is not.
