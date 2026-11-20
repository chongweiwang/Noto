"use client";

// Pointer threshold, drag ghost and drop placement adapted from Noteriv BoardView.
// Data, identity, cancellation and persistence follow Noto's task/file contract.
import { useEffect, useRef, useState } from "react";
import { taskOverdue, taskStatusLabels, type TaskStatus } from "../lib/tasks";
import { taskStatuses, taskWritable } from "../lib/task-board";
import { localDate } from "../lib/calendar";
import { taskLabel } from "../lib/vault-structure";
import type { TaskItemView } from "./task-workspace";
import { WorkspaceIcon } from "./workspace-icon";
type Drop = { status: TaskStatus; before: TaskItemView | null };
type Held = { item: TaskItemView; x: number; y: number; startX: number; startY: number; active: boolean; drop: Drop | null; fingerprint: string };
export const taskItemKey = (item: TaskItemView) => item.key ?? (item.path + ":" + (item.task.id && !item.task.boardIssues.includes("任务ID在分类内重复") ? item.task.id : "offset-" + item.task.from));
export function TaskBoard({ items, totals, sorting, active, loading = false, addDisabled, disabled, fingerprint, scrolls, onScroll, onSelect, onPlace, onAdd, onError, sourceLabel = taskLabel }: {
  items: TaskItemView[]; totals: TaskItemView[]; sorting: boolean; active: boolean; loading?: boolean; addDisabled: boolean;
  disabled: (item: TaskItemView) => boolean; fingerprint: string;
  scrolls: Record<string, number>; onScroll: (key: string, value: number) => void;
  onSelect: (item: TaskItemView) => void;
  onPlace: (item: TaskItemView, status: TaskStatus, before?: TaskItemView | null) => Promise<boolean>;
  onAdd: (title: string, status?: TaskStatus) => Promise<boolean>; onError: (message: string) => void;
  sourceLabel?: (path: string) => string;
}) {
  const root = useRef<HTMLDivElement>(null), ghost = useRef<HTMLDivElement>(null);
  const held = useRef<Held | null>(null), raf = useRef(0);
  const previousStyle = useRef<{ cursor: string; userSelect: string } | null>(null);
  const [dragging, setDragging] = useState<TaskItemView | null>(null), [drop, setDrop] = useState<Drop | null>(null);
  const [adding, setAdding] = useState<TaskStatus | null>(null), [title, setTitle] = useState("");
  const [pending, setPending] = useState(false), [limits, setLimits] = useState<Record<string, number>>({});
  const latest = useRef({ items, sorting, active, disabled, fingerprint, onPlace, onError });
  latest.current = { items, sorting, active, disabled, fingerprint, onPlace, onError };
  const today = localDate(new Date());
  function showDrop(value: Drop | null) {
    setDrop((previous) => previous?.status === value?.status && previous?.before?.path === value?.before?.path && previous?.before?.task.from === value?.before?.task.from ? previous : value);
  }
  function cancel() {
    held.current = null; setDragging(null); setDrop(null);
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; }
    if (previousStyle.current) { Object.assign(document.body.style, previousStyle.current); previousStyle.current = null; }
  }
  useEffect(() => {
    if (held.current && (!active || held.current.fingerprint !== fingerprint || disabled(held.current.item))) {
      cancel(); if (active) onError("拖动期间任务内容或范围已变化，请重试。");
    }
  }, [active, fingerprint, disabled]);
  useEffect(() => {
    if (!active) return;
    const scroller = root.current;
    if (scroller) scroller.scrollLeft = scrolls.board ?? 0;
    for (const element of scroller?.querySelectorAll<HTMLElement>("[data-column-scroll]") ?? []) element.scrollTop = scrolls[element.dataset.columnScroll!] ?? 0;
    function target(x: number, y: number): Drop | null {
      const element = document.elementFromPoint?.(x, y);
      const column = element?.closest<HTMLElement>("[data-task-board-status]");
      if (!column || !root.current?.contains(column)) return null;
      const status = column.dataset.taskBoardStatus as TaskStatus;
      let before: TaskItemView | null = null;
      const card = element?.closest<HTMLElement>("[data-task-card]");
      if (latest.current.sorting && card) {
        const found = latest.current.items.find((item) => taskItemKey(item) === card.dataset.taskCard);
        if (found && taskWritable(found.task)) {
          const rect = card.getBoundingClientRect();
          if (y < rect.top + rect.height / 2) before = found;
          else {
            const list = latest.current.items.filter((item) => item.task.status === status);
            before = list[list.indexOf(found) + 1] ?? null;
          }
        }
      }
      return { status, before };
    }
    function autoScroll() {
      raf.current = 0; const s = held.current; if (!s?.active || !root.current) return;
      const rect = root.current.getBoundingClientRect();
      if (s.y >= rect.top && s.y <= rect.bottom) root.current.scrollLeft += s.x < rect.left + 34 ? -12 : s.x > rect.right - 34 ? 12 : 0;
      const column = document.elementFromPoint?.(s.x, s.y)?.closest<HTMLElement>("[data-column-scroll]");
      if (column && root.current.contains(column)) { const r = column.getBoundingClientRect(); column.scrollTop += s.y < r.top + 30 ? -12 : s.y > r.bottom - 30 ? 12 : 0; }
      s.drop = target(s.x, s.y); showDrop(s.drop);
      raf.current = requestAnimationFrame(autoScroll);
    }
    function move(event: PointerEvent) {
      const s = held.current; if (!s) return;
      s.x = event.clientX; s.y = event.clientY;
      if (!s.active) {
        if (Math.hypot(s.x - s.startX, s.y - s.startY) < 4) return;
        s.active = true; previousStyle.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
        document.body.style.cursor = "grabbing"; document.body.style.userSelect = "none";
        setDragging(s.item); raf.current = requestAnimationFrame(autoScroll);
      }
      if (ghost.current) ghost.current.style.transform = "translate3d(" + (s.x + 12) + "px," + (s.y + 12) + "px,0)";
      s.drop = target(s.x, s.y); showDrop(s.drop);
    }
    function up(event: PointerEvent) {
      const s = held.current; if (!s) return;
      const chosen = s.active ? target(event.clientX, event.clientY) : null;
      cancel();
      if (!s.active || !chosen) return;
      if (s.fingerprint !== latest.current.fingerprint || latest.current.disabled(s.item)) { latest.current.onError("任务已变化，请重新拖动。"); return; }
      setPending(true);
      void latest.current.onPlace(s.item, chosen.status, latest.current.sorting ? chosen.before : undefined).finally(() => setPending(false));
    }
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && held.current) { event.preventDefault(); cancel(); } };
    const hidden = () => { if (document.hidden) cancel(); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel); document.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", hidden); window.addEventListener("blur", cancel);
    return () => {
      cancel(); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel); document.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", hidden); window.removeEventListener("blur", cancel);
    };
    // Scroll is restored on activation; ordinary metadata writes must not cancel a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  function apply(item: TaskItemView, status: TaskStatus, before?: TaskItemView | null) {
    setPending(true); void onPlace(item, status, before).finally(() => setPending(false));
  }
  return <div className="task-board" ref={root} aria-label="任务看板" onScroll={(event) => onScroll("board", event.currentTarget.scrollLeft)}>
    {taskStatuses.map((status) => {
      const column = items.filter((item) => item.task.status === status), total = totals.filter((item) => item.task.status === status).length;
      const visible = column.slice(0, limits[status] ?? (scrolls[status] ? column.length : 100));
      return <section className={"board-column board-" + status + (drop?.status === status ? " board-drop-active" : "")} key={status} data-task-board-status={status} aria-label={taskStatusLabels[status] + "列"}>
        <header><h2><i />{taskStatusLabels[status]}<small>{column.length === total ? total : column.length + " / " + total}</small></h2><button type="button" aria-label={"在" + taskStatusLabels[status] + "添加任务"} title="添加任务" disabled={addDisabled || pending} onClick={() => { setAdding(status); setTitle(""); }}><WorkspaceIcon name="plus" /></button></header>
        <div className="board-column-scroll" data-column-scroll={status} onScroll={(event) => onScroll(status, event.currentTarget.scrollTop)}>
          {visible.map((item, index) => {
            const task = item.task, blocked = pending || disabled(item) || !taskWritable(task), overdue = taskOverdue(task, today), source = sourceLabel(item.path);
            return <div key={taskItemKey(item)} data-task-card={taskItemKey(item)} className={"board-card" + (dragging && taskItemKey(dragging) === taskItemKey(item) ? " board-card-dragging" : "")} onPointerDown={(event) => {
              if (event.button !== 0 || blocked || (event.target as HTMLElement).closest("button, input, select, a, textarea, summary")) return;
              held.current = { item, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, active: false, drop: null, fingerprint };
            }}>
              {sorting && drop?.status === status && drop.before && taskItemKey(drop.before) === taskItemKey(item) && <div className="board-insertion" />}
              <div className="board-card-top"><span className="board-grip" role="img" aria-label={"拖动任务：" + task.title} title="拖动任务"><WorkspaceIcon name="grip" size={14} /></span><input type="checkbox" aria-label={"完成任务：" + task.title} checked={task.completed} disabled={blocked} onChange={() => apply(item, task.completed ? "todo" : "done")} /><button type="button" className={"board-card-title" + (task.completed ? " task-completed" : "")} title={task.title} onClick={() => onSelect(item)}>{task.title}</button>
              <details className="board-card-actions"><summary aria-label={"任务操作：" + task.title} title="任务操作"><WorkspaceIcon name="more" /></summary><div>
                {taskStatuses.map((next) => <button type="button" key={next} disabled={blocked || next === task.status} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); apply(item, next); }}>移至{taskStatusLabels[next]}</button>)}
                {sorting && <><button type="button" disabled={blocked || index === 0} onClick={() => apply(item, status, column[index - 1])}>上移</button><button type="button" disabled={blocked || index === column.length - 1} onClick={() => apply(item, status, column[index + 2] ?? null)}>下移</button></>}
                <button type="button" onClick={() => onSelect(item)}>查看详情</button>
              </div></details>
              </div>
              {(source || task.remark || task.startDate || task.endDate) && <div className="board-card-meta">{source && <span className="board-card-source" title={item.path}>{source}</span>}{task.remark && <span title="有 Markdown 备注"><WorkspaceIcon name="file" size={13} /></span>}{(task.startDate || task.endDate) && <span className={overdue ? "task-overdue" : ""}><WorkspaceIcon name="calendar" size={12} />{overdue && "逾期 "}{task.startDate && task.endDate ? task.startDate + " → " + task.endDate : task.startDate ? "开始 " + task.startDate : task.endDate}</span>}</div>}
              {!!(task.issues.length + task.boardIssues.length) && <p className="board-card-warning">{[...task.issues, ...task.boardIssues].join("、")}</p>}
            </div>;
          })}
          {column.length > visible.length && <button type="button" className="board-more" onClick={() => setLimits((old) => ({ ...old, [status]: (old[status] ?? 100) + 100 }))}>继续显示（已显示 {visible.length} / {column.length}）</button>}
          {sorting && drop?.status === status && !drop.before && <div className="board-insertion" />}
          {!column.length && <p className="board-empty">{loading ? "正在读取任务…" : "暂无任务，可拖入此列"}</p>}
          {adding === status && <form className="board-add" onSubmit={(event) => { event.preventDefault(); if (!title.trim() || pending) return; setPending(true); void onAdd(title.trim(), status).then((ok) => { if (ok) { setTitle(""); setAdding(null); } }).finally(() => setPending(false)); }}><input autoFocus aria-label={"新建" + taskStatusLabels[status] + "任务"} placeholder="任务名称，回车保存" value={title} maxLength={1000} disabled={pending || addDisabled} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); if (event.key === "Escape") { event.preventDefault(); setAdding(null); } }} /><button type="submit" disabled={pending || !title.trim()}>添加</button><button type="button" onClick={() => setAdding(null)}>取消</button></form>}
        </div>
      </section>;
    })}
    {dragging && <div className="board-drag-ghost" ref={ghost} aria-hidden="true" style={{ transform: "translate3d(" + ((held.current?.x ?? 0) + 12) + "px," + ((held.current?.y ?? 0) + 12) + "px,0)" }}>{dragging.task.title}</div>}
  </div>;
}
