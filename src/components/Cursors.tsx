/**
 * Remote pointers, drawn inside the canvas viewport so they pan and zoom with the workflow.
 *
 * Awareness carries *flow* coordinates (screen coordinates would drift the moment anybody pans),
 * and ViewportPortal renders this layer under the same transform as the nodes.
 */
import { ViewportPortal } from "@xyflow/react";
import type { Peer } from "../collab";

export function Cursors({ peers, selfId }: { peers: Peer[]; selfId: number }) {
  return (
    <ViewportPortal>
      {peers
        .filter((p) => p.clientId !== selfId && p.cursor)
        .map((peer) => (
          <div
            key={peer.clientId}
            className="cursor"
            style={{
              transform: `translate(${peer.cursor!.x}px, ${peer.cursor!.y}px)`,
              color: peer.color,
            }}
          >
            <svg width="18" height="22" viewBox="0 0 18 22" fill="none">
              <path
                d="M1 1 L1 17 L5.2 13.2 L8 20 L10.7 18.8 L7.9 12.4 L13.4 12.2 Z"
                fill="currentColor"
                stroke="#0b0f14"
                strokeWidth="1.2"
              />
            </svg>
            <span className="cursor__label" style={{ background: peer.color }}>
              {peer.name}
            </span>
          </div>
        ))}
    </ViewportPortal>
  );
}
