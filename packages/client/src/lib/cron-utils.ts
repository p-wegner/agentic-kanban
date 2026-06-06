export function validateCronExpression(expr: string): { valid: boolean; error?: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: "Must have exactly 5 fields: minute hour day month weekday" };
  }
  const ranges = [{ name: "minute", min: 0, max: 59 }, { name: "hour", min: 0, max: 23 }, { name: "day", min: 1, max: 31 }, { name: "month", min: 1, max: 12 }, { name: "weekday", min: 0, max: 6 }];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    try {
      const vals: number[] = [];
      for (const part of field.split(",")) {
        if (part === "*") { for (let v = ranges[i].min; v <= ranges[i].max; v++) vals.push(v); }
        else if (part.startsWith("*/")) { const s = parseInt(part.slice(2), 10); for (let v = ranges[i].min; v <= ranges[i].max; v += s) vals.push(v); }
        else if (part.includes("-")) { const [lo, hi] = part.split("-").map(Number); for (let v = lo; v <= hi; v++) vals.push(v); }
        else { vals.push(parseInt(part, 10)); }
      }
      const bad = vals.filter(v => isNaN(v) || v < ranges[i].min || v > ranges[i].max);
      if (bad.length) return { valid: false, error: `${ranges[i].name} value ${bad[0]} out of range` };
    } catch {
      return { valid: false, error: `Invalid ${ranges[i].name} field: ${field}` };
    }
  }
  return { valid: true };
}

export function describeCronExpression(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mF, hF, domF, monF, dowF] = parts;
  const pad = (n: string) => n.padStart(2, "0");
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (mF === "*" && hF === "*" && domF === "*" && monF === "*" && dowF === "*") return "Every minute";
  if (mF.startsWith("*/") && hF === "*" && domF === "*" && monF === "*" && dowF === "*") return `Every ${mF.slice(2)} minutes`;
  if (hF === "*" && domF === "*" && monF === "*" && dowF === "*") return `Every hour at minute ${mF}`;
  const simpleTime = /^\d+$/.test(mF) && /^\d+$/.test(hF);
  const timeStr = simpleTime ? `${pad(hF)}:${pad(mF)}` : null;
  if (domF === "*" && monF === "*" && simpleTime) {
    if (dowF === "*") return `Daily at ${timeStr}`;
    if (dowF === "1-5") return `Weekdays at ${timeStr}`;
    if (dowF === "6,0" || dowF === "0,6") return `Weekends at ${timeStr}`;
    if (/^\d$/.test(dowF)) return `Every ${DOW[parseInt(dowF)]} at ${timeStr}`;
    if (/^\d(,\d)+$/.test(dowF)) return `${dowF.split(",").map(d => DOW[parseInt(d)]).join(", ")} at ${timeStr}`;
  }
  if (domF !== "*" && monF === "*" && dowF === "*" && simpleTime && /^\d+$/.test(domF)) return `Monthly on day ${domF} at ${timeStr}`;
  return expr;
}
