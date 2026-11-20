"use client";

import { useEffect, useRef, useState } from "react";
import { graphTabId, isNoteTab } from "../lib/workspace-state";
import { isCanvas, isDrawing, isMarkdown } from "../lib/document-kind";
import { WorkspaceIcon } from "./workspace-icon";

export const tasksTabId = "@tasks";
export const panelId = (id: string) => `workspace-${encodeURIComponent(id)}`;
export const workspaceTabType = "application/x-noto-workspace-tab";
export function transferredTab(transfer: DataTransfer, scope: string): string | null {
  try { const item = JSON.parse(transfer.getData(workspaceTabType)); return item.scope === scope && typeof item.path === "string" ? item.path : null; }
  catch { return null; }
}

// Adapted from Noteriv's TitleBar: ordered tabs, active/dirty indicators,
// close buttons and middle-click closing. File sessions live in DesktopApp.
export function WorkspaceTabs({ tabs, active, busy, dirty, conflicts, onSelect, onClose, pinned = [], onPin, onReorder, onCloseTabs, onReveal, label = "工作区标签", dragScope = "", onTabDrag, onMovePane, moveLabel = "在右侧打开" }: {
  tabs: string[]; active: string | null; busy: boolean; dirty: string[]; conflicts: string[];
  onSelect: (id: string) => void; onClose: (id: string) => void;
  pinned?: string[]; onPin?: (id: string) => void; onReorder?: (from: string, to: string) => void;
  onCloseTabs?: (ids: string[]) => void; onReveal?: (id: string) => void;
  label?: string; dragScope?: string; onTabDrag?: (id: string | null) => void; onMovePane?: (id: string) => void; moveLabel?: string;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const dragged = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => { dragged.current = null; }, [tabs.join("\0")]);
  useEffect(() => { if (active) buttons.current.get(active)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [active, tabs.length]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null), escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("click", close); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", escape); };
  }, [menu]);
  function context(id: string, x: number, y: number) { if (!busy) setMenu({ id, x: Math.max(8, Math.min(x, window.innerWidth - 196)), y: Math.max(8, Math.min(y, window.innerHeight - 260)) }); }
  const closable = (ids: string[]) => ids.filter((id) => !pinned.includes(id));
  return <><div className="tab-bar" role="tablist" aria-label={label}>{tabs.map((id, index) => {
    const name = id === tasksTabId ? "任务管理" : id === graphTabId ? "知识图谱" : id.split("/").pop()!;
    const duplicate = isNoteTab(id) && tabs.some((other) => other !== id && other.split("/").pop() === name);
    const label = duplicate ? `${name} · ${id.slice(0, id.lastIndexOf("/")) || "根目录"}` : name;
    const conflict = conflicts.includes(id);
    const pin = pinned.includes(id);
    return <div key={id} role="presentation" className={`note-tab ${active === id ? "active" : ""} ${conflict ? "has-conflict" : ""} ${pin ? "tab-pinned" : ""}`} draggable={!busy} onDragStart={(event) => { dragged.current = id; onTabDrag?.(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(workspaceTabType, JSON.stringify({ scope: dragScope, path: id })); }} onDragEnd={() => { dragged.current = null; onTabDrag?.(null); }} onDragOver={(event) => { if (dragged.current && pin === pinned.includes(dragged.current)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { if (!dragged.current) return; event.preventDefault(); event.stopPropagation(); if (!busy) onReorder?.(dragged.current, id); dragged.current = null; onTabDrag?.(null); }} onContextMenu={(event) => { event.preventDefault(); context(id, event.clientX, event.clientY); }} onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onMouseUp={(event) => { if (event.button === 1 && !busy && !pin) onClose(id); }}>
      <button ref={(button) => { if (button) buttons.current.set(id, button); else buttons.current.delete(id); }} type="button" role="tab" id={`${panelId(id)}-tab`} aria-controls={panelId(id)} aria-selected={active === id} tabIndex={active === id ? 0 : -1} title={isNoteTab(id) ? id : name} disabled={busy} onClick={() => onSelect(id)} onKeyDown={(event) => {
        if (event.key === "F10" && event.shiftKey) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); context(id, rect.left, rect.bottom); return; }
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault(); onSelect(tabs[next]); buttons.current.get(tabs[next])?.focus();
      }}>{pin ? <span className="tab-pin" aria-label="已固定"><WorkspaceIcon name="pin" size={14}/></span> : <WorkspaceIcon className="tab-icon" name={id === tasksTabId ? "checklist" : id === graphTabId ? "graph" : isCanvas(id) ? "canvas" : isDrawing(id) ? "drawing" : "file"} size={14}/>}<span className="tab-label">{label}</span>{conflict ? <span className="tab-conflict" aria-label="存在冲突">!</span> : dirty.includes(id) && <span className="tab-dirty" aria-label="未保存" />}</button>
      {!pin && <button type="button" className="tab-close" disabled={busy} aria-label={`关闭标签 ${label}`} title="关闭标签（Ctrl+W）" onClick={() => onClose(id)}><WorkspaceIcon name="close" size={13}/></button>}
    </div>;
  })}</div>{menu && <div className="file-menu tab-context-menu" role="menu" aria-label="标签操作" style={{ left: menu.x, top: menu.y }}>
    <button type="button" role="menuitem" onClick={() => { onPin?.(menu.id); setMenu(null); }}>{pinned.includes(menu.id) ? "取消固定标签" : "固定标签"}</button>
    {isMarkdown(menu.id) && onMovePane && <button type="button" role="menuitem" onClick={() => { onMovePane(menu.id); setMenu(null); }}>{moveLabel}</button>}
    {isNoteTab(menu.id) && <button type="button" role="menuitem" onClick={() => { onReveal?.(menu.id); setMenu(null); }}>在文件树中定位</button>}<hr />
    <button type="button" role="menuitem" disabled={pinned.includes(menu.id)} onClick={() => { onClose(menu.id); setMenu(null); }}>关闭标签</button>
    {[["关闭其他标签", tabs.filter((id) => id !== menu.id)], ["关闭右侧标签", tabs.slice(tabs.indexOf(menu.id) + 1)], ["关闭全部标签", tabs]] .map(([label, ids]) => <button type="button" role="menuitem" key={String(label)} disabled={!onCloseTabs || !closable(ids as string[]).length} onClick={() => { onCloseTabs?.(closable(ids as string[])); setMenu(null); }}>{label}</button>)}
    <small>固定的标签会保留</small>
  </div>}</>;
}
