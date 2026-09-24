/** Shared shapes for the workflow document. */

export type NodeKind = "source" | "sql" | "preview";

/** Result of executing one node — local to the browser, never synced (it can be large). */
export interface NodeResult {
  status: "idle" | "running" | "ok" | "error";
  error?: string;
  rows?: number;
  columns?: string[];
  preview?: Record<string, unknown>[];
}

export interface WfNode {
  id: string;
  type: NodeKind;
  position: { x: number; y: number };
  data: {
    title: string;
    /** Table name the node publishes into DuckDB; downstream SQL addresses it by this name. */
    tableName: string;
    csvText?: string;
    sql?: string;
    result?: NodeResult;
  };
}

export interface WfEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowFile {
  version: 1;
  name: string;
  nodes: WfNode[];
  edges: WfEdge[];
}

export const NODE_LABELS: Record<NodeKind, string> = {
  source: "Источник CSV",
  sql: "SQL-трансформация",
  preview: "Просмотр / экспорт",
};

export const uid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

/** Table name that is legal in SQL and readable in the UI. */
export function safeTableName(raw: string, fallback: string): string {
  const cleaned = (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(cleaned) ? cleaned : fallback;
}
