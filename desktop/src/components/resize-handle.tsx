"use client";

import { useEffect, useRef } from "react";

// Pointer cleanup and bounds follow Noteriv's Sidebar resize interaction.
export function ResizeHandle({ label, value, min, max, onChange, reverse = false, scale, step = 10, reset, hidden = false }: {
  label: string; value: number; min: number; max: number; onChange: (value: number) => void;
  reverse?: boolean; scale?: () => number; step?: number; reset: number; hidden?: boolean;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  useEffect(() => () => cleanup.current?.(), []);
  const change = (next: number) => onChangeRef.current(Math.max(min, Math.min(max, next)));
  return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value * 100) / 100} tabIndex={hidden ? -1 : 0} className="pane-resizer" style={hidden ? { display: "none" } : undefined} title={`${label}：拖动调整，方向键微调，双击还原`} onDoubleClick={() => change(reset)} onKeyDown={(event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); change(event.key === "Home" ? min : event.key === "End" ? max : value + (event.key === "ArrowRight" ? 1 : -1) * (reverse ? -1 : 1) * step);
  }} onPointerDown={(event) => {
    if (event.button !== 0) return;
    event.preventDefault(); cleanup.current?.();
    const start = event.clientX, factor = (reverse ? -1 : 1) / Math.max(1, scale?.() ?? 1);
    const previousCursor = document.body.style.cursor, previousSelect = document.body.style.userSelect;
    const move = (event: PointerEvent) => change(value + (event.clientX - start) * factor);
    const finish = () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", finish); document.removeEventListener("pointercancel", finish); window.removeEventListener("blur", finish);
      document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelect; cleanup.current = null;
    };
    cleanup.current = finish; document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", finish); document.addEventListener("pointercancel", finish); window.addEventListener("blur", finish);
  }} />;
}
