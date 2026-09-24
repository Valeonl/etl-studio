/**
 * Execution engine: DuckDB-WASM inside the page, so the transformations are real SQL and the
 * data never leaves the browser (no warehouse, no backend, no cost).
 *
 * Node contract:
 *   source  — publishes its CSV (Y.Text, shared) as a table named after the node
 *   sql     — runs the user's SQL and publishes the result as its own table name; upstream
 *             tables are addressed by the names the user sees on the upstream nodes
 *   preview — a sink: it publishes nothing, it just shows what its input produced
 *
 * The single-threaded (MVP) bundle is deliberate: the threaded build needs SharedArrayBuffer,
 * which needs COOP/COEP response headers that GitHub Pages cannot send.
 */
import * as duckdb from "@duckdb/duckdb-wasm";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import type { NodeResult, WfEdge, WfNode } from "./types";

const PREVIEW_ROWS = 200;

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

export type LogFn = (line: string) => void;

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const worker = new Worker(mvpWorker);
      const logger = new duckdb.VoidLogger();
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(mvpWasm);
      return db;
    })();
  }
  return dbPromise;
}

function topoOrder(nodes: WfNode[], edges: WfEdge[]): WfNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const outgoing = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const queue = nodes.filter((n) => (indegree.get(n.id) || 0) === 0).map((n) => n.id);
  const ordered: WfNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(byId.get(id)!);
    for (const next of outgoing.get(id) || []) {
      const left = (indegree.get(next) || 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  // A cycle would silently drop nodes; report it instead of pretending a partial run succeeded.
  if (ordered.length !== nodes.length) {
    const stuck = nodes.filter((n) => !ordered.includes(n)).map((n) => n.data.title);
    throw new Error(`Цикл в графе — не выполнить: ${stuck.join(", ")}`);
  }
  return ordered;
}

export function upstreamTables(nodeId: string, nodes: WfNode[], edges: WfEdge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges
    .filter((e) => e.target === nodeId)
    .map((e) => byId.get(e.source))
    .filter((n): n is WfNode => Boolean(n) && n!.type !== "preview")
    .map((n) => n.data.tableName);
}

async function tableStats(
  db: duckdb.AsyncDuckDB,
  table: string,
): Promise<{ rows: number; columns: string[] }> {
  const conn = await db.connect();
  try {
    const counted = await conn.query(`SELECT count(*)::BIGINT AS n FROM "${table}"`);
    const rows = Number((counted.toArray()[0] as { n: bigint | number }).n);
    const described = await conn.query(`DESCRIBE "${table}"`);
    const columns = described.toArray().map((r) => String((r as { column_name: string }).column_name));
    return { rows, columns };
  } finally {
    await conn.close();
  }
}

async function preview(
  db: duckdb.AsyncDuckDB,
  table: string,
): Promise<Record<string, unknown>[]> {
  const conn = await db.connect();
  try {
    const result = await conn.query(`SELECT * FROM "${table}" LIMIT ${PREVIEW_ROWS}`);
    return result.toArray().map((row) => normalizeRow(row));
  } finally {
    await conn.close();
  }
}

/** Arrow rows carry BigInt/Date values that React cannot render; make them plain JSON. */
function normalizeRow(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (typeof value === "bigint") out[key] = value.toString();
    else if (value instanceof Date) out[key] = value.toISOString();
    else if (value && typeof value === "object" && "toString" in value && !Array.isArray(value)) {
      out[key] = String(value);
    } else out[key] = value as unknown;
  }
  return out;
}

/**
 * Run every node in dependency order, reporting each node's outcome as it lands.
 * One failing node does not abort the run: its downstream nodes are skipped and marked, so the
 * user sees every place that needs attention instead of fixing errors one reload at a time.
 */
export async function runWorkflow(
  nodes: WfNode[],
  edges: WfEdge[],
  onResult: (nodeId: string, result: NodeResult) => void,
  log: LogFn = () => {},
): Promise<void> {
  const ordered = topoOrder(nodes, edges);
  const db = await getDb();
  const failed = new Set<string>();

  for (const node of ordered) {
    const parents = edges.filter((e) => e.target === node.id).map((e) => e.source);
    const brokenParent = parents.find((p) => failed.has(p));
    if (brokenParent) {
      failed.add(node.id);
      onResult(node.id, { status: "error", error: "Пропущено: входной узел завершился с ошибкой" });
      continue;
    }

    onResult(node.id, { status: "running" });
    const conn = await db.connect();
    const table = node.data.tableName;
    try {
      if (node.type === "sql") {
        const sql = (node.data.sql || "").trim().replace(/;\s*$/, "");
        if (!sql) throw new Error("Пустой SQL");
        log(`▶ ${node.data.title}: ${sql.split("\n")[0].slice(0, 80)}`);
        await conn.query(`CREATE OR REPLACE TABLE "${table}" AS ${sql}`);
      } else if (node.type === "source") {
        const csv = (node.data.csvText || "").trim();
        if (!csv) throw new Error("Нет данных: загрузите CSV или вставьте текст");
        const fileName = `${node.id}.csv`;
        await db.registerFileText(fileName, csv);
        log(`▶ ${node.data.title}: читаем ${csv.split("\n").length - 1} строк CSV`);
        await conn.query(
          `CREATE OR REPLACE TABLE "${table}" AS SELECT * FROM read_csv_auto('${fileName}', header=true, sample_size=-1)`,
        );
      } else {
        // preview: no table of its own, just check that its input exists
        const input = upstreamTables(node.id, nodes, edges)[0];
        if (!input) throw new Error("Подключите входной узел");
        const stats = await tableStats(db, input);
        onResult(node.id, { status: "ok", ...stats, preview: await preview(db, input) });
        log(`✓ ${node.data.title}: ${stats.rows} строк`);
        continue;
      }

      const stats = await tableStats(db, table);
      onResult(node.id, { status: "ok", ...stats, preview: await preview(db, table) });
      log(`✓ ${node.data.title}: ${stats.rows} строк, ${stats.columns.length} колонок`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.add(node.id);
      onResult(node.id, { status: "error", error: message });
      log(`✗ ${node.data.title}: ${message}`);
    } finally {
      await conn.close();
    }
  }
}

/** Export a table back to CSV in the browser (the workbook the user came for). */
export async function exportCsv(
  db: duckdb.AsyncDuckDB,
  table: string,
): Promise<string> {
  const conn = await db.connect();
  try {
    const rows = await conn.query(`SELECT * FROM "${table}"`);
    const data = rows.toArray().map((r) => normalizeRow(r));
    if (!data.length) return "";
    const headers = Object.keys(data[0]);
    const escape = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [
      headers.join(","),
      ...data.map((row) => headers.map((h) => escape(row[h])).join(",")),
    ].join("\n");
  } finally {
    await conn.close();
  }
}
