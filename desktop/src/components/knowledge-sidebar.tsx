"use client";

// Panel interactions and the month grid are informed by Noteriv's VaultSearch,
// BacklinksPanel and CalendarView, adapted to Noto's local file contract.
import { useEffect, useMemo, useState } from "react";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";
import type {WikiOpen} from "../lib/wiki-ui";
import { calendarDays, dailyPath, localDate } from "../lib/calendar";
import { KnowledgeIndex, referenceHasIssue, referenceIssueText, scanNotes, type RelationIndex, type Snapshot } from "../lib/knowledge";

type ScanState = Snapshot & { loading: boolean };

export function useKnowledgeSnapshot(vault: string | null, paths: string[], enabled: boolean, revision: number, generation?: { current: number }): ScanState {
  const { api: desktop } = useWorkspaceRuntime();
  const [snapshot, setSnapshot] = useState<ScanState & { identity: string | null; source: string | null }>({ identity: null, source: null, notes: [], errors: [], loading: false });
  const pathsKey = paths.join("\0");
  const source = vault && enabled ? `${vault}\0${generation?.current ?? 0}\0${pathsKey}` : null;
  const identity = source ? `${source}\0${revision}` : null;
  useEffect(() => {
    if (!identity) { setSnapshot({ identity: null, source: null, notes: [], errors: [], loading: false }); return; }
    const job = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = generation?.current;
    const invalid = () => job.signal.aborted || (generation !== undefined && generation.current !== startedAt);
    setSnapshot((previous) => previous.source === source ? { ...previous, identity, loading: true } : { identity, source, notes: [], errors: [], loading: true });
    async function refresh() {
      try {
        const result = desktop.snapshot ? await desktop.snapshot(paths, job.signal).catch((error) => ({ notes: [], errors: [{ path: "知识库", error: error instanceof Error ? error.message : String(error) }] })) : await scanNotes(paths, desktop.read, invalid);
        if (!invalid()) setSnapshot((previous) => {
          if (invalid()) return previous;
          const known = new Map(previous.notes.map((note) => [note.path, note]));
          const notes = result.notes.map((note) => {
            const old = known.get(note.path);
            return old?.version === note.version && old.content === note.content ? old : note;
          }).sort((a, b) => a.path.localeCompare(b.path));
          const unchanged = previous.source === source && notes.length === previous.notes.length && notes.every((note, index) => note === previous.notes[index]);
          if (unchanged && previous.identity === identity && !previous.loading && result.errors.length === previous.errors.length &&
            result.errors.every(({ path, error }, index) => path === previous.errors[index].path && error === previous.errors[index].error)) return previous;
          return { ...result, notes: unchanged ? previous.notes : notes, identity, source, loading: false };
        });
      } finally {
        if (!invalid()) timer = setTimeout(() => { void refresh(); }, 3000);
      }
    }
    void refresh();
    return () => { job.abort(); clearTimeout(timer); };
  }, [identity]);
  return snapshot.identity === identity ? snapshot : source && snapshot.source === source ? { ...snapshot, loading: true } : { notes: [], errors: [], loading: !!identity };
}

export function ScanWarnings({ errors }: { errors: Snapshot["errors"] }) {
  if (!errors.length) return null;
  return <details className="knowledge-warnings"><summary>{errors.length} 篇笔记无法读取</summary>
    {errors.map((item) => <p key={item.path}>{item.path}：{item.error}</p>)}
  </details>;
}

export {SearchPanel} from "./search-panel";

export function BacklinksPanel({ snapshot, target, paths, relations, onOpen, onClose, onWikiOpen }: { snapshot: ScanState; target: string; paths: string[]; relations?: RelationIndex; onWikiOpen?:WikiOpen; onOpen: (path: string, from?: number) => void; onClose: () => void }) {
  const [direction, setDirection] = useState<"in" | "out" | "issues">("in");
  const builder = useMemo(() => new KnowledgeIndex(), []);
  const index = useMemo(() => relations ?? builder.build(paths, snapshot.notes), [relations, builder, paths, snapshot.notes]);
  const incoming = index.references.filter((link) => link.source !== target && link.status === "resolved" && link.target === target);
  const outgoing = index.references.filter((link) => link.source === target);
  const problems = outgoing.filter(referenceHasIssue);
  const links = direction === "in" ? incoming : direction === "out" ? outgoing : problems;
  const shown = links.slice(0, 200);
  return <div className="knowledge-panel">
    <div className="knowledge-heading"><strong>笔记关联</strong><button type="button" onClick={onClose} aria-label="关闭反向链接">×</button></div>
    <p className="knowledge-hint" title={target}>当前：{target}</p>
    <div className="relation-tabs" role="group" aria-label="关联方向">{([["in", "入链"], ["out", "出链"], ["issues", "链接问题"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={direction === value} onClick={() => setDirection(value)}>{label}</button>)}</div>
    <div className="knowledge-results" aria-live="polite">
      {snapshot.loading && <p className="knowledge-empty">正在查找引用，当前结果可能尚未更新…</p>}
      {!links.length && !snapshot.loading ? <p className="knowledge-empty">{snapshot.errors.length ? "未找到已确认的关联；存在读取失败，结果不完整。" : direction === "in" ? "还没有其他笔记引用此笔记。" : direction === "out" ? "此笔记没有内部笔记链接。" : "此笔记没有待处理的链接问题。"}</p> : !!links.length && <>
        <p className="knowledge-count">{direction === "in" ? links.length + " 处引用" : direction === "out" ? links.length + " 处出链" : links.length + " 处链接问题"}{links.length > shown.length ? "，显示前 200 项" : ""}</p>
        {shown.map((link) => <div className="relation-item" key={link.source + ":" + link.from}>
          {direction === "in" ? <button type="button" className="knowledge-result" onClick={() => onOpen(link.source, link.from)}><strong>{link.source}</strong><small>第 {link.line} 行 · {link.snippet}</small></button>
            : link.status === "resolved"&&!referenceHasIssue(link) ? <button type="button" className="knowledge-result" onClick={() => {if(link.kind!=="markdown"&&link.heading&&onWikiOpen)onWikiOpen(link.raw,link.source);else onOpen(link.target!);}}><strong>{link.target}</strong><small>{link.kind === "wiki" ? "Wiki" : link.kind === "embed" ? "嵌入" : "Markdown"}{link.heading?" · #"+link.heading.fragment:""} · 第 {link.line} 行 · {link.snippet}</small></button>
            : <><strong>{link.raw}</strong><small>{link.status==="ambiguous"?"同名目标，请选择":referenceIssueText(link)} · 第 {link.line} 行</small>
              <p>{link.snippet}</p>
              {link.candidates.map((candidate) => <button type="button" className="knowledge-result" key={candidate} onClick={() => {if(link.kind!=="markdown"&&link.heading&&onWikiOpen)onWikiOpen(link.raw,link.source,candidate);else onOpen(candidate);}}>{candidate}</button>)}
              <button type="button" onClick={() => onOpen(link.source, link.from)}>定位来源</button></>}
        </div>)}
      </>}
      <ScanWarnings errors={snapshot.errors} />
    </div>
  </div>;
}

export function CalendarPanel({ paths, current, busy, onDate, onClose }: { paths: string[]; current?: string; busy: boolean; onDate: (date: string) => void; onClose: () => void }) {
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const today = localDate(new Date());
  const days = calendarDays(month.getFullYear(), month.getMonth());
  const known = new Set(paths);
  function shift(amount: number) { setMonth(new Date(month.getFullYear(), month.getMonth() + amount, 1)); }
  return <div className="knowledge-panel calendar-panel">
    <div className="knowledge-heading"><strong>日历</strong><button type="button" onClick={onClose} aria-label="关闭日历">×</button></div>
    <div className="calendar-controls"><button type="button" onClick={() => shift(-1)} aria-label="上个月">‹</button><strong>{month.getFullYear()} 年 {month.getMonth() + 1} 月</strong><button type="button" onClick={() => shift(1)} aria-label="下个月">›</button></div>
    <button type="button" className="calendar-today" onClick={() => { const now = new Date(); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); }}>今天</button>
    <div className="calendar-grid calendar-weekdays" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="calendar-grid">{days.map((day) => {
      const date = localDate(day), path = dailyPath(date), exists = known.has(path);
      return <button type="button" key={date} disabled={busy} className={`${day.getMonth() !== month.getMonth() ? "other-month" : ""} ${date === today ? "today" : ""} ${current === path ? "active" : ""}`} aria-label={`${date}，${exists ? "打开" : "创建"}每日笔记`} aria-description={[date === today && "今天", current === path && "当前笔记", exists && "已有日记"].filter(Boolean).join("，") || undefined} aria-current={date === today ? "date" : undefined} title={`${exists ? "打开" : "创建"} ${path}`} onClick={() => { setMonth(new Date(day.getFullYear(), day.getMonth(), 1)); onDate(date); }}>
        {day.getDate()}{exists && <span className="calendar-dot" aria-hidden="true" />}
      </button>;
    })}</div>
  </div>;
}
