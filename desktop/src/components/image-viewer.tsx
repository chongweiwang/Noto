"use client";

import { useEffect, useRef, useState } from "react";

// Noteriv ImageViewer's fit/actual-size interaction, using the already loaded local image.
export function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const [actual, setActual] = useState(false), panel = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; panel.current?.querySelector<HTMLElement>("button")?.focus(); return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  return <div className="modal-backdrop image-viewer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="image-viewer" ref={panel} role="dialog" aria-modal="true" aria-label="图片查看" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === "Tab") {
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><header><strong>{name || "图片"}</strong><button type="button" aria-pressed={actual} onClick={() => setActual(!actual)}>{actual ? "适应窗口" : "原始大小"}</button><button type="button" aria-label="关闭图片" onClick={onClose}>×</button></header><div className={`image-viewer-content ${actual ? "actual-size" : "fit-size"}`}><button type="button" aria-label="切换图片显示比例" onClick={() => setActual(!actual)}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={src} alt={name || "知识库图片"} draggable={false} /></button></div></div></div>;
}
