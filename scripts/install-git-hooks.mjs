#!/usr/bin/env node
// Points this repo's git at the tracked .githooks/ directory (#1576). Shared by the main checkout and all worktrees.
import { gitExecSync } from "./git-exec.mjs";
gitExecSync(["config", "core.hooksPath", ".githooks"]);
console.log("[hooks] core.hooksPath = .githooks");
