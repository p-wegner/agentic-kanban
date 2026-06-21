import { describe, it, expect } from "vitest";
import {
  scheduleFields,
  buildCreateRunPayload,
  buildUpdateRunPayload,
  runEditPatch,
  isUpdateRunDisabled,
  isCreateRunDisabled,
  cronFieldHint,
  deriveLastRunDisplay,
} from "./scheduled-run-form.js";

describe("scheduleFields", () => {
  it("cron mode emits the trimmed expression and the 60-min fallback interval", () => {
    expect(scheduleFields("cron", 15, "  0 9 * * 1-5 ", { clearCronOnInterval: false })).toEqual({
      cronExpression: "0 9 * * 1-5",
      intervalMinutes: 60,
    });
  });

  it("interval mode without clearCron omits cronExpression (create semantics)", () => {
    expect(scheduleFields("interval", 30, "ignored", { clearCronOnInterval: false })).toEqual({
      intervalMinutes: 30,
    });
  });

  it("interval mode with clearCron blanks cronExpression (edit semantics)", () => {
    expect(scheduleFields("interval", 30, "ignored", { clearCronOnInterval: true })).toEqual({
      intervalMinutes: 30,
      cronExpression: "",
    });
  });
});

describe("buildCreateRunPayload", () => {
  it("trims name/prompt and includes projectId for an interval run", () => {
    expect(buildCreateRunPayload({
      name: "  Daily  ", prompt: "  do it  ", projectId: "p1", mode: "interval", intervalMinutes: 45, cron: "",
    })).toEqual({ name: "Daily", prompt: "do it", projectId: "p1", intervalMinutes: 45 });
  });

  it("for a cron run carries the cron expression + 60-min fallback", () => {
    expect(buildCreateRunPayload({
      name: "Weekday", prompt: "p", projectId: "p1", mode: "cron", intervalMinutes: 5, cron: "0 9 * * 1-5",
    })).toEqual({ name: "Weekday", prompt: "p", projectId: "p1", cronExpression: "0 9 * * 1-5", intervalMinutes: 60 });
  });
});

describe("buildUpdateRunPayload", () => {
  it("interval edit explicitly clears cronExpression", () => {
    expect(buildUpdateRunPayload({ name: " n ", prompt: " p ", mode: "interval", intervalMinutes: 20, cron: "x" }))
      .toEqual({ name: "n", prompt: "p", intervalMinutes: 20, cronExpression: "" });
  });

  it("cron edit sets the expression and 60-min fallback (no projectId)", () => {
    expect(buildUpdateRunPayload({ name: "n", prompt: "p", mode: "cron", intervalMinutes: 20, cron: " */5 * * * * " }))
      .toEqual({ name: "n", prompt: "p", cronExpression: "*/5 * * * *", intervalMinutes: 60 });
  });
});

describe("runEditPatch", () => {
  it("interval edit keeps cronExpression null and uses the new interval", () => {
    expect(runEditPatch({ name: " n ", prompt: " p ", mode: "interval", intervalMinutes: 10, cron: "x", existingIntervalMinutes: 99 }))
      .toEqual({ name: "n", prompt: "p", intervalMinutes: 10, cronExpression: null });
  });

  it("cron edit keeps the existing interval and stores the trimmed cron", () => {
    expect(runEditPatch({ name: "n", prompt: "p", mode: "cron", intervalMinutes: 10, cron: " 0 0 * * * ", existingIntervalMinutes: 99 }))
      .toEqual({ name: "n", prompt: "p", intervalMinutes: 99, cronExpression: "0 0 * * *" });
  });
});

describe("isUpdateRunDisabled", () => {
  it("disabled when name is blank", () => {
    expect(isUpdateRunDisabled({ name: "  ", saving: false, mode: "interval", cron: "" })).toBe(true);
  });
  it("disabled while saving", () => {
    expect(isUpdateRunDisabled({ name: "n", saving: true, mode: "interval", cron: "" })).toBe(true);
  });
  it("enabled for a valid interval run", () => {
    expect(isUpdateRunDisabled({ name: "n", saving: false, mode: "interval", cron: "" })).toBe(false);
  });
  it("disabled for cron mode with an invalid expression", () => {
    expect(isUpdateRunDisabled({ name: "n", saving: false, mode: "cron", cron: "not a cron" })).toBe(true);
  });
  it("enabled for cron mode with a valid expression", () => {
    expect(isUpdateRunDisabled({ name: "n", saving: false, mode: "cron", cron: "0 9 * * 1-5" })).toBe(false);
  });
});

describe("isCreateRunDisabled", () => {
  it("disabled without a projectId", () => {
    expect(isCreateRunDisabled({ name: "n", prompt: "p", saving: false, projectId: null, mode: "interval", cron: "" })).toBe(true);
  });
  it("disabled when prompt is blank", () => {
    expect(isCreateRunDisabled({ name: "n", prompt: "  ", saving: false, projectId: "p1", mode: "interval", cron: "" })).toBe(true);
  });
  it("enabled for a complete interval run", () => {
    expect(isCreateRunDisabled({ name: "n", prompt: "p", saving: false, projectId: "p1", mode: "interval", cron: "" })).toBe(false);
  });
  it("disabled for cron mode with a blank expression", () => {
    expect(isCreateRunDisabled({ name: "n", prompt: "p", saving: false, projectId: "p1", mode: "cron", cron: "  " })).toBe(true);
  });
});

describe("cronFieldHint", () => {
  it("hidden when the field is empty", () => {
    expect(cronFieldHint("   ")).toEqual({ show: false, valid: false, message: "" });
  });
  it("describes a valid expression", () => {
    const hint = cronFieldHint("0 9 * * 1-5");
    expect(hint.show).toBe(true);
    expect(hint.valid).toBe(true);
    expect(hint.message.length).toBeGreaterThan(0);
  });
  it("surfaces the error for an invalid expression", () => {
    const hint = cronFieldHint("nonsense");
    expect(hint.show).toBe(true);
    expect(hint.valid).toBe(false);
  });
});

describe("deriveLastRunDisplay", () => {
  it("defaults a missing status to unknown with the failure icon", () => {
    expect(deriveLastRunDisplay(null)).toEqual({ status: "unknown", icon: "✗", colorClass: "text-red-600" });
  });
  it("running shows the live dot in blue", () => {
    expect(deriveLastRunDisplay("running")).toEqual({ status: "running", icon: "●", colorClass: "text-blue-500" });
  });
  it("success and completed both render the green check", () => {
    expect(deriveLastRunDisplay("success")).toEqual({ status: "success", icon: "✓", colorClass: "text-green-600" });
    expect(deriveLastRunDisplay("completed")).toEqual({ status: "completed", icon: "✓", colorClass: "text-green-600" });
  });
  it("error and failed render the red cross", () => {
    expect(deriveLastRunDisplay("error").icon).toBe("✗");
    expect(deriveLastRunDisplay("failed").colorClass).toBe("text-red-600");
  });
});
