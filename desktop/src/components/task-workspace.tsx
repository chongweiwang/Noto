"use client";
import type {WikiServices,WikiOpen} from "../lib/wiki-ui";
import {saveFeedback} from "../lib/save-feedback";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Note } from "../lib/desktop-api";
import { parseTaskDocument, taskOverdue, taskStatusLabels, type Task, type TaskStatus } from "../lib/tasks";
import { compareTaskOrder, taskWritable, type TaskChange } from "../lib/task-board";
import type { TaskViewSettings } from "../lib/workspace-state";
import { TaskBoard, taskItemKey } from "./task-board";
import { WorkspaceIcon } from "./workspace-icon";
import { insertMarkdownTask } from "../lib/markdown-checklist";
import { MarkdownPreview } from "./markdown-preview";
import { parentPath, pathName, taskLabel } from "../lib/vault-structure";
import { localDate } from "../lib/calendar";

type Snapshot = { notes: Note[]; errors: { path: string; error: string }[]; loading: boolean };
export type TaskSession = { note: Note; content: string; conflict: string | null };
export type TaskAction = TaskChange | { kind: "delete" };
export type TaskFocus = { path: string; from: number; serial: number; id?: string };
export type TaskItemView = { path: string; version: string; task: Task; content?: string; key?: string };

type Item = TaskItemView;

export function categoryName(path: string) { return path.split("/").pop()?.replace(/\.(?:md|markdown)$/i, "") ?? path; }

export function TaskSidebar({ paths, groups, group, category, busy, onAll, onGroup, onCategory, onCreate, onCreateGroup, onContext }: {
  paths: string[]; groups: string[]; group: string | null; category: string | null; busy: boolean;
  onAll: () => void; onGroup: (path: string) => void; onCategory: (path: string) => void; onCreate: (group?: string) => void; onCreateGroup: () => void;
  onContext: (path: string, x: number, y: number) => void;
}) {
  const [closed, setClosed] = useState<string[]>([]);
  return <div className="knowledge-panel task-sidebar">
    <div className="task-sidebar-heading"><span><WorkspaceIcon name="checklist" size={19} /><strong>任务</strong></span><div className="task-tree-tools"><button type="button" disabled={busy} onClick={onCreateGroup} title="新建分组" aria-label="新建任务分组"><WorkspaceIcon name="new-folder" /></button><button type="button" disabled={busy} onClick={() => onCreate()} title="新建分类" aria-label="新建任务分类"><WorkspaceIcon name="plus" /></button></div></div>
    <button type="button" className={`task-category task-all-category ${!group && !category ? "active" : ""}`} disabled={busy} onClick={onAll}><WorkspaceIcon name="checklist" /><span>全部任务</span></button>
    <div className="task-category-heading"><span>分组与分类</span><span title="分类数量">{paths.length} 个分类</span></div>
    <div className="task-categories">{groups.map((folder) => {
      const children = paths.filter((path) => parentPath(path) === folder), collapsed = closed.includes(folder);
      return <section className="task-tree-group" aria-label={`分组 ${pathName(folder)}`} key={folder}>
        <div className={`task-group-row ${group === folder && !category ? "active" : ""}`} onContextMenu={(event) => { event.preventDefault(); onContext(folder, event.clientX, event.clientY); }}>
          <button type="button" className="task-tree-fold" aria-label={`${collapsed ? "展开" : "折叠"}分组 ${pathName(folder)}`} aria-expanded={!collapsed} onClick={() => setClosed((previous) => collapsed ? previous.filter((path) => path !== folder) : [...previous, folder])}><WorkspaceIcon name="chevron" size={13} /></button>
          <button type="button" className="task-group-name" aria-label={`查看分组 ${pathName(folder)}`} title={folder} disabled={busy} onClick={() => onGroup(folder)}><WorkspaceIcon name="folder" size={14} /><span>{pathName(folder)}</span><small title="分类数量">{children.length}</small></button>
          <button type="button" className="task-tree-add" aria-label={`在分组 ${pathName(folder)} 新建分类`} title="新建分类" disabled={busy} onClick={() => onCreate(folder)}><WorkspaceIcon name="plus" size={13} /></button>
          <button type="button" className="task-tree-more" aria-label={`分组 ${pathName(folder)} 的操作`} title="分组操作" disabled={busy} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); event.stopPropagation(); onContext(folder, rect.right, rect.bottom); }}><WorkspaceIcon name="more" size={15} /></button>
        </div>
        {!collapsed && <div className="task-group-categories">{children.map((path, index) => <div className="task-category-row" key={path} onContextMenu={(event) => { event.preventDefault(); onContext(path, event.clientX, event.clientY); }}>
          <button type="button" className={`task-category ${category === path ? "active" : ""}`} disabled={busy} onClick={() => onCategory(path)} title={path}><span className={`task-category-dot tone-${index % 4}`} /><span>{categoryName(path)}</span></button>
          {category === path && <button type="button" className="task-tree-more" aria-label={`分类 ${taskLabel(path)} 的操作`} title="分类操作" disabled={busy} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); event.stopPropagation(); onContext(path, rect.right, rect.bottom); }}><WorkspaceIcon name="more" size={15} /></button>}
        </div>)}{!children.length && <p className="task-empty-group">还没有分类</p>}</div>}
      </section>;
    })}</div>
  </div>;
}

function TaskDetails({ item, disabled, paths, categories, saveControls, onEdit, onDelete, onMove, onSource, onSave, onClose, onError, onOpenNote, onWikiOpen, wikiServices, sourceDisabled }: {
  item: Item; disabled: boolean; paths: string[]; categories: string[];
  saveControls: ReactNode;
  onEdit: (item: Item, action: TaskAction) => string | null;
  onDelete: (item: Item) => void; onMove: (item: Item, target: string) => void; onSource: (path: string) => void; onSave: () => void;
  onClose: () => void; sourceDisabled: boolean;
  onError: (error: string) => void; onOpenNote: (path: string, anchor?: string) => void; onWikiOpen: WikiOpen; wikiServices?:WikiServices;
}) {
  const { task } = item;
  const [title, setTitle] = useState(task.title);
  const [remark, setRemark] = useState(task.remark);
  const [remarkMode, setRemarkMode] = useState<"edit" | "preview">("edit");
  const expectedRemark = useRef(task.remark);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => { setTitle(task.title); }, [task.title]);
  useEffect(() => {
    if (task.remark !== expectedRemark.current) { expectedRemark.current = task.remark; setRemark(task.remark); }
  }, [task.remark]);
  function editRemark(value: string) {
    setRemark(value);
    const result = onEdit(item, { kind: "remark", value });
    if (result !== null) expectedRemark.current = parseTaskDocument(result).tasks.find((entry) => entry.from === task.from)?.remark ?? "";
  }
  function insertFormatting(kind: "bold" | "link" | "task") {
    const input = textarea.current;
    if (!input || disabled || task.issues.length) return;
    const from = input.selectionStart, to = input.selectionEnd;
    let content: string, cursor: number, end: number;
    if (kind === "task") {
      ({ content, cursor } = insertMarkdownTask(remark, from, to)); end = cursor;
    } else {
      const selected = remark.slice(from, to) || (kind === "bold" ? "文字" : "链接文字");
      const snippet = kind === "bold" ? `**${selected}**` : `[${selected}](https://)`;
      content = remark.slice(0, from) + snippet + remark.slice(to);
      cursor = kind === "bold" ? from + 2 : from + selected.length + 3;
      end = cursor + (kind === "bold" ? selected.length : 8);
    }
    editRemark(content);
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(cursor, end); });
  }
  return <section className="task-details" aria-label="任务详情" onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="task-details-head"><button ref={closeButton} type="button" className="task-detail-close" aria-label="关闭任务详情" title="关闭（Esc）" onClick={onClose}><WorkspaceIcon name="close" size={18} /></button><div className="task-detail-save">{saveControls}</div><div className="task-detail-actions"><button type="button" disabled={sourceDisabled} aria-label="打开分类文件" title="打开分类文件" onClick={() => onSource(item.path)}><WorkspaceIcon name="file" /></button><button type="button" disabled={disabled} aria-label="删除任务" title="删除任务" onClick={() => onDelete(item)}><WorkspaceIcon name="trash" /></button></div></div>
    {(task.issues.length + task.boardIssues.length) > 0 && <div className="task-warning" role="alert">任务字段有问题：{[...task.issues, ...task.boardIssues].join("、")}。请打开分类文件处理。</div>}
    <div className="task-title-row"><input type="checkbox" aria-label="标记当前任务完成" checked={task.completed} disabled={disabled} onChange={(event) => onEdit(item, { kind: "completed", value: event.target.checked })} /><input className={`task-title-input ${task.completed ? "is-completed" : ""}`} aria-label="任务名称" value={title} disabled={disabled} placeholder="任务名称" onChange={(event) => { const value = event.target.value; setTitle(value); if (value.trim()) onEdit(item, { kind: "title", value }); }} onBlur={() => { if (!title.trim()) setTitle(task.title); }} /></div>
    <div className="task-properties">
      <label className="task-field"><span><WorkspaceIcon name="checklist" size={14} />状态</span><select aria-label="任务状态" value={task.status ?? ""} disabled={disabled} onChange={(event) => onEdit(item, { kind: "status", value: event.target.value as TaskStatus })}>{task.status === null && <option value="">字段需处理</option>}{Object.entries(taskStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="task-field"><span><WorkspaceIcon name="calendar" size={14} />开始日期</span><input type="date" aria-label="开始日期" value={task.startDate} disabled={disabled || !!task.issues.length} onInput={(event) => onEdit(item, { kind: "startDate", value: event.currentTarget.value })} onChange={(event) => onEdit(item, { kind: "startDate", value: event.target.value })} /></label>
      <label className="task-field"><span><WorkspaceIcon name="calendar" size={14} />结束日期</span><input type="date" aria-label="结束日期" value={task.endDate} disabled={disabled || !!task.issues.length} onInput={(event) => onEdit(item, { kind: "endDate", value: event.currentTarget.value })} onChange={(event) => onEdit(item, { kind: "endDate", value: event.target.value })} /></label>
      <label className="task-field"><span><WorkspaceIcon name="folder" size={14} />分类</span><select aria-label="任务分类" value={item.path} disabled={disabled || categories.length < 2} onChange={(event) => { if (event.target.value !== item.path) onMove(item, event.target.value); }}>
        {categories.map((path) => <option key={path} value={path}>{taskLabel(path)}</option>)}
      </select></label>
    </div>
    <div className="task-remark-section">
      <div className="task-remark-heading"><strong><WorkspaceIcon name="file" />备注说明</strong><div role="group" aria-label="备注视图"><button type="button" aria-pressed={remarkMode === "edit"} onClick={() => setRemarkMode("edit")}>编辑</button><button type="button" aria-pressed={remarkMode === "preview"} onClick={() => setRemarkMode("preview")}>预览</button></div></div>
      {remarkMode === "edit" ? <div className="task-remark-editor"><div className="task-remark-toolbar">
        <button type="button" disabled={disabled || !!task.issues.length} aria-label="备注加粗" title="加粗" onMouseDown={(event) => event.preventDefault()} onClick={() => insertFormatting("bold")}><b>B</b></button>
        <button type="button" disabled={disabled || !!task.issues.length} aria-label="备注插入链接" title="插入链接" onMouseDown={(event) => event.preventDefault()} onClick={() => insertFormatting("link")}><WorkspaceIcon name="link" size={15} /></button>
        <button type="button" disabled={disabled || !!task.issues.length} aria-label="备注插入任务框" title="插入任务框" onMouseDown={(event) => event.preventDefault()} onClick={() => insertFormatting("task")}><WorkspaceIcon name="checklist" size={15} /><span>任务框</span></button>
        <span className="task-markdown-label">Markdown</span>
      </div><textarea ref={textarea} aria-label="Markdown 备注" value={remark} disabled={disabled || !!task.issues.length} placeholder="添加备注" onChange={(event) => editRemark(event.target.value)} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); onSave(); } }} /></div> : <div className="task-remark-preview">{remark ? <MarkdownPreview note={item.path} content={remark} onError={onError} onOpenNote={onOpenNote} wikiPaths={paths} onWikiOpen={onWikiOpen} wikiServices={wikiServices} anchorsInSource onCheckboxChange={editRemark} checkboxesDisabled={disabled || !!task.issues.length} /> : <p className="task-remark-empty">暂无备注</p>}</div>}
    </div>
  </section>;
}

export function TaskWorkspace({ group = null, category, categories, snapshot, session, recovery, dirty, busy, saving = false, saveError, active = true, settings, onSettings, focus, paths, draftPaths, onAdd, onSelect, onEdit, onPlace, onDelete, onMove, onSource, onSave, onError, onOpenNote, onWikiOpen, wikiServices }: {
  group?: string | null; category: string | null; categories: string[]; snapshot: Snapshot; session: TaskSession | null; recovery: boolean; dirty: boolean; busy: boolean; saving?: boolean; saveError?: string; active?: boolean;
  settings: TaskViewSettings; onSettings: (patch: Partial<TaskViewSettings> | ((previous: TaskViewSettings) => Partial<TaskViewSettings>)) => void;
  focus: TaskFocus | null; paths: string[]; draftPaths: string[];
  onAdd: (title: string, status?: TaskStatus) => Promise<boolean>; onSelect: (item: Item, toggle?: boolean) => void;
  onEdit: (item: Item, action: TaskAction) => string | null;
  onPlace: (item: Item, status: TaskStatus, before?: Item | null) => Promise<boolean>;
  onDelete: (item: Item) => void; onMove: (item: Item, target: string) => void;
  onSource: (path: string) => void; onSave: () => void; onError: (error: string) => void;
  onOpenNote: (path: string, anchor?: string) => void; onWikiOpen: WikiOpen; wikiServices?:WikiServices;
}) {
  const [newTitle, setNewTitle] = useState("");
  const newTaskInput = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const taskTrigger = useRef<HTMLButtonElement | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [listLimit, setListLimit] = useState(settings.scrolls.list ? 100000 : 200);
  const [selected, setSelected] = useState<{ path: string; from: number; id: string; raw: string; key: string } | null>(null);
  const serial = useRef(0), rowSerial = useRef(0);
  const previousItems = useRef<Item[]>([]);
  const promotedKeys = useRef(new Map<string, string>());
  const cache = useRef(new Map<string, { content: string; parsed: ReturnType<typeof parseTaskDocument> }>());
  const notes = useMemo(() => {
    const merged = new Map(snapshot.notes.map((note) => [note.path, note]));
    if (session && categories.includes(session.note.path) && !recovery) merged.set(session.note.path, { ...session.note, content: session.content });
    return [...merged.values()].filter((note) => categories.includes(note.path));
  }, [snapshot.notes, session, categories, recovery]);
  const documents = useMemo(() => {
    const known = new Set(notes.map((note) => note.path));
    for (const path of cache.current.keys()) if (!known.has(path)) cache.current.delete(path);
    return notes.map((note) => {
      let found = cache.current.get(note.path);
      if (!found || found.content !== note.content) { found = { content: note.content, parsed: parseTaskDocument(note.content) }; cache.current.set(note.path, found); }
      return { note, parsed: found.parsed };
    });
  }, [notes]);
  const items = useMemo(() => {
    const byId = new Map(previousItems.current.filter((item) => item.task.id && !item.task.boardIssues.includes("任务ID在分类内重复")).map((item) => [item.path + "\0" + item.task.id, item]));
    const byOffset = new Map(previousItems.current.map((item) => [item.path + "\0" + item.task.from, item]));
    const next = documents.flatMap(({ note, parsed }) => parsed.tasks.map((task) => {
      const uniqueId = task.id && !task.boardIssues.includes("任务ID在分类内重复");
      const sameId = uniqueId ? byId.get(note.path + "\0" + task.id) : undefined;
      const sameOffset = byOffset.get(note.path + "\0" + task.from);
      const previous = sameId ?? (sameOffset && (sameOffset.task.raw === task.raw || uniqueId && !sameOffset.task.id) ? sameOffset : undefined);
      return { path: note.path, version: note.version, content: note.content, task, key: promotedKeys.current.get(note.path + "\0" + task.id) ?? previous?.key ?? "task-row-" + (++rowSerial.current) };
    }));
    previousItems.current = next;
    return next;
  }, [documents]);
  const scope = items.filter((item) => category ? item.path === category : !group || parentPath(item.path) === group).sort((a, b) => a.path.localeCompare(b.path) || compareTaskOrder(a.task, b.task));
  function choose(item: Item) {
    setSelected({ path: item.path, from: item.task.from, id: item.task.id, raw: item.task.raw, key: "detail-" + (++serial.current) });
  }
  useEffect(() => {
    if (!focus || category && focus.path !== category) { setSelected(null); return; }
    const found = scope.find((item) => item.path === focus.path && (focus.id ? item.task.id === focus.id : item.task.from === focus.from));
    if (found) setSelected((previous) => previous && previous.path !== focus.path && previous.id && previous.id === found.task.id
      ? { ...previous, path: focus.path, from: found.task.from, raw: found.task.raw } : { path: found.path, from: found.task.from, id: found.task.id, raw: found.task.raw, key: "detail-" + (++serial.current) });
    // Selection changes only on an explicit open/scope transition, never a save response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, focus?.serial, focus?.path]);
  const chosen = scope.find((item) => item.path === selected?.path && (selected.id ? item.task.id === selected.id : item.task.from === selected.from && item.task.raw === selected.raw));
  const current = category && session?.note.path === category && !recovery ? session : null;
  const activeSession = session && categories.includes(session.note.path) ? session : null;
  const detailSession = chosen && session?.note.path === chosen.path && !recovery ? session : null;
  const detailsOpen = !!chosen && !!detailSession;
  const disabled = busy || recovery || !detailSession || !!detailSession.conflict || !!chosen && !taskWritable(chosen.task);
  const blocked = (item: Item) => busy || recovery || !!(session?.note.path === item.path && session.conflict) || (draftPaths.includes(item.path) && session?.note.path !== item.path);
  const today = localDate(new Date());
  const query = settings.query.trim().toLocaleLowerCase();
  const visible = scope.filter((item) => (!query || (item.task.title + "\n" + item.task.remark + "\n" + item.path).toLocaleLowerCase().includes(query)) && (settings.filter === "all" || (settings.filter === "done") === item.task.completed));
  const open = visible.filter((item) => !item.task.completed), done = visible.filter((item) => item.task.completed);
  const sections = [{ title: "待完成", items: open }, { title: "已完成", items: done }];
  const feedback = saveFeedback({present:!!activeSession,recovery,conflict:activeSession?.conflict,saving,dirty,failure:saveError});
  const addDisabled = busy || recovery || (!category && snapshot.loading) || (!!category && (!current || !!current.conflict));
  const fingerprint = (category ?? group ?? "all") + "\0" + query + "\0" + settings.filter + "\0" + documents.map(({ note }) => note.path + "\0" + note.content).join("\0");
  const unknown = visible.filter((item) => item.task.status === null);
  const sourceLabel = (path: string) => category ? "" : group ? categoryName(path) : taskLabel(path);
  useEffect(() => { if (active && !snapshot.loading && settings.view === "list" && list.current) list.current.scrollTop = settings.scrolls.list ?? 0; }, [active, settings.view, category, group, snapshot.loading]);
  function closeDetails() {
    setSelected(null);
    requestAnimationFrame(() => { if (taskTrigger.current?.isConnected) taskTrigger.current.focus(); });
  }
  function select(item: Item, element?: HTMLButtonElement) {
    if (element) taskTrigger.current = element;
    if (session?.note.path === item.path && !recovery) choose(item);
    else onSelect(item);
  }
  function edit(item: Item, action: TaskAction) {
    const previousIds = new Set(items.filter((entry) => entry.path === item.path && entry.task.id).map((entry) => entry.task.id));
    const result = onEdit(item, action);
    if (result !== null) {
      const tasks = parseTaskDocument(result).tasks;
      // A status change can add order fields to earlier tasks, shifting source
      // offsets. The single newly assigned ID identifies this explicit mutation.
      const next = item.task.id ? tasks.find((task) => task.id === item.task.id) : tasks.find((task) => !!task.id && !previousIds.has(task.id));
      if (next) {
        if (item.key) promotedKeys.current.set(item.path + "\0" + next.id, item.key);
        setSelected((previous) => previous ? { ...previous, id: next.id, from: next.from, raw: next.raw } : previous);
      }
    }
    return result;
  }
  function scroll(key: string, value: number) {
    if (!active || snapshot.loading || settings.scrolls[key] === value) return;
    onSettings((previous) => ({ scrolls: { ...previous.scrolls, [key]: value } }));
  }
  const saveControls = <><span className={"task-save-indicator " + feedback.state} role="status" title={feedback.detail}><i />{feedback.label}</span>{activeSession && <button type="button" className="task-save-button" aria-label="保存" title="立即保存（Ctrl+S）" disabled={busy || saving || recovery || !!activeSession.conflict || !dirty} onClick={onSave}><WorkspaceIcon name="save" /></button>}</>;
  return <div className="task-workspace">
    <div className="task-list-view" inert={detailsOpen}>
      <header className="task-workspace-header"><h1>{category ? categoryName(category) : group ? pathName(group) : "全部任务"}</h1><div className="task-header-actions"><div role="group" aria-label="任务视图" className="task-view-switch">{(["list","board"] as const).map((view) => <button type="button" key={view} aria-pressed={settings.view === view} onClick={() => onSettings({ view })}>{view === "list" ? "列表" : "看板"}</button>)}</div>{!detailsOpen && saveControls}</div></header>
      <div className="task-query-bar"><input type="search" aria-label="搜索任务" maxLength={200} placeholder="搜索任务、备注或分类" value={settings.query} onChange={(event) => onSettings({ query: event.target.value })} /><div className="task-filter" role="group" aria-label="任务状态筛选">{([["all","全部"],["open","未完成"],["done","已完成"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={settings.filter === value} onClick={() => onSettings({ filter: value })}>{label}</button>)}</div><small>{visible.length} / {scope.length} 项{snapshot.loading ? " · 刷新中" : ""}{snapshot.errors.length ? " · 数据不完整" : ""}</small></div>
      {settings.view === "board" && (!category || !!query || settings.filter !== "all") && <p className="task-board-hint">列内排序仅在单分类且无筛选时可用。</p>}
      {!!unknown.length && settings.view === "board" && <details className="task-field-issues"><summary>字段需处理（{unknown.length}）</summary>{unknown.map((item) => <button type="button" key={item.path + ":" + item.task.from} onClick={(event) => select(item, event.currentTarget)}>{item.task.title} · {taskLabel(item.path)} · {item.task.boardIssues.join("、")}</button>)}</details>}
      {settings.view === "board" ? <TaskBoard sourceLabel={sourceLabel} loading={snapshot.loading} items={visible} totals={scope} sorting={!!category && !query && settings.filter === "all"} active={active && !detailsOpen} addDisabled={addDisabled} disabled={blocked} fingerprint={fingerprint} scrolls={settings.scrolls} onScroll={scroll} onSelect={select} onPlace={onPlace} onAdd={onAdd} onError={onError} /> :
      <div className="task-body"><div className="task-list-pane">
        <form className="task-quick-add" onSubmit={(event) => { event.preventDefault(); const value = newTitle.trim(); if (value) void onAdd(value).then((ok) => { if (ok) { setNewTitle(""); requestAnimationFrame(() => newTaskInput.current?.focus()); } }); }}>
          <WorkspaceIcon name="plus" /><input ref={newTaskInput} aria-label="新任务名称" placeholder={category ? "添加任务，按回车保存" : "添加任务到收件箱，按回车保存"} value={newTitle} disabled={addDisabled} onChange={(event) => setNewTitle(event.target.value)} /><button type="submit" aria-label="添加" title="添加任务" disabled={addDisabled || !newTitle.trim()}><WorkspaceIcon name="check" size={18} /></button>
        </form>
        <div className="task-list" ref={list} onScroll={(event) => scroll("list", event.currentTarget.scrollTop)}>
          {snapshot.loading && !scope.length && <p className="knowledge-empty">正在读取任务分类…</p>}
          {!visible.length && !snapshot.loading && <div className="task-list-empty"><WorkspaceIcon name="checklist" size={36} /><strong>{scope.length ? "没有符合条件的任务" : "添加第一件要做的事"}</strong><p>{scope.length ? "换一个筛选条件试试。" : "在上方输入任务名称，按回车添加。"}</p></div>}
          {sections.map((section) => section.items.length > 0 && <section className="task-row-group" key={section.title}><button type="button" className="task-group-heading" aria-expanded={!collapsed[section.title]} onClick={() => setCollapsed((previous) => ({ ...previous, [section.title]: !previous[section.title] }))}><WorkspaceIcon name="chevron" size={12} /><span>{section.title}</span><span>{section.items.length} 项</span></button>{!collapsed[section.title] && section.items.slice(0, listLimit).map((item) => <div className={"task-row" + (chosen && taskItemKey(chosen) === taskItemKey(item) ? " selected" : "")} key={taskItemKey(item)}>
            <input type="checkbox" aria-label={"完成任务：" + item.task.title} checked={item.task.completed} disabled={blocked(item) || !taskWritable(item.task)} onChange={() => onSelect(item, true)} />
            <button type="button" className="task-row-main" disabled={busy} title={item.task.title} onClick={(event) => select(item, event.currentTarget)}>
              <span className={"task-row-title" + (item.task.completed ? " task-completed" : "")}>{item.task.title}</span>
              <span className="task-row-meta">{item.task.status === "doing" && <span className="task-status-doing">进行中</span>}{item.task.remark && <span title="有 Markdown 备注"><WorkspaceIcon name="file" size={13} /></span>}{(item.task.issues.length + item.task.boardIssues.length) > 0 && <span className="task-row-issue">字段需处理</span>}{sourceLabel(item.path) && <span className="task-row-category" title={taskLabel(item.path)}>{sourceLabel(item.path)}</span>}{(item.task.startDate || item.task.endDate) && <span className={"task-row-date" + (taskOverdue(item.task, today) ? " task-overdue" : "")}><WorkspaceIcon name="calendar" size={12} />{taskOverdue(item.task, today) && "逾期 "}{item.task.startDate && item.task.endDate ? item.task.startDate + " → " + item.task.endDate : item.task.startDate ? "开始 " + item.task.startDate : item.task.endDate}</span>}</span>
            </button>
          </div>)}{section.items.length > listLimit && <button type="button" className="board-more" onClick={() => setListLimit((limit) => limit + 200)}>继续显示（{listLimit} / {section.items.length}）</button>}</section>)}
        </div>
      </div></div>}
      {snapshot.errors.map((error) => <p className="task-warning" key={error.path}>无法读取 {error.path}：{error.error}</p>)}
      {documents.flatMap(({ note, parsed }) => parsed.issues.map((issue, i) => <p className="task-warning" key={note.path + i}>{note.path}：{issue}</p>))}
      {draftPaths.some((path) => categories.includes(path) && path !== activeSession?.note.path) && <p className="task-warning">有分类存在恢复草稿，请打开该分类处理。</p>}
    </div>
    {detailsOpen && <div className="task-drawer-layer"><div className="task-drawer-backdrop" aria-hidden="true" onClick={closeDetails} /><TaskDetails key={selected!.key} sourceDisabled={busy} item={chosen} disabled={disabled} paths={paths} categories={categories} saveControls={saveControls} onEdit={edit} onDelete={onDelete} onMove={onMove} onSource={onSource} onSave={onSave} onClose={closeDetails} onError={onError} onOpenNote={onOpenNote} onWikiOpen={onWikiOpen} wikiServices={wikiServices} /></div>}
  </div>;
}
