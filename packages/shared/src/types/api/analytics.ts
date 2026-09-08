// Issue-analytics and time-report wire DTOs (#704). See ../api.ts barrel.

export interface BurndownBucket {
  date: string;
  remaining: number;
  opened: number;
  closed: number;
}

export interface LeadTimeBucket {
  date: string;
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
}

export interface StatusDuration {
  statusName: string;
  durationMs: number;
}

export interface TimeEntry {
  id: string;
  issueId: string;
  minutes: number;
  note: string | null;
  createdAt: string;
}

