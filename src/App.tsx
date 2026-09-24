/**
 * ETL Studio: узлы → SQL → результат, целиком в браузере.
 *
 * Три подсистемы, у каждой свой модуль:
 *   collab.ts — общий документ Yjs (узлы, связи, SQL) и presence
 *   engine.ts — выполнение конвейера в DuckDB-WASM
 *   git.ts    — версии в GitHub (каждое сохранение — коммит)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  createSession,
  makeEdge,
  makeNode,
  peers as peersOf,
  roomFromUrl,
  type CollabSession,
  type Peer,
  type YNode,
} from "./collab";
import { runWorkflow, upstreamTables } from "./engine";
import { PreviewNode, SourceNode, SqlNode, type FlowNodeData } from "./components/FlowNodes";
import { Cursors } from "./components/Cursors";
import { GitPanel } from "./components/GitPanel";
import {
  NODE_LABELS,
  safeTableName,
  uid,
  type NodeKind,
  type NodeResult,
  type WfEdge,
  type WfNode,
  type WorkflowFile,
} from "./types";

const nodeTypes = { source: SourceNode, sql: SqlNode, preview: PreviewNode };
const LOCAL = "local";

function textOf(node: YNode, key: string): string {
  const value = node.get(key);
  return value === undefined || value === null ? "" : String(value);
}

/** Snapshot the shared doc as the plain workflow object that both the engine and git use. */
function collect(session: CollabSession): WorkflowFile {
  const nodes: WfNode[] = [];
  session.nodes.forEach((ynode) => {
    const kind = String(ynode.get("type") || "sql") as NodeKind;
    nodes.push({
      id: String(ynode.get("id")),
      type: kind,
      position: { x: Number(ynode.get("x") || 0), y: Number(ynode.get("y") || 0) },
      data: {
        title: String(ynode.get("title") || ""),
        tableName: String(ynode.get("tableName") || ""),
        csvText: kind === "source" ? textOf(ynode, "csvText") : undefined,
        sql: kind === "sql" ? textOf(ynode, "sql") : undefined,
      },
    });
  });
  const edges: WfEdge[] = [];
  session.edges.forEach((yedge) => {
    edges.push({
      id: String(yedge.get("id")),
      source: String(yedge.get("source")),
      target: String(yedge.get("target")),
    });
  });
  edges.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { version: 1, name: session.room, nodes, edges };
}

function Studio() {
  const sessionRef = useRef<CollabSession | null>(null);
  const resultsRef = useRef<Record<string, NodeResult>>({});
  const lastCursorRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [running, setRunning] = useState(false);
  const [peerList, setPeerList] = useState<Peer[]>([]);
  const [gitOpen, setGitOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [connected, setConnected] = useState(false);

  const { screenToFlowPosition } = useReactFlow();

  /** Rebuild the rendered graph from the doc, merged with this client's own (local) results. */
  const rebuild = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const wf = collect(session);
    setNodes(
      wf.nodes
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((node) => ({
          id: node.id,
          type: node.type,
          position: node.position,
          data: {
            title: node.data.title,
            tableName: node.data.tableName,
            ynode: session.nodes.get(node.id) as YNode,
            result: resultsRef.current[node.id],
            upstream: upstreamTables(node.id, wf.nodes, wf.edges),
          } as FlowNodeData as unknown as Record<string, unknown>,
        })),
    );
    setEdges(wf.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })));
  }, []);

  // One session per page load: the Yjs doc is the source of truth, React state only renders it.
  useEffect(() => {
    const session = createSession(roomFromUrl());
    sessionRef.current = session;
    // Debug seam: `window.__etl` exposes the live session for console checks and automated tests
    // (peers, awareness, doc contents). Read-only in spirit — nothing in the app reads it back.
    (window as unknown as { __etl?: CollabSession }).__etl = session;

    const onStruct = (_event: unknown, transaction: { origin: unknown }) => {
      if (transaction.origin === LOCAL) return; // our own write, already applied locally
      rebuild();
    };
    session.nodes.observeDeep(onStruct);
    session.edges.observeDeep(onStruct);

    const onPresence = () => {
      setPeerList(peersOf(session.provider));
      setConnected(session.provider.connected);
    };
    session.provider.awareness.on("change", onPresence);
    const timer = window.setInterval(onPresence, 1500);

    rebuild();
    setReady(true);

    return () => {
      window.clearInterval(timer);
      session.provider.awareness.off("change", onPresence);
      session.provider.destroy();
      session.doc.destroy();
    };
  }, [rebuild]);

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 4000);
  };

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const session = sessionRef.current;
    if (session) {
      session.doc.transact(() => {
        for (const change of changes) {
          if (change.type === "position" && change.position) {
            const ynode = session.nodes.get(change.id);
            ynode?.set("x", change.position.x);
            ynode?.set("y", change.position.y);
          } else if (change.type === "remove") {
            session.nodes.delete(change.id);
            for (const [key, edge] of session.edges) {
              if (edge.get("source") === change.id || edge.get("target") === change.id) {
                session.edges.delete(key);
              }
            }
          }
        }
      }, LOCAL);
    }
    setNodes((prev) => applyNodeChanges(changes, prev));
    setEdges((prev) =>
      prev.filter((edge) => !changes.some((c) => c.type === "remove" && c.id === edge.source)),
    );
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const session = sessionRef.current;
    if (session) {
      session.doc.transact(() => {
        for (const change of changes) {
          if (change.type === "remove") session.edges.delete(change.id);
        }
      }, LOCAL);
    }
    setEdges((prev) => applyEdgeChanges(changes, prev));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const session = sessionRef.current;
    if (!session || !connection.source || !connection.target) return;
    const edge = makeEdge(connection.source, connection.target);
    session.doc.transact(() => session.edges.set(String(edge.get("id")), edge), LOCAL);
    setEdges((prev) => addEdge({ ...connection, id: String(edge.get("id")) }, prev));
  }, []);

  const addNode = (kind: NodeKind) => {
    const session = sessionRef.current;
    if (!session) return;
    const id = uid(kind);
    const position = screenToFlowPosition({
      x: window.innerWidth / 2 - 120 + Math.random() * 90,
      y: 180 + Math.random() * 90,
    });
    const ynode = makeNode({
      id,
      type: kind,
      position,
      title: NODE_LABELS[kind],
      tableName: safeTableName(`${kind}_${id.slice(-3)}`, `t_${id.slice(-3)}`),
      sql: kind === "sql" ? "SELECT *\nFROM sales" : undefined,
    });
    session.doc.transact(() => session.nodes.set(id, ynode), LOCAL);
    rebuild();
  };

  const run = async () => {
    const session = sessionRef.current;
    if (!session) return;
    setRunning(true);
    setShowLog(true);
    setLog([]);
    const wf = collect(session);
    try {
      await runWorkflow(
        wf.nodes,
        wf.edges,
        (nodeId, result) => {
          resultsRef.current = { ...resultsRef.current, [nodeId]: result };
          rebuild();
        },
        (line) => setLog((prev) => [...prev, line]),
      );
      const failed = Object.values(resultsRef.current).filter((r) => r.status === "error").length;
      flash(failed ? `Готово, но с ошибками: узлов с ошибкой ${failed}` : "Конвейер выполнен");
    } catch (error) {
      setLog((prev) => [...prev, `✗ ${error instanceof Error ? error.message : String(error)}`]);
    } finally {
      setRunning(false);
    }
  };

  const serialize = () => JSON.stringify(collect(sessionRef.current!), null, 2);

  const applyWorkflow = (json: string, source: string) => {
    const session = sessionRef.current;
    if (!session) return;
    let parsed: WorkflowFile;
    try {
      parsed = JSON.parse(json) as WorkflowFile;
    } catch (error) {
      flash(`Не разобрать файл: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!Array.isArray(parsed.nodes)) {
      flash("В файле нет узлов — это не рабочий процесс");
      return;
    }
    session.doc.transact(() => {
      for (const key of [...session.nodes.keys()]) session.nodes.delete(key);
      for (const key of [...session.edges.keys()]) session.edges.delete(key);
      for (const node of parsed.nodes) {
        session.nodes.set(
          node.id,
          makeNode({
            id: node.id,
            type: node.type,
            position: node.position || { x: 0, y: 0 },
            title: node.data?.title || node.id,
            tableName: node.data?.tableName || safeTableName(node.id, `t_${node.id}`),
            csvText: node.data?.csvText,
            sql: node.data?.sql,
          }),
        );
      }
      for (const edge of parsed.edges || []) {
        const yedge = makeEdge(edge.source, edge.target);
        yedge.set("id", edge.id);
        session.edges.set(edge.id, yedge);
      }
    }, LOCAL);
    resultsRef.current = {};
    rebuild();
    flash(source);
  };

  const share = async () => {
    const session = sessionRef.current;
    if (!session) return;
    const url = `${window.location.origin}${window.location.pathname}#room=${session.room}`;
    try {
      await navigator.clipboard.writeText(url);
      flash("Ссылка скопирована — откройте её на втором устройстве");
    } catch {
      flash(url);
    }
  };

  const others = useMemo(
    () => peerList.filter((p) => p.clientId !== sessionRef.current?.doc.clientID),
    [peerList],
  );

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar__brand">
          <strong>ETL Studio</strong>
          <span className="muted">
            комната <code>{sessionRef.current?.room || "…"}</code>
          </span>
        </div>

        <div className="toolbar__group">
          {(Object.keys(NODE_LABELS) as NodeKind[]).map((kind) => (
            <button key={kind} className="btn" onClick={() => addNode(kind)}>
              + {NODE_LABELS[kind]}
            </button>
          ))}
          <button className="btn btn--primary" onClick={run} disabled={running}>
            {running ? "Выполняется…" : "Выполнить"}
          </button>
          <button className="btn btn--ghost" onClick={() => setShowLog((v) => !v)}>
            Журнал
          </button>
        </div>

        <div className="toolbar__right">
          <div className="peers" title="участники комнаты">
            <span className="peers__self" style={{ background: sessionRef.current?.self.color }}>
              {sessionRef.current?.self.name}
            </span>
            {others.map((peer) => (
              <span key={peer.clientId} className="peers__peer" style={{ background: peer.color }}>
                {peer.name}
              </span>
            ))}
            <span
              className={`dot ${connected ? "dot--on" : "dot--off"}`}
              title={
                connected
                  ? "сигналинг подключён — участники синхронизируются через интернет"
                  : "синхронизация только между вкладками этого браузера (BroadcastChannel)"
              }
            />
          </div>
          <button className="btn btn--ghost" onClick={share}>
            Ссылка для совместной работы
          </button>
          <button className="btn" onClick={() => setGitOpen(true)}>
            Версии (GitHub)
          </button>
        </div>
      </header>

      <main
        className="canvas"
        onMouseMove={(event) => {
          const now = performance.now();
          if (now - lastCursorRef.current < 60) return;
          lastCursorRef.current = now;
          const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
          sessionRef.current?.provider.awareness.setLocalStateField("cursor", point);
        }}
      >
        {!ready && <div className="overlay">Подключение к комнате…</div>}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} size={1} color="#1f2937" />
          <Controls />
          <MiniMap pannable zoomable nodeColor="#334155" maskColor="rgba(9,12,17,0.7)" />
          <Cursors peers={peerList} selfId={sessionRef.current?.doc.clientID ?? -1} />
        </ReactFlow>
      </main>

      {showLog && (
        <footer className="log">
          <div className="log__head">
            <span>Журнал выполнения</span>
            <button className="btn btn--ghost" onClick={() => setLog([])}>
              очистить
            </button>
          </div>
          <pre className="log__body">
            {log.length ? log.join("\n") : "Пока пусто — нажмите «Выполнить»."}
          </pre>
        </footer>
      )}

      {toast && <div className="toast">{toast}</div>}

      <GitPanel open={gitOpen} onClose={() => setGitOpen(false)} serialize={serialize} apply={applyWorkflow} />
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Studio />
    </ReactFlowProvider>
  );
}
