import { describe, expect, it } from "vitest";
import { describeCronExpression, validateCronExpression } from "./cron-utils.js";

describe("cron-utils", () => {
  describe("validateCronExpression", () => {
    it("accepts valid five-field cron expressions", () => {
      expect(validateCronExpression("0 9 * * 1-5")).toEqual({ valid: true });
      expect(validateCronExpression("*/15 * * * *")).toEqual({ valid: true });
    });

    it("rejects expressions with the wrong field count", () => {
      expect(validateCronExpression("0 9 * *")).toEqual({
        valid: false,
        error: "Must have exactly 5 fields: minute hour day month weekday",
      });
    });

    it("rejects out-of-range field values", () => {
      expect(validateCronExpression("60 9 * * *")).toEqual({
        valid: false,
        error: "minute value 60 out of range",
      });
    });
  });

  describe("describeCronExpression", () => {
    it("describes the cron expressions shown in the schedule UI", () => {
      expect(describeCronExpression("* * * * *")).toBe("Every minute");
      expect(describeCronExpression("*/15 * * * *")).toBe("Every 15 minutes");
      expect(describeCronExpression("0 9 * * 1-5")).toBe("Weekdays at 09:00");
      expect(describeCronExpression("30 8 1 * *")).toBe("Monthly on day 1 at 08:30");
    });

    it("returns unrecognized expressions unchanged", () => {
      expect(describeCronExpression("0 */2 * * *")).toBe("0 */2 * * *");
    });
  });
});
