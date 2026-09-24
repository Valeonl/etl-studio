/**
 * Collaborative document: one Yjs doc per workflow room, synced peer-to-peer.
 *
 * Transport is y-webrtc: public signalling servers, no account and no server to run, which is
 * what keeps this deployable as a static page. Two clients in the same browser also pair over
 * BroadcastChannel, so a second tab is a genuine second peer even when signalling is unreachable.
 *
 * Layout of the doc:
 *   nodes: Y.Map<nodeId, Y.Map>   — one Y.Map per node, so concurrent edits to different nodes
 *                                   never conflict; `sql`/`csvText` are Y.Text for character-level merging.
 *   edges: Y.Map<edgeId, Y.Map>
 *   meta:  Y.Map                  — workflow name
 *
 * Execution results are deliberately NOT in the doc: they are per-client and can be megabytes.
 */
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";

export type YNode = Y.Map<unknown>;

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  cursor?: { x: number; y: number };
}

export interface CollabSession {
  doc: Y.Doc;
  provider: WebrtcProvider;
  nodes: Y.Map<YNode>;
  edges: Y.Map<Y.Map<unknown>>;
  meta: Y.Map<unknown>;
  room: string;
  self: { name: string; color: string };
}

const COLORS = [
  "#ff6b6b", "#4dabf7", "#51cf66", "#ffd43b", "#cc5de8",
  "#ff922b", "#20c997", "#f783ac", "#845ef7", "#94d2bd",
];

export function roomFromUrl(): string {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const room = hash.get("room") || query.get("room") || "etl-default";
  return room.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "etl-default";
}

export function selfIdentity(): { name: string; color: string } {
  // Names are per browser so a reload keeps your presence label stable.
  const key = "etl-studio:identity";
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      return JSON.parse(stored) as { name: string; color: string };
    } catch {
      /* fall through and mint a new identity */
    }
  }
  const n = Math.floor(Math.random() * 90 + 10);
  const identity = {
    name: `Гость ${n}`,
    color: COLORS[n % COLORS.length],
  };
  localStorage.setItem(key, JSON.stringify(identity));
  return identity;
}

/** Drop every node/edge that has no position (a node written by an older/broken client). */
function isValidNode(node: YNode): boolean {
  return typeof node.get("x") === "number" && typeof node.get("y") === "number";
}

export function createSession(room: string): CollabSession {
  const doc = new Y.Doc();
  const nodes = doc.getMap<YNode>("nodes");
  const edges = doc.getMap<Y.Map<unknown>>("edges");
  const meta = doc.getMap<unknown>("meta");
  const self = selfIdentity();

  const provider = new WebrtcProvider(`etl-studio-${room}`, doc, {
    // Public signalling; a room is namespaced by prefix so we never collide with other demos.
    signaling: [
      "wss://signaling.yjs.dev",
      "wss://y-webrtc-eu.fly.dev",
      "wss://signaling.fly.dev",
    ],
    maxConns: 20,
    awareness: undefined,
  });
  provider.awareness.setLocalStateField("user", self);

  // A new room starts with one source node — an empty canvas gives no hint of what to do.
  window.setTimeout(() => {
    if (nodes.size === 0 && edges.size === 0) {
      seedWorkflow(nodes, edges);
    }
  }, 1200);

  for (const [key, node] of nodes) {
    if (!isValidNode(node)) nodes.delete(key);
  }

  return { doc, provider, nodes, edges, meta, room, self };
}

/** A demo workflow lands in a fresh room: source → SQL → preview, connected and runnable. */
function seedWorkflow(nodes: Y.Map<YNode>, edges: Y.Map<Y.Map<unknown>>): void {
  nodes.set(
    "source_seed",
    makeNode({
      id: "source_seed",
      type: "source",
      position: { x: 40, y: 180 },
      title: "Продажи (пример)",
      tableName: "sales",
      csvText:
        "region,product,month,amount\nСевер,Кофе,2026-01,1500\nСевер,Чай,2026-01,900\nЮг,Кофе,2026-01,2100\nЮг,Чай,2026-01,700\nСевер,Кофе,2026-02,1750\nЮг,Кофе,2026-02,2300\nСевер,Чай,2026-02,650\nЮг,Чай,2026-02,880\n",
    }),
  );
  nodes.set(
    "sql_seed",
    makeNode({
      id: "sql_seed",
      type: "sql",
      position: { x: 440, y: 170 },
      title: "Свод по регионам",
      tableName: "by_region",
      sql: "SELECT region,\n       sum(amount) AS total,\n       count(*)    AS orders\nFROM sales\nGROUP BY region\nORDER BY total DESC",
    }),
  );
  nodes.set(
    "preview_seed",
    makeNode({
      id: "preview_seed",
      type: "preview",
      position: { x: 840, y: 200 },
      title: "Результат",
      tableName: "by_region",
    }),
  );
  edges.set("edge_seed_1", makeEdge("source_seed", "sql_seed"));
  edges.set("edge_seed_2", makeEdge("sql_seed", "preview_seed"));
}

export function makeEdge(source: string, target: string, id = `edge_${Math.random().toString(36).slice(2, 8)}`): Y.Map<unknown> {
  const edge = new Y.Map<unknown>();
  edge.set("id", id);
  edge.set("source", source);
  edge.set("target", target);
  return edge;
}

export function makeNode(spec: {
  id: string;
  type: string;
  position: { x: number; y: number };
  title: string;
  tableName: string;
  csvText?: string;
  sql?: string;
}): YNode {
  // Nested types are created detached and integrate into the shared doc with their parent —
  // never build them inside a throwaway doc, a type can only be integrated once.
  const node = new Y.Map<unknown>();
  node.set("id", spec.id);
  node.set("type", spec.type);
  node.set("x", spec.position.x);
  node.set("y", spec.position.y);
  node.set("title", spec.title);
  node.set("tableName", spec.tableName);
  if (spec.type === "sql") {
    const text = new Y.Text();
    text.insert(0, spec.sql || "SELECT *\nFROM sales");
    node.set("sql", text);
  } else {
    const text = new Y.Text();
    text.insert(0, spec.csvText || "");
    node.set("csvText", text);
  }
  return node;
}

export function peers(provider: WebrtcProvider): Peer[] {
  const out: Peer[] = [];
  provider.awareness.getStates().forEach((state, clientId) => {
    const user = (state as { user?: { name: string; color: string } }).user;
    if (!user) return;
    out.push({
      clientId,
      name: user.name,
      color: user.color,
      cursor: (state as { cursor?: { x: number; y: number } }).cursor,
    });
  });
  return out;
}
