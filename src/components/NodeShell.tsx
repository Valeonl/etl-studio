/** Shared chrome for every node: title, table name, run status, sockets. */
import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import type * as Y from "yjs";
import type { NodeResult } from "../types";

export interface NodeShellProps {
  id: string;
  ynode: Y.Map<unknown>;
  kind: "source" | "sql" | "preview";
  title: string;
  tableName: string;
  result?: NodeResult;
  selected?: boolean;
  hasInput: boolean;
  hasOutput: boolean;
  children: ReactNode;
  footer?: ReactNode;
}

const KIND_LABEL: Record<NodeShellProps["kind"], string> = {
  source: "источник",
  sql: "SQL",
  preview: "вывод",
};

function StatusDot({ result }: { result?: NodeResult }) {
  const status = result?.status ?? "idle";
  return <span className={`status status--${status}`} title={result?.error || status} />;
}

export function NodeShell(props: NodeShellProps) {
  const { ynode, kind, title, tableName, result, selected, children, footer } = props;

  const edit = (key: string, value: string) => {
    const apply = () => ynode.set(key, value);
    if (ynode.doc) ynode.doc.transact(apply, "local");
    else apply();
  };

  return (
    <div className={`node node--${kind}${selected ? " node--selected" : ""}`}>
      {props.hasInput && <Handle type="target" position={Position.Left} />}
      <header className="node__head">
        <StatusDot result={result} />
        <input
          className="node__title"
          value={title}
          spellCheck={false}
          onChange={(e) => edit("title", e.target.value)}
        />
        <span className="node__kind">{KIND_LABEL[kind]}</span>
      </header>

      <div className="node__body">{children}</div>

      {kind !== "preview" && (
        <label className="node__table">
          <span>таблица</span>
          <input
            value={tableName}
            spellCheck={false}
            onChange={(e) => edit("tableName", e.target.value)}
          />
        </label>
      )}

      {(result?.status === "ok" || result?.status === "error") && (
        <div className={`node__result node__result--${result.status}`}>
          {result.status === "ok"
            ? `${result.rows ?? 0} строк · ${(result.columns || []).length} колонок`
            : result.error}
        </div>
      )}

      {footer}

      {props.hasOutput && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
