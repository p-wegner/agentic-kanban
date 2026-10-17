#!/usr/bin/env node
// Points this repo's git at the tracked .githooks/ directory (#1576). Shared by the main checkout and all worktrees.
import { execFileSync } from "node:child_process";
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit", windowsHide: true });
console.log("[hooks] core.hooksPath = .githooks");
