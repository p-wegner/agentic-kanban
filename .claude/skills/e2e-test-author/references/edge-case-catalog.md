# Edge-case catalog — concrete cases to pull from

For negative/boundary/error/concurrency gaps, don't invent cases ad hoc — select the applicable
ones from this catalog so coverage of these dimensions is systematic. Each generated test for an
edge gap should name which catalog entry it realises.

## Empty / absence
- empty list/table (no issues, no workspaces, no results) — does the empty state render & is it correct?
- empty required field on submit — is it rejected with the right message?
- entity referenced after deletion (open a detail panel, delete underlying row elsewhere).
- search/filter with zero matches.

## Boundary / size
- min and max allowed length (title at 0, 1, max, max+1 chars).
- very large input (10k-char description; 500-row table) — does it render/persist without truncation-bugs?
- numeric bounds (estimate 0, negative, huge; priority at ends of the enum).
- unicode / emoji / RTL / leading-trailing whitespace / quotes & angle brackets (XSS-shaped) in text fields.
- pagination edges (exactly one page, page boundary, last page).

## Permissions / roles (only if the system has them)
- allowed actor succeeds AND denied actor is refused (both halves — denial alone is half a test).
- privilege boundary: actor acts on another actor's resource.
- (agentic-kanban is single-user/local — usually N/A; record as such, don't fabricate RBAC.)

## State / lifecycle
- each legal transition fires and lands in the expected state.
- **illegal** transition is refused (e.g. merge a discarded workspace, turn on a non-running session).
- idempotency: repeat the same action — second call is a no-op or the documented result, not a dup.
- stale-state action: act on an entity whose state changed since the UI loaded.

## Concurrency / timing (observable from outside)
- double-submit (click twice fast / two POSTs) → single effect, not duplicates.
- parallel edits to the same entity → last-write/conflict handling is deterministic.
- action while a long operation is in flight (turn on a busy workspace → 409).
- refresh / back-navigation mid-flow → state restored correctly, no orphan.

## Network / failure
- request fails (4xx/5xx) → UI shows error, stays usable, no half-applied state.
- timeout / slow response → spinner/disabled state, eventual error, no hang.
- partial failure in a multi-step op → documented rollback or clear partial-state report.
- expired session / lost auth mid-flow (if applicable).

## Routing / deep-link
- deep-link straight to a detail/route (not via navigation) resolves.
- invalid/non-existent id in URL → graceful not-found, not a crash.
- unknown route → 404/redirect as designed.

## Config / flags
- behaviour under ≥2 materially different settings (e.g. a pref on vs off; provider Claude vs Codex).
- feature flag on vs off changes the observable surface as documented.

## Selection guidance
Pick the catalog entries that match the gap's `dimensions to add` and the capability's real
surface. A single edge test should assert ONE edge precisely (and say which) rather than sweep
many shallowly. Skip entries that are genuinely N/A for the system and note why.
