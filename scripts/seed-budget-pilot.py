#!/usr/bin/env python
"""Seed the budget-pilot fan-out epic (issues + dependency edges) atomically.

Run from anywhere; talks to the board at localhost:3001.
"""
import json, sys, urllib.request

BASE = "http://localhost:3001"
PID = "bfa9147b-d72a-4014-9a43-f136eaa3a2dd"
BACKLOG = "ec5179ec-5f26-4aca-9d52-5877790f6a46"

def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

CONTRACT = (
    "\n\n---\n"
    "**Ownership & contract (read carefully):**\n"
    "- Edit ONLY the files listed under *Files you own* below. Do NOT touch the shell's shared files "
    "(`src/types.ts`, `src/store/index.ts`, `src/router.tsx`, `src/components/Sidebar.tsx`, `src/components/ui/*`, "
    "`src/lib/*`, `package.json`, configs) — they are already wired for you.\n"
    "- ALL dependencies are already installed by the shell. Do NOT run `pnpm add` / add packages.\n"
    "- Shared domain types live in `src/types.ts` (read-only). Feature-local types go in your own folder.\n"
    "- Your feature's nav link, route, and a stub page already exist (shell pre-wired them). Replace your stub page; "
    "don't add routes elsewhere.\n"
    "- The merge gate runs `pnpm install && pnpm build` in your worktree and BLOCKS the merge on any failure. "
    "Run `pnpm build` yourself before finishing; fix all TS/build errors.\n"
    "- Write your own test file (listed under *Files you own*). Do not edit any other test file.\n"
    "- Keep it self-contained: persisted state via the Zustand store slice; styling via Tailwind + the existing ui primitives.\n"
)

SHELL_DESC = """**Shell / scaffold for budget-pilot** — a personal budget tracker SPA. This ticket builds the base app skeleton and PRE-WIRES every shared/hot file so the 12 feature tickets can build in parallel with zero file conflicts. The whole drive depends on this being thorough.

**Stack:** Vite + React + TypeScript + Tailwind v4 (`@tailwindcss/vite`) + Zustand (persist) + react-router-dom v6 + recharts + lucide-react. Use `pnpm`.

**Install ALL of these deps now (features must never add packages):**
- runtime: `react`, `react-dom`, `react-router-dom`, `zustand`, `recharts`, `date-fns`, `clsx`, `tailwind-merge`, `lucide-react`, `papaparse`
- dev: `typescript`, `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@types/react`, `@types/react-dom`, `@types/papaparse`

**Create the full skeleton:**
1. Vite React-TS project layout: `index.html`, `src/main.tsx`, `vite.config.ts` (react + tailwind plugins + vitest config with `environment:'jsdom'`, `setupFiles`), `tsconfig.json` (strict), `src/app.css` (`@import "tailwindcss";`).
2. `src/types.ts` — define ALL shared domain types: `Account` {id,name,type:'checking'|'savings'|'cash'|'credit',balance:number,currency:string,createdAt:string}; `Category` {id,name,color:string,kind:'expense'|'income'}; `Transaction` {id,accountId,categoryId,amount:number,type:'expense'|'income'|'transfer',date:string,note:string,createdAt:string}; `Budget` {id,categoryId,month:string,limit:number}; `RecurringRule` {id,accountId,categoryId,amount:number,type:'expense'|'income',cadence:'daily'|'weekly'|'monthly',nextDate:string,note:string}; `Goal` {id,name,targetAmount:number,currentAmount:number,deadline:string|null,createdAt:string}. Export all.
3. `src/store/index.ts` — a single Zustand store using `persist` (localStorage key `budget-pilot`) composed of slices. Compose ALL slices: accounts, categories, transactions, budgets, recurring, goals, settings. Export a typed `useStore` hook and a `StoreState` type.
4. `src/store/slices/<name>Slice.ts` — create a STUB file for EACH slice with the FULL TypeScript interface (state shape + action signatures) and a minimal working implementation (empty arrays + actions that update state with crypto.randomUUID() ids). Slices: `accountsSlice` (accounts:Account[]; addAccount/updateAccount/deleteAccount), `categoriesSlice` (categories:Category[] seeded with ~6 sensible defaults; addCategory/updateCategory/deleteCategory), `transactionsSlice` (transactions:Transaction[]; addTransaction/updateTransaction/deleteTransaction), `budgetsSlice` (budgets:Budget[]; setBudget/deleteBudget), `recurringSlice` (recurring:RecurringRule[]; addRule/updateRule/deleteRule), `goalsSlice` (goals:Goal[]; addGoal/updateGoal/deleteGoal/contribute), `settingsSlice` (currency:string='USD'; theme:'light'|'dark'='light'; setCurrency/setTheme/clearAllData). Feature tickets will flesh out the logic of THEIR slice; read-only features rely on these interfaces — so the interfaces must be complete and correct here.
5. `src/router.tsx` — a `createBrowserRouter` (or `<Routes>`) with a route for EVERY feature, each rendering that feature's `Page` component. Import each page from `src/features/<x>/<X>Page.tsx`. Routes: `/` (dashboard), `/accounts`, `/transactions`, `/categories`, `/budgets`, `/recurring`, `/goals`, `/reports`, `/networth`, `/import`, `/filters` (or fold into transactions — keep a `/filters` route), `/settings`.
6. `src/features/<x>/<X>Page.tsx` — a STUB page component for each of the 12 features (just an `<h1>` placeholder), so router imports resolve and the app builds. Each feature ticket REPLACES its own stub.
7. `src/components/Layout.tsx` + `src/components/Sidebar.tsx` — app shell with a sidebar listing ALL nav links (lucide icons) + `<Outlet/>`. Apply the persisted theme (dark class on <html>).
8. `src/components/ui/` — small shadcn-style primitives the features will reuse: `button.tsx`, `card.tsx`, `input.tsx`, `label.tsx`, `select.tsx`, `dialog.tsx` (a simple modal), `table.tsx`. Keep them dependency-light (Tailwind + clsx + tailwind-merge via `cn`).
9. `src/lib/utils.ts` (`cn` helper) and `src/lib/format.ts` (`formatCurrency(amount, currency)`, `formatDate`, month helpers).
10. `src/main.tsx` mounts `RouterProvider`/`<App/>` with the router; imports `app.css`.
11. `src/shell.test.tsx` — a vitest test rendering `Layout` with a memory router asserting the sidebar links appear. (Each FEATURE owns its own test file; do not create feature tests here.)

**Acceptance:** `pnpm install && pnpm build` succeeds (tsc clean + vite build emits dist) AND `pnpm vitest run` passes the shell test. The app must render: sidebar + all 12 stub pages reachable. Commit everything.
"""

def feat(title, files_own, spec):
    return {
        "title": title,
        "issueType": "feature",
        "priority": "medium",
        "statusId": BACKLOG,
        "description": spec + "\n\n**Files you own:** " + files_own + CONTRACT,
    }

issues = [
    # 0 meta
    {"title": "[epic] budget-pilot — personal budget tracker (autonomous board drive)",
     "issueType": "feature", "priority": "high", "statusId": BACKLOG,
     "description": "Meta/epic ticket tracking the autonomous board drive of budget-pilot. Children: shell + 12 feature tickets + integration + retro. Owned by the orchestrator; stays In Progress until all children are Done and master builds clean. Do NOT auto-start (tagged no-auto-start)."},
    # 1 shell
    {"title": "budget-pilot shell: scaffold app + pre-wire all shared files",
     "issueType": "feature", "priority": "high", "statusId": BACKLOG, "description": SHELL_DESC},
    # 2..13 features
    feat("budget-pilot: Accounts management",
         "`src/features/accounts/*`, `src/store/slices/accountsSlice.ts`",
         "Build the **Accounts** page (`/accounts`): list all accounts with name, type, balance (formatted via `formatCurrency`); add/edit/delete via a dialog form (name, type select, starting balance, currency). Flesh out `accountsSlice` actions (add/update/delete) with proper immutable updates. Show total balance across accounts."),
    feat("budget-pilot: Categories management",
         "`src/features/categories/*`, `src/store/slices/categoriesSlice.ts`",
         "Build the **Categories** page (`/categories`): list expense + income categories with a color swatch; add/edit/delete via dialog (name, color picker, kind). Flesh out `categoriesSlice`. Keep the ~6 sensible defaults seeded in the shell."),
    feat("budget-pilot: Transactions list + CRUD",
         "`src/features/transactions/*`, `src/store/slices/transactionsSlice.ts`",
         "Build the **Transactions** page (`/transactions`): a table of transactions (date, account, category, note, signed amount colored by type) sorted newest-first; add/edit/delete via a dialog (account select, category select, amount, type, date, note). Flesh out `transactionsSlice`. Updating a transaction should keep account balances consistent if you choose to derive them — but do NOT edit accountsSlice; if you adjust balances, do it via the existing `updateAccount` action."),
    feat("budget-pilot: Budgets per category",
         "`src/features/budgets/*`, `src/store/slices/budgetsSlice.ts`",
         "Build the **Budgets** page (`/budgets`): for the current month, set a spending limit per expense category and show a progress bar of actual spending (sum of this month's expense transactions in that category) vs limit, turning red when over. Flesh out `budgetsSlice` (setBudget/deleteBudget). Read transactions + categories from the store (read-only)."),
    feat("budget-pilot: Recurring transactions",
         "`src/features/recurring/*`, `src/store/slices/recurringSlice.ts`",
         "Build the **Recurring** page (`/recurring`): manage recurring rules (account, category, amount, type, cadence, next date, note); list upcoming occurrences; a 'Post now' button that creates a real transaction from a rule (via the store's `addTransaction`) and advances `nextDate` by the cadence. Flesh out `recurringSlice`."),
    feat("budget-pilot: Savings goals",
         "`src/features/goals/*`, `src/store/slices/goalsSlice.ts`",
         "Build the **Goals** page (`/goals`): savings goals with target/current amount, optional deadline, a progress ring/bar, and a 'Contribute' action that increments currentAmount. Flesh out `goalsSlice` (add/update/delete/contribute)."),
    feat("budget-pilot: Dashboard overview",
         "`src/features/dashboard/*`",
         "Build the **Dashboard** page (`/`, the home route): summary cards (total balance, this-month income, this-month expenses, net) + two recharts charts: spending over the last 6 months (bar/line) and spending by category this month (pie). READ-ONLY over the store (accounts, transactions, categories). Uses chart-friendly colors; degrade gracefully with no data."),
    feat("budget-pilot: Reports",
         "`src/features/reports/*`",
         "Build the **Reports** page (`/reports`): a month picker; for the selected month show income vs expense totals, a category breakdown table (category, spent, % of total), and a recharts bar chart of spending by category. READ-ONLY over the store."),
    feat("budget-pilot: Net worth over time",
         "`src/features/networth/*`",
         "Build the **Net Worth** page (`/networth`): compute net worth as sum of account balances, and a time series by replaying transactions month-by-month; show current net worth + a recharts area/line chart of net worth over the last 12 months. READ-ONLY over the store."),
    feat("budget-pilot: CSV import",
         "`src/features/csvImport/*`",
         "Build the **Import** page (`/import`): upload a CSV of transactions (papaparse), map columns (date, amount, note, optional category/account) via simple selects, preview the parsed rows, then import — creating transactions via the store's `addTransaction`. Show count imported. READ-ONLY except via existing store actions (do not edit transactionsSlice)."),
    feat("budget-pilot: Filters & search",
         "`src/features/filters/*`",
         "Build the **Filters** page (`/filters`): a transactions view with a filter bar — text search on note, date range, account, category, and min/max amount — showing the filtered, count + summed total. READ-ONLY over the store (reuse transactions). Keep the filter bar as a self-contained component in your folder."),
    feat("budget-pilot: Settings",
         "`src/features/settings/*`, `src/store/slices/settingsSlice.ts`",
         "Build the **Settings** page (`/settings`): change display currency (select), toggle light/dark theme (applies immediately via the slice + Layout), and a 'Clear all data' button (with confirm) that calls `clearAllData`. Flesh out `settingsSlice`."),
    # 14 integration
    {"title": "budget-pilot: integration smoke test",
     "issueType": "feature", "priority": "medium", "statusId": BACKLOG,
     "description": "Add ONE app-level smoke test `src/app.smoke.test.tsx` that renders the full app within a router and navigates to every route (`/`, `/accounts`, `/transactions`, `/categories`, `/budgets`, `/recurring`, `/goals`, `/reports`, `/networth`, `/import`, `/filters`, `/settings`) asserting each page mounts without crashing and the sidebar is present. **Files you own:** `src/app.smoke.test.tsx` ONLY. Do NOT edit any feature file, the router, or shared files — if a route is genuinely broken, file a follow-up note in this ticket rather than editing feature code. The gate runs `pnpm install && pnpm build`; also ensure `pnpm vitest run` passes." + CONTRACT},
    # 15 retro
    {"title": "budget-pilot: finalize README + verify clean build",
     "issueType": "feature", "priority": "low", "statusId": BACKLOG,
     "description": "Final polish: ensure `pnpm install && pnpm build` is green on a clean checkout, and write a short **Features** section in `README.md` listing the 12 implemented features with one line each. **Files you own:** `README.md` ONLY. Do not edit source files." + CONTRACT},
]

resp = post(f"/api/issues/batch", {"projectId": PID, "issues": issues})
created = resp["issues"]
ids = [c["id"] for c in created]
nums = [c.get("issueNumber") for c in created]
print("created:", list(zip(nums, [c["title"][:40] for c in created])))

# index map: 0=meta,1=shell,2..13=features(12),14=integration,15=retro
shell = 1
feature_idxs = list(range(2, 14))  # 12 features
integration = 14
retro = 15

edges = []
# every feature depends on the shell
for fi in feature_idxs:
    edges.append({"issueId": ids[fi], "dependsOnId": ids[shell], "type": "depends_on", "action": "add"})
# integration depends on all features
for fi in feature_idxs:
    edges.append({"issueId": ids[integration], "dependsOnId": ids[fi], "type": "depends_on", "action": "add"})
# retro depends on integration
edges.append({"issueId": ids[retro], "dependsOnId": ids[integration], "type": "depends_on", "action": "add"})

dep_resp = post("/api/issues/dependencies/batch", {"edges": edges})
print("deps:", dep_resp)

# emit a mapping file for later use
mapping = {"meta": ids[0], "metaNum": nums[0], "shell": ids[shell], "shellNum": nums[shell],
           "integration": ids[integration], "integrationNum": nums[integration],
           "retro": ids[retro], "retroNum": nums[retro],
           "features": [{"id": ids[i], "num": nums[i], "title": created[i]["title"]} for i in feature_idxs]}
open("/tmp/budget_pilot_ids.json", "w").write(json.dumps(mapping, indent=2))
print("wrote /tmp/budget_pilot_ids.json")
print("meta #", nums[0], " shell #", nums[shell])
