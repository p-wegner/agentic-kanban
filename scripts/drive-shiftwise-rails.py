#!/usr/bin/env python3
"""Seed and start a 30-ticket Rails-style drive for ShiftWise.

The local machine may not have Ruby/Rails installed, so the initial repo is a
Rails-layout scaffold with a Python static verifier. The board tickets are
written to keep visual verification out of builder prompts and to let the board
own all screenshots.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request
from pathlib import Path


BASE = os.environ.get("KANBAN_BASE", "http://127.0.0.1:3001")
PROJECT_NAME = "shiftwise-rails"
PROJECT_PATH = Path(r"C:\projects\shiftwise-rails")


def request(method: str, path: str, body: object | None = None) -> object:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed: {err.code} {detail}") from err


def run(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed in {cwd}\n{proc.stderr or proc.stdout}")
    return proc.stdout.strip()


def ensure_project() -> dict:
    projects = request("GET", "/api/projects")
    for project in projects:
        if project.get("repoPath", "").lower() == str(PROJECT_PATH).lower():
            return project
    return request(
        "POST",
        "/api/projects/create",
        {
            "name": PROJECT_NAME,
            "description": "Ruby on Rails shift and employee management app driven by a 30-ticket board epic.",
            "gitignoreTemplate": "ruby",
            "generateReadme": True,
        },
    )


def write(path: str, content: str) -> None:
    target = PROJECT_PATH / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8", newline="\n")


def ensure_scaffold() -> None:
    write(
        "README.md",
        """
        # ShiftWise Rails

        ShiftWise is a Ruby on Rails shift and employee management application
        built through an agentic-kanban 30-ticket drive.

        The repository starts as a Rails-layout scaffold. Until Ruby/Rails is
        available on the host, `python scripts/verify_static.py` is the required
        verification command for board builders.
        """,
    )
    write(
        "Gemfile",
        """
        source "https://rubygems.org"

        ruby "3.3.0"
        gem "rails", "~> 7.1.0"
        gem "sqlite3", "~> 1.7"
        gem "puma", ">= 5.0"
        gem "importmap-rails"
        gem "turbo-rails"
        gem "stimulus-rails"
        gem "jbuilder"

        group :development, :test do
          gem "debug", platforms: %i[mri windows]
        end

        group :test do
          gem "minitest"
        end
        """,
    )
    write(
        "config/routes.rb",
        """
        Rails.application.routes.draw do
          root "dashboard#index"
        end
        """,
    )
    write(
        "config/application.rb",
        """
        require_relative "boot"
        require "rails/all"

        Bundler.require(*Rails.groups)

        module ShiftwiseRails
          class Application < Rails::Application
            config.load_defaults 7.1
            config.time_zone = "UTC"
          end
        end
        """,
    )
    write("config/boot.rb", "ENV['BUNDLE_GEMFILE'] ||= File.expand_path('../Gemfile', __dir__)\nrequire 'bundler/setup'\n")
    write("app/controllers/application_controller.rb", "class ApplicationController < ActionController::Base\nend\n")
    write("app/controllers/dashboard_controller.rb", "class DashboardController < ApplicationController\n  def index\n  end\nend\n")
    write("app/views/dashboard/index.html.erb", "<h1>ShiftWise</h1>\n<p>Shift and employee management workspace.</p>\n")
    write(
        "scripts/verify_static.py",
        """
        from pathlib import Path
        import sys

        required = [
            "Gemfile",
            "config/application.rb",
            "config/routes.rb",
            "app/controllers/application_controller.rb",
            "app/controllers/dashboard_controller.rb",
            "app/views/dashboard/index.html.erb",
        ]
        missing = [p for p in required if not Path(p).exists()]
        if missing:
            print("Missing required Rails scaffold files: " + ", ".join(missing), file=sys.stderr)
            sys.exit(1)
        routes = Path("config/routes.rb").read_text(encoding="utf-8")
        if 'root "dashboard#index"' not in routes:
            print("Expected dashboard root route", file=sys.stderr)
            sys.exit(1)
        print("ShiftWise static Rails scaffold verification passed.")
        """,
    )
    run(["python", "scripts/verify_static.py"], PROJECT_PATH)
    status = run(["git", "status", "--short"], PROJECT_PATH)
    if status:
        run(["git", "add", "-A"], PROJECT_PATH)
        run(["git", "commit", "-m", "Seed ShiftWise Rails scaffold"], PROJECT_PATH)


def ensure_default_branch(project_id: str) -> None:
    branch = run(["git", "branch", "--show-current"], PROJECT_PATH) or "master"
    request("PATCH", f"/api/projects/{project_id}", {"defaultBranch": branch})


def set_meta_in_progress(project_id: str, epic_id: str) -> None:
    statuses = request("GET", f"/api/projects/{project_id}/statuses")
    in_progress = next((s for s in statuses if s.get("name") == "In Progress"), None)
    if in_progress:
        request("PATCH", f"/api/issues/{epic_id}", {"statusId": in_progress["id"]})


def normalize_epic_parent_edges(project_id: str, epic_id: str) -> None:
    rows = request("GET", f"/api/issues?projectId={project_id}&slim=1")
    child_ids = [
        row["id"]
        for row in rows
        if row.get("id") != epic_id and (row.get("title") or "").startswith("[ShiftWise]")
    ]
    if not child_ids:
        return
    deps = request("GET", f"/api/issues/{epic_id}/dependencies").get("dependencies", [])
    edges: list[dict] = []
    for dep in deps:
        if dep.get("type") == "child_of" and dep.get("dependsOnId") == epic_id:
            edges.append(
                {
                    "issueId": dep["issueId"],
                    "dependsOnId": epic_id,
                    "type": "child_of",
                    "action": "remove",
                }
            )
    for child_id in child_ids:
        edges.append(
            {
                "issueId": epic_id,
                "dependsOnId": child_id,
                "type": "parent_of",
                "action": "add",
            }
        )
    if edges:
        request("POST", "/api/issues/dependencies/batch", {"edges": edges})


COMMON = """
Builder constraints:
- Do not run screenshot, browser install, visual verification, or Playwright install commands.
- Run `python scripts/verify_static.py` before committing.
- Keep edits inside the owned files listed below unless the ticket explicitly names another file.
- This is a Rails app for shift and employee management; preserve Rails naming conventions.
"""


def issue(title: str, files: list[str], body: str, priority: str = "medium") -> dict:
    owned = "\n".join(f"- `{f}`" for f in files)
    return {
        "title": title,
        "description": f"{COMMON}\nOwned files:\n{owned}\n\n{body.strip()}\n",
        "issueType": "task",
        "priority": priority,
    }


def tickets() -> list[dict]:
    return [
        issue("[ShiftWise] Shell: Rails app structure and module map", ["docs/architecture.md", "scripts/verify_static.py"], "Document the intended Rails modules, owned-file map, and static verifier expectations for the full drive.", "high"),
        issue("[ShiftWise] Employee model and repository contract", ["app/models/employee.rb", "db/migrate/001_create_employees.rb", "test/models/employee_test.rb"], "Add Employee fields for name, role, employment status, hire date, and contact data with validations."),
        issue("[ShiftWise] Location and department model", ["app/models/location.rb", "app/models/department.rb", "db/migrate/002_create_locations_departments.rb", "test/models/location_department_test.rb"], "Model work locations and departments with simple validation and associations."),
        issue("[ShiftWise] Role and skill catalog", ["app/models/role.rb", "app/models/skill.rb", "db/migrate/003_create_roles_skills.rb", "test/models/role_skill_test.rb"], "Represent roles and skills required for shift coverage."),
        issue("[ShiftWise] Availability preferences", ["app/models/availability_preference.rb", "db/migrate/004_create_availability_preferences.rb", "test/models/availability_preference_test.rb"], "Capture preferred and unavailable weekly windows per employee."),
        issue("[ShiftWise] Time-off requests", ["app/models/time_off_request.rb", "db/migrate/005_create_time_off_requests.rb", "test/models/time_off_request_test.rb"], "Add request statuses, dates, reason, and approval metadata."),
        issue("[ShiftWise] Shift template model", ["app/models/shift_template.rb", "db/migrate/006_create_shift_templates.rb", "test/models/shift_template_test.rb"], "Create reusable templates for department, role, start time, end time, and staffing count."),
        issue("[ShiftWise] Scheduled shift model", ["app/models/shift.rb", "db/migrate/007_create_shifts.rb", "test/models/shift_test.rb"], "Create concrete shifts assigned to employees and locations with validations for time ranges."),
        issue("[ShiftWise] Shift assignment service", ["app/services/shift_assignment_service.rb", "test/services/shift_assignment_service_test.rb"], "Implement assignment checks for employee status, overlap, availability, and time-off conflicts."),
        issue("[ShiftWise] Coverage forecast service", ["app/services/coverage_forecast_service.rb", "test/services/coverage_forecast_service_test.rb"], "Calculate daily staffing requirements vs assigned employees by role and department."),
        issue("[ShiftWise] Overtime risk service", ["app/services/overtime_risk_service.rb", "test/services/overtime_risk_service_test.rb"], "Detect employees approaching weekly hour thresholds."),
        issue("[ShiftWise] Swap request model", ["app/models/shift_swap_request.rb", "db/migrate/008_create_shift_swap_requests.rb", "test/models/shift_swap_request_test.rb"], "Represent requested swaps with requester, candidate, target shifts, status, and audit notes."),
        issue("[ShiftWise] Notification preference model", ["app/models/notification_preference.rb", "db/migrate/009_create_notification_preferences.rb", "test/models/notification_preference_test.rb"], "Store email/SMS/in-app preference flags and quiet hours."),
        issue("[ShiftWise] Dashboard controller summary", ["app/controllers/dashboard_controller.rb", "app/views/dashboard/index.html.erb", "test/controllers/dashboard_controller_test.rb"], "Render a manager dashboard summary using placeholder query methods."),
        issue("[ShiftWise] Employees controller", ["app/controllers/employees_controller.rb", "app/views/employees/index.html.erb", "app/views/employees/show.html.erb", "test/controllers/employees_controller_test.rb"], "Add list/detail actions and simple views for employees."),
        issue("[ShiftWise] Schedule controller", ["app/controllers/shifts_controller.rb", "app/views/shifts/index.html.erb", "app/views/shifts/show.html.erb", "test/controllers/shifts_controller_test.rb"], "Add schedule list/detail actions grouped by date."),
        issue("[ShiftWise] Availability controller", ["app/controllers/availability_preferences_controller.rb", "app/views/availability_preferences/index.html.erb", "test/controllers/availability_preferences_controller_test.rb"], "Add manager-facing availability overview."),
        issue("[ShiftWise] Time-off controller", ["app/controllers/time_off_requests_controller.rb", "app/views/time_off_requests/index.html.erb", "test/controllers/time_off_requests_controller_test.rb"], "Add request queue view with status filters."),
        issue("[ShiftWise] Swap requests controller", ["app/controllers/shift_swap_requests_controller.rb", "app/views/shift_swap_requests/index.html.erb", "test/controllers/shift_swap_requests_controller_test.rb"], "Add swap request queue and detail basics."),
        issue("[ShiftWise] Routes for core manager workflows", ["config/routes.rb", "test/routing/manager_routes_test.rb"], "Wire RESTful routes for employees, shifts, availability, time off, and swaps."),
        issue("[ShiftWise] Seed realistic sample data", ["db/seeds.rb", "test/fixtures/shiftwise_seed_test.rb"], "Create sample locations, departments, employees, roles, availability, and shifts."),
        issue("[ShiftWise] Employee import service", ["app/services/employee_import_service.rb", "test/services/employee_import_service_test.rb"], "Parse CSV-like rows, validate required fields, and report row errors."),
        issue("[ShiftWise] Schedule export service", ["app/services/schedule_export_service.rb", "test/services/schedule_export_service_test.rb"], "Export a weekly schedule as deterministic CSV text."),
        issue("[ShiftWise] Policy objects for manager actions", ["app/policies/employee_policy.rb", "app/policies/shift_policy.rb", "test/policies/manager_policy_test.rb"], "Add simple policy classes for manager vs employee capabilities."),
        issue("[ShiftWise] Audit event model", ["app/models/audit_event.rb", "db/migrate/010_create_audit_events.rb", "test/models/audit_event_test.rb"], "Capture manager actions like approvals, assignments, imports, and swaps."),
        issue("[ShiftWise] Reporting summaries", ["app/services/workforce_report_service.rb", "test/services/workforce_report_service_test.rb"], "Summarize hours, coverage gaps, time-off volume, and swap volume."),
        issue("[ShiftWise] Integration: connect dashboard data flow", ["app/controllers/dashboard_controller.rb", "app/services/dashboard_summary_service.rb", "test/services/dashboard_summary_service_test.rb"], "Replace placeholder dashboard data with a summary service that composes earlier modules."),
        issue("[ShiftWise] Integration: navigation and layout", ["app/views/layouts/application.html.erb", "app/helpers/navigation_helper.rb", "test/helpers/navigation_helper_test.rb"], "Add app layout navigation for manager workflows without adding visual verification steps."),
        issue("[ShiftWise] Documentation: operations guide", ["docs/operations.md", "README.md"], "Document setup, static verification, target Rails commands when Ruby exists, and manager workflows."),
        issue("[ShiftWise] Final integration and static verification", ["scripts/verify_static.py", "docs/acceptance.md"], "Expand the static verifier to assert all owned modules exist, document acceptance criteria, and ensure the 30-ticket app is coherent.", "high"),
    ]


def seed_issues(project_id: str) -> tuple[str, int, int, str | None]:
    existing = request("GET", f"/api/issues?projectId={project_id}&slim=1")
    for row in existing:
        if row.get("title") == "[ShiftWise] EPIC: shift and employee management Rails app":
            children = [i for i in existing if "[ShiftWise]" in (i.get("title") or "") and i.get("id") != row.get("id")]
            low = min(i["issueNumber"] for i in children)
            high = max(i["issueNumber"] for i in children)
            drives = request("GET", f"/api/projects/{project_id}/drives")
            drive_id = next((d.get("id") for d in drives if d.get("metaIssueId") == row.get("id") and d.get("status") == "active"), None)
            normalize_epic_parent_edges(project_id, row["id"])
            set_meta_in_progress(project_id, row["id"])
            return row["id"], low, high, drive_id

    epic = request(
        "POST",
        "/api/issues",
        {
            "projectId": project_id,
            "title": "[ShiftWise] EPIC: shift and employee management Rails app",
            "description": (
                "Drive a Ruby on Rails shift and employee management app through 30 child tickets. "
                "Keep this meta issue active until all children are Done/Cancelled and merged."
            ),
            "issueType": "task",
            "priority": "high",
        },
    )
    epic_id = epic["id"]
    result = request(
        "POST",
        "/api/issues/batch",
        {
            "projectId": project_id,
            "parentIssueId": epic_id,
            "driveTarget": "Complete the 30-ticket ShiftWise Rails shift and employee management app",
            "issues": tickets(),
        },
    )
    created = result["issues"]
    ids = [row["id"] for row in created]
    shell = ids[0]
    edges = []
    for idx in range(1, 26):
        edges.append({"issueId": ids[idx], "dependsOnId": shell, "type": "depends_on", "action": "add"})
    for idx in [26, 27, 28, 29]:
        for dep in range(1, 26):
            edges.append({"issueId": ids[idx], "dependsOnId": ids[dep], "type": "depends_on", "action": "add"})
    request("POST", "/api/issues/dependencies/batch", {"edges": edges})
    normalize_epic_parent_edges(project_id, epic_id)
    set_meta_in_progress(project_id, epic_id)
    return epic_id, created[0]["issueNumber"], created[-1]["issueNumber"], result.get("driveId")


def configure_drive(project_id: str) -> None:
    strategy = {
        "version": 1,
        "activeAgentsTarget": 3,
        "maxNewStartsPerCycle": 3,
        "backlogFloor": 0,
        "providerPolicies": [
            {
                "id": "claude:anth",
                "label": "Claude anth",
                "provider": "claude",
                "profileName": "anth",
                "mode": "fill",
                "headroomPct": 0,
            }
        ],
    }
    prefs = {
        f"verify_script_{project_id}": "python scripts/verify_static.py",
        f"board_strategy_{project_id}": json.dumps(strategy),
        f"board_autodrive_{project_id}": "true",
        f"auto_merge_disabled_{project_id}": "false",
        f"start_mode_{project_id}": "monitor",
        f"project_stack_profile_{project_id}": json.dumps(
            {
                "stack": "ruby",
                "packageManager": "bundler",
                "isMonorepo": False,
                "workspaces": [],
                "installCommand": None,
                "buildCommand": "python scripts/verify_static.py",
                "testCommand": "python scripts/verify_static.py",
                "quickTestCommand": "python scripts/verify_static.py",
                "lintCommand": None,
                "typecheckCommand": None,
                "devCommand": "bin/rails server",
                "isWeb": True,
                "devHealthUrl": "http://127.0.0.1:3000",
                "devPort": 3000,
                "testDir": "test",
                "testRunner": "minitest",
                "source": "manual",
                "detectedMarkers": ["Gemfile", "config/application.rb"],
            }
        ),
    }
    request("PUT", "/api/preferences/settings", prefs)
    request("PUT", f"/api/projects/{project_id}/drive", {"enabled": True})
    request("POST", f"/api/projects/{project_id}/drive/preflight", {"autoRepair": True})


def main() -> int:
    project = ensure_project()
    ensure_scaffold()
    project_id = project["id"]
    ensure_default_branch(project_id)
    epic_id, low, high, drive_id = seed_issues(project_id)
    configure_drive(project_id)
    preflight = request("GET", f"/api/projects/{project_id}/drive/preflight")
    wave = request("POST", f"/api/projects/{project_id}/dependency-waves/start-next")
    print(json.dumps({
        "projectId": project_id,
        "projectPath": str(PROJECT_PATH),
        "epicId": epic_id,
        "childIssueRange": [low, high],
        "driveId": drive_id,
        "preflightReady": preflight.get("ready"),
        "wave": wave,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
