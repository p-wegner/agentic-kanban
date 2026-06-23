import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "../../schema/index.js";

export type WorkflowDb = LibSQLDatabase<typeof schema>;

export interface WorkflowNodeRow {
  id: string;
  templateId: string;
  name: string;
  nodeType: string;
  statusName: string | null;
  skillId: string | null;
  skillName: string | null;
  maxVisits: number;
  config: string | null;
  sortOrder: number;
}

export interface TransitionTarget {
  edgeId: string;
  toNodeId: string;
  toNodeName: string;
  toStatusName: string | null;
  label: string | null;
  condition: string;
}
