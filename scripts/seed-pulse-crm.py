#!/usr/bin/env python
"""Seed the PulseCRM 20-ticket, 3-tier fan-out epic atomically (issues + edges)."""
import json, urllib.request

BASE = "http://localhost:3001"
PID = "5e10429c-c3a5-4e41-8869-4d86d267d2a5"
BACKLOG = "8d95fc44-e5cf-40e3-9ce8-e521bbb9283a"

def post(p, b):
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode(), headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(r).read())

CONTRACT = (
    "\n\n---\n**Ownership & contract:** Edit ONLY the files under *Files you own*. Do NOT touch the shell's shared files "
    "(`src/types.ts`, `src/store/index.ts`, `src/router.tsx`, `src/components/Sidebar.tsx`, `src/components/ui/*`, `src/lib/*`, "
    "`package.json`, configs) — they are pre-wired. ALL deps are installed; never `pnpm add`. Shared domain types are in "
    "`src/types.ts` (read-only). Your nav link, route, and a stub page already exist — replace YOUR stub page only. The merge gate "
    "runs `pnpm install && pnpm build` and blocks on failure; run `pnpm build` yourself first. Write your own test file (listed). "
    "Persist state via your Zustand slice; style with Tailwind + the existing ui primitives."
)

SHELL = """**Shell / scaffold for PulseCRM** — a small CRM SPA. Build the base app skeleton and PRE-WIRE every shared/hot file so 17 feature tickets build in parallel with zero file conflicts. Be thorough; the whole epic depends on this.

**Stack:** Vite + React + TypeScript + Tailwind v4 (`@tailwindcss/vite`) + Zustand (persist) + react-router-dom v6 + recharts + lucide-react + date-fns + papaparse. Use `pnpm`. Install ALL of: runtime `react react-dom react-router-dom zustand recharts date-fns clsx tailwind-merge lucide-react papaparse`; dev `typescript vite @vitejs/plugin-react @tailwindcss/vite tailwindcss vitest jsdom @testing-library/react @testing-library/jest-dom @types/react @types/react-dom @types/papaparse`. (Feature tickets must never add packages.)

**Create the full skeleton:**
1. Vite React-TS layout: `index.html`, `src/main.tsx`, `vite.config.ts` (react + tailwind plugins + vitest `environment:'jsdom'`, `setupFiles`), `tsconfig.json` (strict), `src/app.css` (`@import "tailwindcss";`).
2. `src/types.ts` — define ALL shared domain types and export them: `Contact` {id,firstName,lastName,email,phone,companyId:string|null,tagIds:string[],createdAt}; `Company` {id,name,domain,industry,createdAt}; `Stage` {id,name,order:number}; `Deal` {id,title,contactId:string|null,companyId:string|null,stageId,amount:number,createdAt,closedAt:string|null}; `Activity` {id,type:'call'|'email'|'meeting'|'task',subject,dueDate:string,done:boolean,contactId:string|null,dealId:string|null,createdAt}; `Note` {id,body,contactId:string|null,dealId:string|null,createdAt}; `Tag` {id,name,color}; `EmailTemplate` {id,name,subject,body}; `SavedView` {id,name,entity:'contacts'|'deals',filterJson:string}.
3. `src/store/index.ts` — ONE Zustand store using `persist` (localStorage key `pulse-crm`) composing ALL slices: contacts, companies, deals, activities, notes, tags, stages, settings, templates, views. Export a typed `useStore` hook + `StoreState`.
4. `src/store/slices/<name>Slice.ts` — a STUB per slice with the FULL interface + minimal working impl (arrays + actions using crypto.randomUUID()). Slices & key actions: `contactsSlice` (contacts:Contact[]; addContact/updateContact/deleteContact), `companiesSlice` (companies:Company[]; add/update/delete), `dealsSlice` (deals:Deal[]; addDeal/updateDeal/deleteDeal/moveDealToStage), `activitiesSlice` (activities:Activity[]; add/update/delete/toggleDone), `notesSlice` (notes:Note[]; add/update/delete), `tagsSlice` (tags:Tag[] seeded ~5; add/update/delete), `stagesSlice` (stages:Stage[] seeded with 5 ordered defaults Lead/Qualified/Proposal/Won/Lost; addStage/updateStage/deleteStage/reorder), `settingsSlice` (currency:string='USD'; theme:'light'|'dark'='light'; setCurrency/setTheme/clearAllData), `templatesSlice` (templates:EmailTemplate[]; add/update/delete), `viewsSlice` (views:SavedView[]; add/delete). Feature tickets flesh out THEIR slice; read-only features rely on these interfaces, so make them complete and correct.
5. `src/router.tsx` — a `createBrowserRouter` with a route for EVERY feature, each rendering that feature's `Page`. Routes: `/` (dashboard), `/contacts`, `/contacts/:id` (contact detail), `/companies`, `/deals`, `/activities`, `/notes`, `/tags`, `/stages`, `/settings`, `/import`, `/calendar`, `/templates`, `/views`, `/reports`, `/search`, `/timeline`. Import each page from `src/features/<x>/<X>Page.tsx`.
6. `src/features/<x>/<X>Page.tsx` — a STUB page per feature (placeholder `<h1>`), so the app builds. Each feature ticket REPLACES its own stub. Create stubs for: dashboard, contacts, contactDetail, companies, deals, activities, notes, tags, stages, settings, import, calendar, templates, views, reports, search, timeline.
7. `src/components/Layout.tsx` + `src/components/Sidebar.tsx` — app shell, sidebar with ALL nav links (lucide icons) + `<Outlet/>`; apply persisted theme to <html>.
8. `src/components/ui/` — shadcn-style primitives the features reuse: `button.tsx card.tsx input.tsx label.tsx select.tsx dialog.tsx table.tsx badge.tsx textarea.tsx` (Tailwind + clsx + tailwind-merge via `cn`).
9. `src/lib/utils.ts` (`cn`) and `src/lib/format.ts` (`formatCurrency(amount,currency)`, `formatDate`, relative-time).
10. `src/main.tsx` mounts the router; imports `app.css`. `src/shell.test.tsx` renders Layout asserting sidebar links (each FEATURE owns its own test).

**Acceptance:** `pnpm install && pnpm build` succeeds (tsc clean + vite build emits dist) AND `pnpm vitest run` passes the shell test; all 17 stub routes render. Commit everything."""

def feat(title, files, spec, deps_note=""):
    return {"title": title, "issueType": "feature", "priority": "medium", "statusId": BACKLOG,
            "description": spec + (("\n\n" + deps_note) if deps_note else "") + "\n\n**Files you own:** " + files + CONTRACT}

issues = [
 {"title": "PulseCRM shell: scaffold app + pre-wire all shared files", "issueType": "feature", "priority": "high", "statusId": BACKLOG, "description": SHELL},
 # --- tier 1 (idx 1..13) depend on shell only ---
 feat("PulseCRM: Contacts CRUD", "`src/features/contacts/*`, `src/store/slices/contactsSlice.ts`",
      "Build the **Contacts** page (`/contacts`): a searchable table (name, email, phone, company) with add/edit/delete via a dialog (first/last name, email, phone, company select, tag multi-select). Flesh out `contactsSlice`. Link each row to its detail route `/contacts/:id`."),
 feat("PulseCRM: Companies CRUD", "`src/features/companies/*`, `src/store/slices/companiesSlice.ts`",
      "Build the **Companies** page (`/companies`): table of companies (name, domain, industry, # contacts) with add/edit/delete dialog. Flesh out `companiesSlice`."),
 feat("PulseCRM: Deals pipeline", "`src/features/deals/*`, `src/store/slices/dealsSlice.ts`",
      "Build the **Deals** page (`/deals`): a kanban pipeline with a column per stage (read stages from `stagesSlice`), deal cards (title, amount, contact/company) that can be moved between stages via a stage `<select>` (call `moveDealToStage`); add/edit/delete a deal via dialog. Flesh out `dealsSlice`. Show total amount per column."),
 feat("PulseCRM: Activities & tasks", "`src/features/activities/*`, `src/store/slices/activitiesSlice.ts`",
      "Build the **Activities** page (`/activities`): a list of activities (type call/email/meeting/task, subject, due date, linked contact/deal, done checkbox) sorted by due date; add/edit/delete dialog; toggle done. Flesh out `activitiesSlice`."),
 feat("PulseCRM: Notes", "`src/features/notes/*`, `src/store/slices/notesSlice.ts`",
      "Build the **Notes** page (`/notes`): freeform notes optionally linked to a contact or deal; add/edit/delete; newest first. Flesh out `notesSlice`."),
 feat("PulseCRM: Tags", "`src/features/tags/*`, `src/store/slices/tagsSlice.ts`",
      "Build the **Tags** page (`/tags`): manage tags (name, color swatch) with add/edit/delete. Flesh out `tagsSlice` (keep the ~5 seeded defaults)."),
 feat("PulseCRM: Pipeline stages config", "`src/features/stages/*`, `src/store/slices/stagesSlice.ts`",
      "Build the **Stages** page (`/stages`): configure pipeline stages (name, order) with add/edit/delete and reorder (move up/down). Flesh out `stagesSlice` (keep the 5 seeded defaults). The Deals pipeline reads these."),
 feat("PulseCRM: Settings", "`src/features/settings/*`, `src/store/slices/settingsSlice.ts`",
      "Build the **Settings** page (`/settings`): display currency select, light/dark theme toggle (applies immediately via slice + Layout), and a 'Clear all data' button (confirm) calling `clearAllData`. Flesh out `settingsSlice`."),
 feat("PulseCRM: Contacts CSV import", "`src/features/import/*`",
      "Build the **Import** page (`/import`): upload a CSV of contacts (papaparse), map columns (firstName, lastName, email, phone), preview rows, then import via the store's `addContact`. Show count imported. READ-ONLY except via existing store actions (do not edit contactsSlice)."),
 feat("PulseCRM: Calendar view", "`src/features/calendar/*`",
      "Build the **Calendar** page (`/calendar`): a simple month grid showing activities on their due dates (read `activities` from the store), with a list of the selected day's activities. READ-ONLY over the store."),
 feat("PulseCRM: Email templates", "`src/features/templates/*`, `src/store/slices/templatesSlice.ts`",
      "Build the **Templates** page (`/templates`): manage reusable email templates (name, subject, body) with add/edit/delete and a copy-to-clipboard button. Flesh out `templatesSlice`."),
 feat("PulseCRM: Saved views", "`src/features/views/*`, `src/store/slices/viewsSlice.ts`",
      "Build the **Views** page (`/views`): list saved filter views (name, entity) with delete, and a small form to save a new view (name, entity contacts|deals, a simple filter expression stored as JSON). Flesh out `viewsSlice`. (Other pages need not consume them yet.)"),
 feat("PulseCRM: Contact detail page", "`src/features/contactDetail/*`",
      "Build the **Contact detail** page (route `/contacts/:id`): show the contact's fields and RELATED data read from the store — their company, deals (where contactId matches), activities, and notes — in tabbed/sectioned panels. READ-ONLY over the store (use existing actions only). Handle an unknown id gracefully."),
 # --- tier 2 (idx 14..17): cross-entity, depend on several tier-1 features ---
 feat("PulseCRM: Dashboard overview", "`src/features/dashboard/*`",
      "Build the **Dashboard** (`/`, home): summary cards (total contacts, companies, open deals, pipeline value) + recharts: deals-by-stage (bar) and pipeline value over time (line). READ-ONLY over contacts, companies, deals. Degrade gracefully with no data.",
      "_Depends on Contacts, Companies, Deals being implemented._"),
 feat("PulseCRM: Reports", "`src/features/reports/*`",
      "Build the **Reports** page (`/reports`): a date-range picker; won/lost deal counts and total won value for the range, a deals-by-stage breakdown table, and an activities-completed count. recharts bar chart of won value by month. READ-ONLY over deals + activities.",
      "_Depends on Deals, Activities._"),
 feat("PulseCRM: Global search / command palette", "`src/features/search/*`",
      "Build the **Search** page (`/search`) AND a command-palette-style search box: a single query that searches across contacts (name/email), companies (name), deals (title), and notes (body), grouping results by entity with links to the relevant pages. READ-ONLY over the store.",
      "_Depends on Contacts, Companies, Deals, Notes._"),
 feat("PulseCRM: Activity timeline", "`src/features/timeline/*`",
      "Build the **Timeline** page (`/timeline`): a unified reverse-chronological feed merging deals (created/closed), activities (due/done), and notes (created) into one event list with type icons and relative timestamps. READ-ONLY over the store.",
      "_Depends on Deals, Activities, Notes._"),
 # --- integration + retro ---
 {"title": "PulseCRM: integration smoke test", "issueType": "feature", "priority": "medium", "statusId": BACKLOG,
  "description": "Add ONE app-level smoke test `src/app.smoke.test.tsx` that renders the full app in a router and navigates to every route (`/`, `/contacts`, `/contacts/:id` with a seeded id, `/companies`, `/deals`, `/activities`, `/notes`, `/tags`, `/stages`, `/settings`, `/import`, `/calendar`, `/templates`, `/views`, `/reports`, `/search`, `/timeline`) asserting each mounts without crashing and the sidebar renders. **Files you own:** `src/app.smoke.test.tsx` ONLY. Do not edit feature/router/shared files; if a route is genuinely broken, note it in this ticket rather than editing feature code. The gate runs `pnpm install && pnpm build`; also ensure `pnpm vitest run` passes." + CONTRACT},
 {"title": "PulseCRM: finalize README + verify clean build", "issueType": "feature", "priority": "low", "statusId": BACKLOG,
  "description": "Ensure `pnpm install && pnpm build` is green on a clean checkout, and write a **Features** section in `README.md` listing the 17 features one line each. **Files you own:** `README.md` ONLY. Do not edit source files." + CONTRACT},
]

resp = post("/api/issues/batch", {"projectId": PID, "issues": issues})
created = resp["issues"]; ids = [c["id"] for c in created]; nums = [c["issueNumber"] for c in created]
print("created %d issues: #%d..#%d" % (len(created), nums[0], nums[-1]))

edges = []
def dep(a, b):  # issue idx a depends on idx b
    edges.append({"issueId": ids[a], "dependsOnId": ids[b], "type": "depends_on", "action": "add"})

for i in range(1, 14):      # tier-1 (idx1..13) depend on shell (idx0)
    dep(i, 0)
for d in (1, 2, 3): dep(14, d)          # dashboard <- contacts,companies,deals
for d in (3, 4): dep(15, d)             # reports <- deals,activities
for d in (1, 2, 3, 5): dep(16, d)       # search <- contacts,companies,deals,notes
for d in (3, 4, 5): dep(17, d)          # timeline <- deals,activities,notes
for i in range(1, 18): dep(18, i)       # integration <- all features idx1..17
dep(19, 18)                              # retro <- integration

dr = post("/api/issues/dependencies/batch", {"edges": edges})
print("edges:", dr)
m = {"shell": ids[0], "shellNum": nums[0], "integration": ids[18], "integrationNum": nums[18], "retro": ids[19], "retroNum": nums[19],
     "all": [{"id": ids[i], "num": nums[i], "title": created[i]["title"]} for i in range(len(ids))]}
open("/tmp/pulse_ids.json", "w").write(json.dumps(m, indent=2))
print("wrote /tmp/pulse_ids.json; shell #%d, integration #%d, retro #%d" % (nums[0], nums[18], nums[19]))
