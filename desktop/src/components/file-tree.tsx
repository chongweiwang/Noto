"use client";
import {vaultDragType,isCanvas,isDrawing} from "../lib/document-kind";

import { useEffect, useRef, useState } from "react";
import type { Entry } from "../lib/vault-api";
import { isTaskOrJournalRoot, pathName } from "../lib/vault-structure";
import { WorkspaceIcon } from "./workspace-icon";

function RenameField({ path, submit, cancel }: { path: string; submit: (name: string) => Promise<boolean>; cancel: () => void }) {
  const [value, setValue] = useState(pathName(path));
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null), saving = useRef(false);
  useEffect(() => { const field = input.current; field?.focus(); field?.setSelectionRange(0, value.replace(/\.(md|markdown|canvas|drawing)$/i, "").length); }, []);
  async function commit() {
    if (saving.current) return;
    saving.current = true; setPending(true);
    try { if (await submit(value)) cancel(); else input.current?.focus(); }
    finally { saving.current = false; setPending(false); }
  }
  return <input ref={input} className="tree-rename" aria-label={`重命名 ${pathName(path)}`} value={value} disabled={pending} onChange={(event) => setValue(event.target.value)} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); void commit(); }
    if (event.key === "Escape") { event.preventDefault(); cancel(); }
  }} onBlur={() => { if (!saving.current) void commit(); }} />;
}

// Folder expansion, inline rename and folder drops follow Noteriv's Sidebar.
// Actual mutations stay in DesktopApp's protected relocation pipeline.
export function FileTree({ entries, selected, collapsed, onCollapse, managedFoldersExpanded, onManagedFoldersExpanded, select, context, renaming, onRename, onBeginRename, onCancelRename, onMove, busy, dragScope }: {
  dragScope?:string;
  entries: Entry[]; selected: string; collapsed: string[]; onCollapse: (path: string, value: boolean) => void;
  managedFoldersExpanded: boolean; onManagedFoldersExpanded: (expanded: boolean) => void;
  select: (entry: Entry) => void; context: (path: string, x: number, y: number) => void;
  renaming: string | null; onRename: (path: string, name: string) => Promise<boolean>;
  onBeginRename: (path: string) => void; onCancelRename: () => void; onMove: (from: string, directory: string) => void; busy: boolean;
}) {
  const nodes = useRef(new Map<string, HTMLElement>()), dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => { nodes.current.get(selected)?.scrollIntoView?.({ block: "nearest" }); }, [selected, collapsed, managedFoldersExpanded]);
  const canDrop = (directory: string) => !!dragged.current && !busy && directory !== dragged.current && !directory.startsWith(`${dragged.current}/`);
  const dropProps = (directory: string) => ({
    onDragOver: (event: React.DragEvent) => { if (canDrop(directory)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setOver(directory); } },
    onDragLeave: () => setOver(null),
    onDrop: (event: React.DragEvent) => { event.preventDefault(); event.stopPropagation(); if (canDrop(directory)) onMove(dragged.current!, directory); dragged.current = null; setOver(null); },
  });
  function rows(items: Entry[]): React.ReactNode {
    return items.map((entry, index) => {
      if (entry.issue) return <li key={`unsupported:${index}:${entry.name}`}><div className="tree-entry-issue" role="note" title={entry.issue} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}><WorkspaceIcon name={entry.isDirectory ? "folder" : "file"} size={15}/><span>{entry.name}<small>{entry.issue}</small></span></div></li>;
      const rename = renaming === entry.path;
      const common = {
        "data-tree-path":entry.path,
        ref: (node: HTMLElement | null) => { if (node) nodes.current.set(entry.path, node); else nodes.current.delete(entry.path); },
        className: `${entry.isDirectory ? "tree-directory" : "tree-file"} ${selected === entry.path ? "selected" : ""} ${over === entry.path ? "tree-drop-target" : ""}`,
        onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); context(entry.path, event.clientX, event.clientY); },
        draggable: !rename && !busy,
        onDragStart: (event: React.DragEvent) => { event.stopPropagation(); dragged.current = entry.path; event.dataTransfer.effectAllowed = "copyMove"; if(dragScope)event.dataTransfer.setData(vaultDragType,JSON.stringify({path:entry.path,scope:dragScope})); event.dataTransfer.setData("text/plain", entry.path); },
        onDragEnd: () => { dragged.current = null; setOver(null); },
      };
      const label = <><span className="tree-chevron" aria-hidden="true">{entry.isDirectory && <WorkspaceIcon name="chevron" size={12}/>}</span><WorkspaceIcon className="tree-icon" name={entry.isDirectory ? (collapsed.includes(entry.path) ? "folder" : "folder-open") : isDrawing(entry.path) ? "drawing" : isCanvas(entry.path) ? "canvas" : "file"} size={15}/>{rename ? <RenameField key={entry.path} path={entry.path} submit={(name) => onRename(entry.path, name)} cancel={onCancelRename} /> : <span className="tree-name" title={entry.path}>{entry.name}</span>}</>;
      return <li key={entry.path}>{entry.isDirectory ? <details open={!collapsed.includes(entry.path)} onToggle={(event) => { const value = !event.currentTarget.open; if (value !== collapsed.includes(entry.path)) onCollapse(entry.path, value); }}>
        <summary {...common} {...dropProps(entry.path)} onClick={(event) => { if (rename) event.preventDefault(); else select(entry); }}>{label}</summary><ul className="file-tree">{rows(entry.children)}</ul>
      </details> : <div className={rename ? "tree-file tree-renaming" : undefined}>{rename ? label : <button type="button" {...common} onClick={() => select(entry)}>{label}</button>}</div>}</li>;
    });
  }
  const managed = entries.filter(isTaskOrJournalRoot);
  const ordinary = entries.filter(entry => !isTaskOrJournalRoot(entry));
  return <div className={`file-tree-root ${over === "" ? "tree-drop-target" : ""}`} {...dropProps("")} onContextMenu={(event) => { event.preventDefault(); context("", event.clientX, event.clientY); }} onKeyDown={(event) => {
    const focused=(event.target as HTMLElement).closest<HTMLElement>("[data-tree-path]")?.dataset.treePath??selected;
    if (event.key === "F2" && focused && !renaming && !busy) { event.preventDefault(); onBeginRename(focused); }
  }}><ul className="file-tree">
    {rows(ordinary)}
    {managed.length > 0 && <li className="tree-managed-group">
      <button type="button" className="tree-managed-toggle" aria-expanded={managedFoldersExpanded} onClick={() => onManagedFoldersExpanded(!managedFoldersExpanded)}
        onKeyDown={event => { if (event.key === "F2") event.stopPropagation(); }}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
        onDragOver={event => { event.stopPropagation(); setOver(null); }}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); dragged.current = null; setOver(null); }}>
        <span className="tree-chevron" aria-hidden="true"><WorkspaceIcon name="chevron" size={12}/></span>任务与日记
      </button>
      {managedFoldersExpanded && <ul className="file-tree">{rows(managed)}</ul>}
    </li>}
  </ul></div>;
}

export function FolderPicker({ entries, source, onChoose, onCancel }: { entries: Entry[]; source: string; onChoose: (path: string) => void; onCancel: () => void }) {
  const [folder, setFolder] = useState(source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "");
  function folders(items: Entry[], depth = 0): React.ReactNode {
    return items.filter((entry) => !entry.issue && entry.isDirectory && entry.path !== source && !entry.path.startsWith(`${source}/`)).map((entry) => <div key={entry.path}><label style={{ paddingLeft: 16 + depth * 18 }}><input type="radio" name="destination" value={entry.path} checked={folder === entry.path} onChange={() => setFolder(entry.path)} /><span>▱ {entry.name}</span></label>{folders(entry.children, depth + 1)}</div>);
  }
  return <div className="modal-backdrop"><form className="modal folder-picker" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title" onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }} onSubmit={(event) => { event.preventDefault(); onChoose(folder); }}><h2 id="folder-picker-title">移动到文件夹</h2><p>{source}</p><div className="folder-options"><label><input autoFocus type="radio" name="destination" value="" checked={folder === ""} onChange={() => setFolder("")} /><span>知识库根目录</span></label>{folders(entries)}</div><div className="modal-actions"><button type="button" onClick={onCancel}>取消</button><button type="submit" className="primary">移动到此处</button></div></form></div>;
}
