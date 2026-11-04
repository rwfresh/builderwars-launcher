import { useEffect, useRef } from "react";
import { debugLog, paneBounds, type ChildPane } from "./ipc";

/**
 * Placeholder that a native child webview is laid over. Child webviews draw above the shell UI,
 * so nothing of ours may render inside this rectangle. Bounds are pushed on every size/position
 * change (divider drags, window resizes, collapse).
 */
export function ChildPanePlaceholder({ pane, visible, label }: { pane: ChildPane; visible: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    const push = () => {
      clearTimeout(timer);
      // setTimeout, not requestAnimationFrame: rAF stops firing when WebKit thinks the view is hidden.
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
        const key = `${visible}:${rect.x},${rect.y},${rect.width},${rect.height}:${window.innerWidth}x${window.innerHeight}`;
        if (key === last) return;
        last = key;
        if (import.meta.env.DEV) void debugLog(`bounds ${pane} ${key} inner=${window.innerWidth}x${window.innerHeight}`);
        paneBounds(pane, rect, visible).catch((e: unknown) => console.error("pane_bounds", pane, e));
      }, 0);
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    // Position can change without a size change (left column resized): observe the parent too.
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener("resize", push);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener("resize", push);
    };
  }, [pane, visible]);

  useEffect(() => {
    // Hide when unmounted.
    return () => {
      paneBounds(pane, { x: 0, y: 0, width: 0, height: 0 }, false).catch(() => {});
    };
  }, [pane]);

  return (
    <div className="child-slot" ref={ref}>
      <div className="child-slot-hint">loading {label}…</div>
    </div>
  );
}
