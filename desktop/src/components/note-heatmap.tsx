"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { calendarHeatmapDays, localDate } from "../lib/calendar";
import type { NoteActivityDay } from "../lib/vault-api";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";

const levels = ["0 篇", "1 篇", "2–3 篇", "4–6 篇", "7 篇及以上"];
const weekdays = [["一", 0], ["三", 2], ["五", 4], ["日", 6]] as const;
const total = (day: NoteActivityDay) => day.created + day.edited;

export function NoteHeatmap({ revision }: { revision: number }) {
  const { api } = useWorkspaceRuntime();
  const today = localDate(new Date());
  const days = useMemo(() => calendarHeatmapDays(new Date(today + "T12:00:00")), [today]);
  const dayStarts = useMemo(() => {
    const tomorrow = new Date(today + "T00:00:00");
    tomorrow.setDate(tomorrow.getDate() + 1);
    return [...days.map(day => new Date(day.date + "T00:00:00").getTime()), tomorrow.getTime()];
  }, [days, today]);
  const [selectedDate, setSelectedDate] = useState(today);
  const [result, setResult] = useState<{ date: string; activity?: NoteActivityDay[]; error?: string } | null>(null);
  const end = days[days.length - 1];
  const foundIndex = days.findIndex(day => day.date === selectedDate);
  const selectedIndex = foundIndex < 0 ? days.length - 1 : foundIndex;
  const selected = days[selectedIndex].date;
  const activity = result?.date === today ? result.activity : undefined;
  const error = result?.date === today ? result.error : undefined;
  const selectedDay = activity?.[selectedIndex];
  const months = days.filter((day, index) => index === 0 || day.date.endsWith("-01"));
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { const element = scroller.current; if (element) element.scrollLeft = element.scrollWidth; }, []);
  useEffect(() => {
    let alive = true;
    if (!api.noteActivity) {
      setResult({ date: today, error: "当前版本无法统计笔记文件日期" });
      return;
    }
    void api.noteActivity(dayStarts).then(data => {
      if (alive) setResult({ date: today, activity: data });
    }).catch(cause => {
      if (alive) setResult({ date: today, error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { alive = false; };
  }, [api, dayStarts, revision, today]);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const offset: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7, Home: -index, End: days.length - 1 - index };
    if (offset[event.key] === undefined) return;
    event.preventDefault();
    const next = days[Math.max(0, Math.min(days.length - 1, index + offset[event.key]))];
    setSelectedDate(next.date);
    scroller.current?.querySelector<HTMLElement>(`[data-date="${next.date}"]`)?.focus();
  }

  const activeDays = activity?.filter(day => total(day) > 0).length;
  return <div className="note-heatmap">
    <div className="heatmap-overview"><span>最近 365 天</span><span>{activeDays === undefined ? (error ? "统计不可用" : "读取中…") : `${activeDays} 天有创建或修改`}</span></div>
    <div className="heatmap-scroll" ref={scroller}>
      <div className="heatmap-grid" role="group" aria-label="按周排列的笔记热力图" style={{ "--heatmap-weeks": end.week + 1 } as CSSProperties}>
        {months.map((day, index) => (months[index + 1]?.week ?? end.week + 4) - day.week >= 3 && <span className="heatmap-month" key={day.date} style={{ gridColumn: day.week + 2, gridRow: 1 }}>{Number(day.date.slice(5, 7))}月</span>)}
        {weekdays.map(([label, weekday]) => <span className="heatmap-weekday" key={label} aria-hidden="true" style={{ gridColumn: 1, gridRow: weekday + 2 }}>{label}</span>)}
        {days.map(({ date, week, weekday }, index) => {
          const day = activity?.[index];
          const count = day ? total(day) : 0;
          const level = count === 0 ? 0 : count === 1 ? 1 : count < 4 ? 2 : count < 7 ? 3 : 4;
          const label = day ? `${date}，${count} 篇笔记` : date;
          return <button type="button" key={date} data-date={date} data-heat={level} title={label} aria-label={label} aria-current={date === today ? "date" : undefined} aria-pressed={date === selected} tabIndex={date === selected ? 0 : -1}
            style={{ gridColumn: week + 2, gridRow: weekday + 2 }} onClick={() => setSelectedDate(date)} onKeyDown={event => navigate(event, index)}/>;
        })}
      </div>
    </div>
    <div className="heatmap-selection">
      <span aria-live="polite"><time dateTime={selected}>{selected}</time>{selectedDay && <span className="heatmap-count">创建 {selectedDay.created} 篇 · 最近修改 {selectedDay.edited} 篇</span>}</span>
      <span className="note-heatmap-scale" aria-label="当天创建或最后修改的笔记数量从少到多">少{levels.map((label, level) => <i key={label} data-heat={level} title={label} aria-hidden="true"/>)}多</span>
    </div>
    {error && <p className="heatmap-message" role="status">无法统计笔记文件日期。{error}</p>}
    {activeDays === 0 && <p className="heatmap-message">最近一年没有符合范围的笔记。</p>}
  </div>;
}
