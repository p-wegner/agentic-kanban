// Pure validation for BoardToolbar's card-aging warm/hot day-threshold inputs.
// The component keeps the setState/onChange side effects; this just parses+validates.

export interface AgingThresholdResult {
  valid: boolean;
  value: number;
}

/**
 * Parse a raw threshold input and validate against the sibling threshold:
 * warm must be 1 ≤ v < hotDays; hot must be v > warmDays. NaN is invalid.
 */
export function validateAgingThreshold(
  raw: string,
  opts: { which: "warm" | "hot"; warmDays: number; hotDays: number },
): AgingThresholdResult {
  const value = parseInt(raw, 10);
  const valid = opts.which === "warm"
    ? !isNaN(value) && value >= 1 && value < opts.hotDays
    : !isNaN(value) && value > opts.warmDays;
  return { valid, value };
}
