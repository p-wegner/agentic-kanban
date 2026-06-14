#!/usr/bin/env bash
# End-to-end #783 proof: clone a project's master into a fresh temp dir (no worktree,
# no untracked artifacts, no warm node_modules) and run its verify build cold.
# Usage: coldclone-build-check.sh <repoPath>
set -u
SRC="${1:?usage: coldclone-build-check.sh <repoPath>}"
TMP="/c/projects/_coldclone_$(basename "$SRC")"
rm -rf "$TMP" 2>/dev/null

echo "=== committed manifest on master (did the verify gate inject the fix?) ==="
git -C "$SRC" show master:package.json 2>/dev/null | python -c "
import json,sys
d=json.load(sys.stdin)
print('  packageManager:', d.get('packageManager'))
print('  pnpm.onlyBuiltDependencies:', (d.get('pnpm') or {}).get('onlyBuiltDependencies'))
"
echo
echo "=== cold clone master -> $TMP ==="
git clone -q --branch master "$SRC" "$TMP" 2>&1 | tail -2
echo "cloned files (no node_modules, no pnpm-workspace.yaml unless committed):"
ls -a "$TMP" | grep -vE '^\.$|^\.\.$' | head -20
echo
echo "=== pnpm version resolved in the clone ==="
( cd "$TMP" && pnpm --version )
echo "=== cold install ==="
( cd "$TMP" && pnpm install 2>&1 | grep -iE "esbuild|ignored|ERR|Done in|approve" | tail -5 )
INSTALL_RC=${PIPESTATUS:-?}
( cd "$TMP" && pnpm install >/dev/null 2>&1 ); echo "install exit: $?"
echo "=== cold build ==="
( cd "$TMP" && pnpm build 2>&1 | tail -5 )
( cd "$TMP" && pnpm build >/dev/null 2>&1 ); echo "build exit: $?"
echo
echo "(cleanup) rm -rf $TMP"
rm -rf "$TMP" 2>/dev/null
