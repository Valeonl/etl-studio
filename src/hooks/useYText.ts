/**
 * Bind a React input to a shared Y.Text without losing concurrent edits.
 *
 * A naive "on change, replace the whole string" destroys whatever a peer typed between keystrokes,
 * because Yjs would apply delete-everything + insert-everything. This computes the minimal
 * single-range delta (common prefix/suffix) and applies only that, which is what makes two people
 * typing in the same SQL box merge instead of clobber.
 */
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

export function useYText(text: Y.Text | undefined, origin: string): [string, (next: string) => void] {
  const [value, setValue] = useState(text ? text.toString() : "");
  const applyingRemote = useRef(false);

  useEffect(() => {
    if (!text) return;
    const sync = () => {
      applyingRemote.current = true;
      setValue(text.toString());
      applyingRemote.current = false;
    };
    sync();
    text.observe(sync);
    return () => text.unobserve(sync);
  }, [text]);

  const onChange = (next: string) => {
    setValue(next);
    if (!text) return;
    const prev = text.toString();
    if (prev === next) return;

    let start = 0;
    while (start < prev.length && start < next.length && prev[start] === next[start]) start += 1;
    let endPrev = prev.length;
    let endNext = next.length;
    while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
      endPrev -= 1;
      endNext -= 1;
    }

    const apply = () => {
      if (endPrev > start) text.delete(start, endPrev - start);
      const inserted = next.slice(start, endNext);
      if (inserted) text.insert(start, inserted);
    };
    if (text.doc) text.doc.transact(apply, origin);
    else apply();
  };

  return [value, onChange];
}
