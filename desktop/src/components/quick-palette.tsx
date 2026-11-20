"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteItem = { id: string; label: string; detail?: string; keys?: string; disabled?: boolean };
// Adapted from Noteriv QuickOpen/CommandPalette. File access and actions are supplied by Noto.
export function QuickPalette({ kind, items, onChoose, onClose }: { kind: "files" | "commands"; items: PaletteItem[]; onChoose: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState(""), [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null);
  const { filtered, truncated } = useMemo(() => {
    const words = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = items.filter((item) => words.every((word) => `${item.label} ${item.detail ?? ""}`.normalize("NFKC").toLocaleLowerCase().includes(word)));
    return { filtered: matches.slice(0, 50), truncated: matches.length > 50 };
  }, [query, items]);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; input.current?.focus(); return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { list.current?.children[selected]?.scrollIntoView?.({ block: "nearest" }); }, [selected]);
  const title = kind === "files" ? "快速打开文档" : "命令面板";
  return <div className="modal-backdrop palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={panel} className="quick-palette" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected((previous) => filtered.length ? (previous + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length : 0); }
    if (event.key === "Enter") { event.preventDefault(); const item = filtered[selected]; if (item && !item.disabled) onChoose(item.id); }
    if (event.key === "Tab") {
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input') ?? [])], first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><header><strong>{title}</strong><button type="button" aria-label="关闭面板" onClick={onClose}>×</button></header>
    <input ref={input} aria-label={title} placeholder={kind === "files" ? "搜索文件名或路径…" : "搜索操作…"} value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" aria-controls="palette-results" aria-activedescendant={filtered[selected] ? `palette-option-${selected}` : undefined} />
    <div className="palette-results" id="palette-results" ref={list} role="listbox" aria-label={kind === "files" ? "文档结果" : "可用命令"}>{filtered.map((item, index) => <button type="button" role="option" aria-selected={index === selected} aria-disabled={item.disabled} disabled={item.disabled} id={`palette-option-${index}`} key={item.id} onMouseEnter={() => setSelected(index)} onClick={() => onChoose(item.id)}><span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>{item.keys && <kbd>{item.keys}</kbd>}</button>)}{!filtered.length && <p>没有匹配的{kind === "files" ? "文档" : "操作"}</p>}</div>
    {truncated && <footer>最多显示 50 项</footer>}
  </div></div>;
}
