"use client";
import { useMemo, useState } from "react";
import { buildTagIndex, matchingTagPaths, type TagBranch, type TagMatchMode } from "../lib/note-tags";
import type { Snapshot } from "../lib/knowledge";
import { pathName } from "../lib/vault-structure";
import { WorkspaceIcon } from "./workspace-icon";

const pageSize = 100;

export function TagPanel({ snapshot, current, busy, onOpen, onClose }: {
  snapshot: Snapshot & { loading: boolean };
  current: string | null;
  busy: boolean;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<TagMatchMode>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(pageSize);
  const index = useMemo(() => buildTagIndex(snapshot.notes), [snapshot.notes]);
  const matches = useMemo(() => matchingTagPaths(index, selected, mode), [index, selected, mode]);
  const files = useMemo(() => snapshot.notes.filter(note => matches.has(note.path)), [snapshot.notes, matches]);
  const summary = snapshot.loading && !index.roots.length ? "正在读取标签…" :
    selected.length ? `匹配笔记 · ${files.length} 篇` :
    index.roots.length ? `有标签的笔记 · ${files.length} 篇` : "暂无标签";
  const needle = query.trim().replace(/^#/, "").normalize("NFC").toLowerCase();
  const visible = useMemo(() => {
    if (!needle) return null;
    const items = new Set<string>();
    for (const key of index.byKey.keys()) {
      if (!key.includes(needle)) continue;
      let parent = key;
      while (parent && !items.has(parent)) {
        items.add(parent);
        parent = parent.slice(0, Math.max(0, parent.lastIndexOf("/")));
      }
    }
    return items;
  }, [index, needle]);

  function toggleTag(key: string) {
    setSelected(items => items.includes(key) ? items.filter(item => item !== key) : [...items, key]);
    setLimit(pageSize);
  }

  function toggleBranch(key: string) {
    setExpanded(items => {
      const next = new Set(items);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderBranches(branches: TagBranch[]) {
    return <ul className="tag-branches">{branches.filter(branch => !visible || visible.has(branch.key)).map(branch => {
      const open = !!visible || expanded.has(branch.key);
      const label = branch.label.split("/").at(-1);
      const active = selected.includes(branch.key);
      return <li key={branch.key}>
        <div className="tag-row">
          {branch.children.length > 0 && !visible
            ? <button type="button" className="tag-expand" aria-expanded={open} aria-label={(open ? "折叠 " : "展开 ") + branch.label}
                onClick={() => toggleBranch(branch.key)}><WorkspaceIcon name="chevron" size={12}/></button>
            : <span className="tag-expand" aria-hidden="true"/>}
          <button type="button" className="tag-name" aria-pressed={active} title={"#" + branch.label}
            aria-label={branch.label + "，" + branch.paths.size + " 篇笔记"} onClick={() => toggleTag(branch.key)}>
            <span>{label}</span><small aria-hidden="true">{branch.paths.size}</small>
          </button>
        </div>
        {open && branch.children.length > 0 && renderBranches(branch.children)}
      </li>;
    })}</ul>;
  }

  return <section className="knowledge-panel tag-panel" aria-label="标签索引">
    <div className="knowledge-heading"><strong>标签</strong><button type="button" onClick={onClose} aria-label="关闭标签索引">×</button></div>
    <div className="knowledge-input"><input type="search" aria-label="查找标签" placeholder="查找标签" value={query} onChange={event => setQuery(event.target.value)}/></div>
    {selected.length > 0 && <div className="tag-filters">
      <div className="tag-chips">{selected.map(key => {
        const label = index.byKey.get(key)?.label ?? key;
        return <button type="button" key={key} title={"移除 #" + label} aria-label={"移除标签 " + label}
          onClick={() => toggleTag(key)}>#{label} <span aria-hidden="true">×</span></button>;
      })}</div>
      <div className="tag-match-controls">
        {selected.length > 1 && <select aria-label="标签组合方式" value={mode} onChange={event => {
          setMode(event.target.value === "any" ? "any" : "all"); setLimit(pageSize);
        }}><option value="all">全部匹配</option><option value="any">任意匹配</option></select>}
        <button type="button" onClick={() => { setSelected([]); setLimit(pageSize); }}>清除筛选</button>
      </div>
    </div>}
    <div className="tag-tree" aria-label="标签层级">
      {index.roots.length > 0 && (!visible || visible.size > 0) && renderBranches(index.roots)}
      {!!index.roots.length && visible?.size === 0 && <p className="knowledge-empty">没有符合条件的标签。</p>}
    </div>
    <p className="knowledge-count" role="status">{summary}</p>
    <div className="knowledge-results" aria-label="标签笔记列表">
      {files.slice(0, limit).map(note => <button type="button" className={"knowledge-result" + (current === note.path ? " active" : "")}
        key={note.path} title={note.path} aria-current={current === note.path ? "page" : undefined}
        disabled={busy} onClick={() => onOpen(note.path)}>
        <strong>{pathName(note.path)}</strong>
        {note.path.includes("/") && <small>{note.path.slice(0, note.path.lastIndexOf("/"))}</small>}
      </button>)}
      {files.length > limit && <button type="button" onClick={() => setLimit(value => value + pageSize)}>显示更多笔记</button>}
      {snapshot.errors.length > 0 && <details className="knowledge-warnings"><summary>{snapshot.errors.length} 篇笔记无法读取</summary>
        {snapshot.errors.map(item => <p key={item.path}>{item.path}：{item.error}</p>)}
      </details>}
    </div>
  </section>;
}
