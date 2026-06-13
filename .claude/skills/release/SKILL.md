---
name: release
description: Pre-release verification + gated GitHub + npm release for agentic-kanban. Runs all checks, summarizes changes, drafts release notes, then PAUSES for explicit user confirmation before pushing the git tag, the GitHub release, and the npm publish.
---

# /release

End-to-end release. The skill does verification + drafting automatically; **publishing is gated on the user typing "yes" / "ship it"** at each gate. Never push tags or publish without explicit confirmation.

**Inputs:** `/release patch` (default) | `minor` | `major` — semver bump. Current version read from `packages/server/package.json`.

## Stage 1 — Pre-release verification

Fail-fast: any check fails → STOP and report, don't proceed to drafting. Run in parallel where safe.

**1.1 Clean state** — `git status --short` (clean of tracked; untracked OK), `git branch --show-current` (must be `master`), `git fetch origin` (no-op without remote). Feature branch or dirty tree → ABORT.

**1.2 No in-flight kanban work**
```bash
curl -s http://127.0.0.1:3001/api/projects/d28f01c9-3fd3-488b-9eb4-d66268c4f7d4/board \
  | python -c "import sys,json; b=json.load(sys.stdin); n=sum(len(c['issues']) for c in b if c['name'] in ('In Progress','In Review','AI Reviewed')); print(f'active={n}')"
```
`active > 0` → list them and ABORT (override only on user `--force`).

**1.3 Conflict markers** — `grep -rl "<<<<<<< HEAD" packages/server/src/ packages/client/src/ packages/shared/src/ packages/shared/drizzle/meta/_journal.json 2>/dev/null`. Any match → ABORT (run board-monitor Section 1 first).

**1.4 Typecheck** — `pnpm -r exec tsc -b --noEmit` across all packages. Any error → ABORT.

**1.5 Tests** — `pnpm --filter agentic-kanban test:mine` (excludes documented-flaky #89). If `test:mine` absent (pre-#89), fall back to `pnpm --filter agentic-kanban test` and tolerate ONLY the CLAUDE.md "Known Flaky Test Suites". Any new failure → ABORT.

**1.6 Build** — `pnpm build`, then the [[skill-publish]] step-2 checks: `grep -c "agentic-kanban/shared" packages/server/dist/cli.js` must be 0; `cd packages/server && npm pack --dry-run` → expected files, ~400KB, no invalid bin warnings. Any deviation → ABORT.

**1.7 App smoke** — ensure dev server up (else start via `dev-server` skill), then visual-verify:
```bash
curl -s http://127.0.0.1:3001/health | grep -q '"ok"' || { echo "ABORT: dev server not running"; exit 1; }
playwright-cli open http://127.0.0.1:5173 && sleep 4
playwright-cli --raw eval "document.querySelector('main')?.innerText?.substring(0,200)"
playwright-cli close
```
Expect board content (Todo / In Progress / Backlog). Empty/missing → ABORT.

**1.8 Vulnerability scan (prod deps)**
```bash
pnpm audit --prod --json > /tmp/audit-prod.json 2>&1 || true
node -e "const a=require('/tmp/audit-prod.json'); const m=a.metadata?.vulnerabilities||{}; const fail=(m.critical||0)+(m.high||0); console.log(JSON.stringify(m)); process.exit(fail>0?1:0);"
```
critical/high → **ABORT** + list packages/advisories. moderate → WARN, allow continue. low/info → log. Don't run `pnpm audit fix` automatically — let the user decide.

**1.9 SBOM (CycloneDX, attached in Stage 6)**
```bash
mkdir -p /tmp/release-artifacts
npx --yes @cyclonedx/cyclonedx-npm --package-lock-only --output-format json \
  --output-file /tmp/release-artifacts/sbom-vX.Y.Z.cdx.json packages/server
```
Don't fail the release on SBOM failure — log a warning and continue (only the GitHub release attachment needs it).

**1.10 License audit** — `npx --yes license-checker --production --summary --excludePrivatePackages 2>&1 | head -30`. ABORT on GPL-2.0/3.0 / AGPL-3.0 in `dependencies` (not devDeps). WARN on unknown / UNLICENSED. OK: MIT, Apache-2.0, BSD-*, ISC, MPL-2.0, CC0, Unlicense. Unsure → prompt the user.

**1.11 Migrations apply cleanly** — `pnpm db:migrate` (idempotent; 'No pending migrations' or applies cleanly). ABORT on error; `pnpm db:repair` first if it complains about WAL/lock.

## Stage 2 — Drafting (no side effects)

**2.1 Next version** — read current from `packages/server/package.json`, apply bump (`patch` 0.1.7→0.1.8, `minor`→0.2.0, `major`→1.0.0). Print it.

**2.2 Release notes from git log**
```bash
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
RANGE=${LAST_TAG:+$LAST_TAG..HEAD}; RANGE=${RANGE:-HEAD}
git log --pretty=format:'%h %s' $RANGE
```
Bucket by conventional-commit prefix into `## Features` (feat) / `## Fixes` (fix) / `## Internal` (chore·docs·refactor·tests, collapsed). Drop merge commits + "Merge branch '…'" noise. Highlight breaking changes (`feat!:` / `BREAKING CHANGE:`) at the top with ⚠.

**2.3 Doc edits (in-memory diff, not committed)** — prepare: `docs/state.md` (+`## vX.Y.Z (date)` section), `packages/server/package.json` (version bump), `packages/server/README.md` (only if a feature changes install/usage), `CHANGELOG.md` (prepend if it exists; don't create unless asked). Show one combined diff summary. Don't write to disk yet.

## Stage 3 — User gate #1 (review the plan)
Print the full summary (version transition, commit counts by bucket, doc updates). Then:
```
Type 'yes' to apply the doc updates + create local git tag.
Type anything else to abort.
```
WAIT. Anything but `yes` / `y` / `ship it` → STOP, exit cleanly, no side effects.

## Stage 4 — Apply edits + local tag
Apply the 2.3 edits (Edit/Write), then:
```bash
git add packages/server/package.json docs/state.md packages/server/README.md CHANGELOG.md 2>/dev/null
git commit -m "release: vX.Y.Z

<release notes summary>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git tag -a vX.Y.Z -m "vX.Y.Z"
```
Tag is LOCAL only, not pushed.

## Stage 5 — User gate #2 (publish)
Print the publish plan (npm publish · git push master · git push tag · gh release create), then:
```
Type 'ship it' to publish. Anything else aborts (tag stays local, delete with `git tag -d vX.Y.Z`).
```
WAIT. Not `ship it` / `yes ship` → STOP, tag stays local.

## Stage 6 — Publish (gated)
Order matters: **npm first** (reversible only via deprecate), git push next, GitHub release last.
```bash
cd packages/server
npm publish --access public          # on EOTP/E403: ask user to set NPM token, retry
cd <repo-root>
git push origin master
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/release-notes-vX.Y.Z.md \
  --target master /tmp/release-artifacts/sbom-vX.Y.Z.cdx.json
```
The trailing path attaches the SBOM; if 1.9 was skipped, omit it.

## Stage 7 — Verify
```bash
npm view agentic-kanban version       # should match
gh release view vX.Y.Z                # should exist
git ls-remote origin refs/tags/vX.Y.Z # should resolve
```
Print the three ✓ lines (npm published, GitHub release URL, git tag pushed).

## Recovery / abort
- **Stage 1 / 2 / 3 abort** — nothing changed; fix and re-run.
- **Stage 4 done, Stage 5 aborts** — local commit + tag remain: `git tag -d vX.Y.Z && git reset --hard HEAD^`.
- **npm published, git push fails** — `npm deprecate agentic-kanban@X.Y.Z "release aborted, see vX.Y.Z+1"`, then bump and re-run from Stage 1.
- **npm + git push done, gh release fails** — re-run just `gh release create` (idempotent on `--clobber`).

## Recurring traps
- `npm publish` from the wrong cwd publishes the wrong package — always `cd packages/server`.
- `git push origin master` fails if origin is behind → do NOT force-push; `git pull --ff-only origin master` and retry.
- `gh release create` needs green `gh auth status` — ask the user to `gh auth login` if it fails.
- npm token can be `.npmrc` or `NPM_TOKEN` — don't print it.
- A failing playwright smoke often means the dev server is still hot-reloading from a recent merge — wait 10s and re-check before aborting.
- `pnpm audit` can be slow on cold cache — allow up to 60s before treating as a hang.
- `@cyclonedx/cyclonedx-npm` needs a real `package-lock.json` / `pnpm-lock.yaml`; both absent → fail open (skip SBOM, warn), don't abort.
- `license-checker` reports every transitive dep — focus on `dependencies` (`--production`). A GPL devDep is fine for a published library; a GPL runtime dep is not.
