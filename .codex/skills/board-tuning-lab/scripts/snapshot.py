#!/usr/bin/env python3
"""Per-branch, per-repo progress snapshot for a multi-repo board project.

Usage:  python snapshot.py <projectId> [boardPort]

For every non-closed workspace of the project, prints its workspace + session
status, readyForMerge, and — crucially — which repos (leading + siblings) have
commits ahead of their base branch. That per-repo view is the ground truth the
board's own summary hides: sibling-only work stranded on a branch reads as
"Done" on the board but shows up here as `repos=[auth-svc:1]` never merged.

Repos are discovered from the API (project.repoPath = leading; /repos = siblings)
so this works for any fixture without hardcoding paths. Read-only.
"""
import json
import os
import subprocess
import sys
import urllib.request

PID = sys.argv[1] if len(sys.argv) > 1 else sys.exit("usage: snapshot.py <projectId> [boardPort]")
BASE = f"http://localhost:{sys.argv[2] if len(sys.argv) > 2 else '13001'}"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as r:
        return json.load(r)


def git(repo, *args):
    try:
        return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=15).stdout.strip()
    except Exception as e:
        return f"ERR {e}"


projects = get("/api/projects")
project = next((p for p in projects if p.get("id") == PID), None)
if project is None:
    sys.exit(f"project {PID} not found on the board")
leading = project["repoPath"]
siblings = get(f"/api/projects/{PID}/repos")
# (label, repoPath) for every repo of the project.
repos = [(project.get("repoName") or os.path.basename(leading), leading)]
repos += [(r["name"] or os.path.basename(r["path"]), r["path"]) for r in siblings]

ws = get(f"/api/workspaces?projectId={PID}")
ws = ws if isinstance(ws, list) else ws.get("workspaces", ws.get("items", []))
ws = [w for w in ws if w.get("status") != "closed"]

for w in sorted(ws, key=lambda w: w.get("branch") or ""):
    br = w.get("branch") or "?"
    wid = w.get("id")
    try:
        sess = get(f"/api/workspaces/{wid}/sessions")
        sess = sess if isinstance(sess, list) else sess.get("sessions", [])
        sstat = ",".join(s.get("status", "?") for s in sess) or "-"
    except Exception:
        sstat = "?"
    touched = []
    for label, path in repos:
        # Match this workspace's branch even when suggestBranchName truncated it.
        actual = git(path, "branch", "--list", br + "*", "--format", "%(refname:short)").splitlines()
        ref = actual[0] if actual else br
        base = w.get("baseBranch") or "main"
        n = git(path, "rev-list", "--count", f"{base}..{ref}")
        if n.isdigit() and int(n) > 0:
            touched.append(f"{label}:{n}")
    repos_str = ", ".join(touched) if touched else "-"
    print(f"{br[:46].ljust(47)} ws={w.get('status'):8} sess={sstat:11} ready={str(w.get('readyForMerge')):5} repos=[{repos_str}]")
