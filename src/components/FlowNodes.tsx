/** The three node types a user can place: CSV source, SQL transform, preview/export. */
import { useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import type * as Y from "yjs";
import { NodeShell } from "./NodeShell";
import { useYText } from "../hooks/useYText";
import { getDb, exportCsv } from "../engine";
import type { NodeResult } from "../types";

export interface FlowNodeData extends Record<string, unknown> {
  title: string;
  tableName: string;
  ynode: Y.Map<unknown>;
  result?: NodeResult;
  upstream: string[];
  onDelete?: (nodeId: string) => void;
}

export function SourceNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const ytext = d.ynode.get("csvText") as Y.Text | undefined;
  const [csv, setCsv] = useYText(ytext, "local");
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = csv ? csv.trim().split("\n").length - 1 : 0;

  return (
    <NodeShell
      id={id}
      ynode={d.ynode}
      kind="source"
      title={d.title}
      tableName={d.tableName}
      result={d.result}
      selected={selected}
      hasInput={false}
      hasOutput
      onDelete={() => d.onDelete?.(id)}
      footer={
        <div className="node__actions">
          <button className="btn btn--ghost" onClick={() => fileInput.current?.click()}>
            Загрузить CSV
          </button>
          <span className="muted">{rows > 0 ? `${rows} строк в файле` : "вставьте текст"}</span>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,text/plain"
            style={{ display: "none" }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const text = await file.text();
              setCsv(text);
              event.target.value = "";
            }}
          />
        </div>
      }
    >
      <textarea
        className="node__text"
        spellCheck={false}
        placeholder="region,amount&#10;Север,1500"
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
    </NodeShell>
  );
}

export function SqlNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const ytext = d.ynode.get("sql") as Y.Text | undefined;
  const [sql, setSql] = useYText(ytext, "local");

  return (
    <NodeShell
      id={id}
      ynode={d.ynode}
      kind="sql"
      title={d.title}
      tableName={d.tableName}
      result={d.result}
      selected={selected}
      hasInput
      hasOutput
      onDelete={() => d.onDelete?.(id)}
      footer={
        <div className="node__actions">
          <span className="muted">
            {d.upstream.length ? `вход: ${d.upstream.join(", ")}` : "нет входа — подключите узел"}
          </span>
        </div>
      }
    >
      <textarea
        className="node__text node__text--sql"
        spellCheck={false}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
      />
    </NodeShell>
  );
}

export function PreviewNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const result = d.result;
  const columns = result?.columns || [];
  const rows = (result?.preview || []).slice(0, 50);

  return (
    <NodeShell
      id={id}
      ynode={d.ynode}
      kind="preview"
      title={d.title}
      tableName={d.tableName}
      result={result}
      selected={selected}
      hasInput
      hasOutput={false}
      onDelete={() => d.onDelete?.(id)}
      footer={
        <div className="node__actions">
          <button
            className="btn btn--ghost"
            disabled={!d.upstream.length || result?.status !== "ok"}
            onClick={async () => {
              const db = await getDb();
              const csv = await exportCsv(db, d.upstream[0]);
              const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
              const link = document.createElement("a");
              link.href = URL.createObjectURL(blob);
              link.download = `${d.upstream[0] || "result"}.csv`;
              link.click();
              URL.revokeObjectURL(link.href);
            }}
          >
            Скачать CSV
          </button>
          {result?.status === "ok" && (
            <span className="muted">
              показано {rows.length} из {result.rows ?? 0}
            </span>
          )}
        </div>
      }
    >
      {!result || result.status !== "ok" ? (
        <div className="node__placeholder">
          {result?.status === "error" ? result.error : "нажмите «Выполнить», чтобы увидеть данные"}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c}>{String(row[c] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </NodeShell>
  );
}
