# ShiftWise Rails Drive

Date: 2026-06-17

Target project: `C:\projects\shiftwise-rails`

Board project id: `68692144-446d-474b-ab3b-562b5720d04e`

Drive id: `f1c1eab6-3956-4dd2-9620-eafd8ab0e1e6`

Meta issue: `#1 [ShiftWise] EPIC: shift and employee management Rails app`

Child issues: `#2` through `#31`

## Setup

The drive was seeded with `scripts/drive-shiftwise-rails.py`. The script is idempotent and:

- creates or reuses `C:\projects\shiftwise-rails`
- seeds a Rails-layout scaffold and commits it on `master`
- registers/configures the project for Drive mode
- creates a 30-ticket ShiftWise shift and employee management epic
- normalizes the drive graph to epic `parent_of` child edges
- pins the drive to `claude:anth`
- sets `python scripts/verify_static.py` as the verify gate
- starts the first dependency wave

## Dependency Shape

Tier 0:

- `#2` shell and architecture map

Tier 1:

- `#3` through `#27`, mostly disjoint Rails models, controllers, services, policies, seeds, and reports

Tier 2:

- `#28` through `#31`, integration, layout, operations docs, and final static verification

## Current State

Preflight is green. The Drive dashboard reports `30` scoped child tickets, with `#2` in progress and the remaining child tickets blocked behind the shell or feature wave as intended.

Ruby/Rails are not available on the host PATH, so the drive uses a Rails-layout repository plus a Python static verifier until a Ruby runtime is installed. Ticket prompts explicitly tell builders not to run browser installs, screenshots, or visual verification; the board owns that verification.
