// Sprint-capacity wire DTOs (#704). See ../api.ts barrel.

export interface SprintCapacityPlan {
  policy: SprintCapacityPolicy;
  nextEligibleIssues: SprintEligibleIssue[];
}

export interface SprintCapacityPolicy {
  activeAgentsTarget: number;
  currentActive: number;
  availableSlots: number;
  maxNewStartsPerCycle: number;
  backlogFloor: number;
  currentBacklogSize: number;
  willStartCount: number;
}

export interface SprintEligibleIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  priority: string | null;
  statusName: string;
  blockers: string[];
  canStart: boolean;
}
