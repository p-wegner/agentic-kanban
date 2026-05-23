/**
 * Cron expression utilities — no external dependencies.
 * Supports standard 5-field cron: minute hour dom month dow
 * Fields: * | n | n-m | n/step | */step | comma-separated combinations
 */

function parseCronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step < 1) throw new Error(`Invalid step: ${part}`);
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (part.includes("-")) {
      const slashIdx = part.indexOf("/");
      const rangePart = slashIdx >= 0 ? part.slice(0, slashIdx) : part;
      const step = slashIdx >= 0 ? parseInt(part.slice(slashIdx + 1), 10) : 1;
      const [lo, hi] = rangePart.split("-").map(Number);
      if (isNaN(lo) || isNaN(hi) || isNaN(step) || step < 1) throw new Error(`Invalid range: ${part}`);
      for (let i = lo; i <= hi; i += step) values.add(i);
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n)) throw new Error(`Invalid value: ${part}`);
      values.add(n);
    }
  }
  return [...values].sort((a, b) => a - b);
}

export function validateCronExpression(expr: string): { valid: boolean; error?: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: "Cron expression must have exactly 5 fields (minute hour day month weekday)" };
  }

  const ranges = [
    { name: "minute", min: 0, max: 59 },
    { name: "hour", min: 0, max: 23 },
    { name: "day-of-month", min: 1, max: 31 },
    { name: "month", min: 1, max: 12 },
    { name: "weekday", min: 0, max: 6 },
  ];

  for (let i = 0; i < 5; i++) {
    try {
      const vals = parseCronField(parts[i], ranges[i].min, ranges[i].max);
      const outOfRange = vals.filter(v => v < ranges[i].min || v > ranges[i].max);
      if (outOfRange.length > 0) {
        return { valid: false, error: `${ranges[i].name} value ${outOfRange[0]} out of range ${ranges[i].min}-${ranges[i].max}` };
      }
    } catch (err) {
      return { valid: false, error: `Invalid ${ranges[i].name} field: ${parts[i]}` };
    }
  }
  return { valid: true };
}

/**
 * Calculate next run time for a cron expression after `from`.
 * Returns null if no match found within 2 years.
 */
export function getNextCronRun(expr: string, from: Date): Date | null {
  const parts = expr.trim().split(/\s+/);
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows = parseCronField(parts[4], 0, 6);

  // Start from next minute
  const start = new Date(from.getTime() + 60 * 1000);
  start.setSeconds(0, 0);

  for (let i = 0; i < 525600; i++) {
    const d = new Date(start.getTime() + i * 60_000);
    if (
      months.includes(d.getMonth() + 1) &&
      doms.includes(d.getDate()) &&
      dows.includes(d.getDay()) &&
      hours.includes(d.getHours()) &&
      minutes.includes(d.getMinutes())
    ) {
      return d;
    }
  }
  return null;
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function describeCronExpression(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mF, hF, domF, monF, dowF] = parts;

  const pad = (n: string | number) => String(n).padStart(2, "0");

  // Every minute
  if (mF === "*" && hF === "*" && domF === "*" && monF === "*" && dowF === "*") {
    return "Every minute";
  }
  // Every N minutes
  if (mF.startsWith("*/") && hF === "*" && domF === "*" && monF === "*" && dowF === "*") {
    return `Every ${mF.slice(2)} minutes`;
  }
  // Every hour (at minute 0 or N)
  if (hF === "*" && domF === "*" && monF === "*" && dowF === "*") {
    const m = mF === "0" ? "" : ` at minute ${mF}`;
    return `Every hour${m}`;
  }
  // Simple hour+minute on specific dow
  const simpleTime = /^\d+$/.test(mF) && /^\d+$/.test(hF);
  const timeStr = simpleTime ? `${pad(hF)}:${pad(mF)}` : null;

  if (domF === "*" && monF === "*" && simpleTime) {
    if (dowF === "*") {
      return `Daily at ${timeStr}`;
    }
    if (dowF === "1-5") {
      return `Weekdays at ${timeStr}`;
    }
    if (dowF === "6,0" || dowF === "0,6") {
      return `Weekends at ${timeStr}`;
    }
    if (/^\d$/.test(dowF)) {
      return `Every ${DOW_NAMES[parseInt(dowF)]} at ${timeStr}`;
    }
    // multiple days
    if (/^\d(,\d)+$/.test(dowF)) {
      const days = dowF.split(",").map(d => DOW_NAMES[parseInt(d)]).join(", ");
      return `${days} at ${timeStr}`;
    }
  }

  // Monthly on day N at time
  if (domF !== "*" && monF === "*" && dowF === "*" && simpleTime && /^\d+$/.test(domF)) {
    return `Monthly on day ${domF} at ${timeStr}`;
  }

  return expr;
}
