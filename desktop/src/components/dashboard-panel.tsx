"use client";

import { useEffect, useMemo, useState } from "react";
import { dateFromDailyPath, localDate } from "../lib/calendar";
import { journalTrend, type JournalTrendRange } from "../lib/vault-statistics";
import { ScanWarnings, useKnowledgeSnapshot } from "./knowledge-sidebar";
import { useVaultAnalysis, type VaultAnalysisClient } from "../lib/vault-analysis-client";
import type { VaultStatistics } from "../lib/vault-analysis";
import type { Note } from "../lib/vault-api";

const ranges = [["week", "7 天"], ["month", "30 天"], ["year", "12 个月"]] as const;
const number = (value: number) => value.toLocaleString("zh-CN");
const emptyStats: VaultStatistics = { words: 0, tags: 0, journal: new Map() };

export function DashboardPanel({ vault, paths, revision, generation, busy, onOpen, analysis }: {
  vault: string | null; paths: string[]; revision: number; generation: { current: number };
  busy: boolean; onOpen: (path: string) => void;
  analysis?: VaultAnalysisClient;
}) {
  const localAnalysis = useVaultAnalysis(vault ?? undefined);
  const background = analysis ?? localAnalysis;
  const [scope, setScope] = useState("");
  const [range, setRange] = useState<JournalTrendRange>("week");
  const folders = useMemo(() => [...new Set(paths.filter(path => path.includes("/")).map(path => path.split("/", 1)[0]))]
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })), [paths]);
  const folder = scope === "/" || folders.includes(scope) ? scope : "";
  const scopedPaths = useMemo(() => folder === "/" ? paths.filter(path => !path.includes("/")) :
    folder ? paths.filter(path => path.startsWith(folder + "/")) : paths, [paths, folder]);
  const snapshot = useKnowledgeSnapshot(vault, scopedPaths, scopedPaths.length > 0, revision, generation);
  const [calculated, setCalculated] = useState<{ paths: string[]; notes: Note[]; stats?: VaultStatistics; error?: string } | null>(null);
  useEffect(() => {
    if (!scopedPaths.length || !snapshot.notes.length) return;
    const job = new AbortController(), notes = snapshot.notes;
    void background.run({kind:"statistics", paths:scopedPaths}, notes, job.signal).then(answer => {
      if (!job.signal.aborted && answer.kind === "statistics") setCalculated({ paths: scopedPaths, notes, stats: answer.stats });
    }).catch(cause => {
      if (!job.signal.aborted) setCalculated({ paths: scopedPaths, notes, error: String(cause) });
    });
    return () => job.abort();
  }, [background, scopedPaths, snapshot.notes]);
  const settled = calculated?.paths === scopedPaths && calculated.notes === snapshot.notes ? calculated : null;
  const stats = settled?.stats ?? (calculated?.paths === scopedPaths && snapshot.notes.length ? calculated.stats : undefined) ?? emptyStats;
  const journals = useMemo(() => scopedPaths.flatMap(path => {
    const date = dateFromDailyPath(path);
    return date ? [{ date, path }] : [];
  }).sort((a, b) => b.date.localeCompare(a.date)), [scopedPaths]);
  const waiting = scopedPaths.length > 0 && (snapshot.loading && !snapshot.notes.length || snapshot.notes.length > 0 && !settled && stats === emptyStats);
  const unavailable = !!settled?.error || snapshot.errors.length > 0 && snapshot.notes.length === 0;
  const metrics = [
    { label: "笔记", value: number(scopedPaths.length) },
    { label: "字数", value: waiting || unavailable ? "—" : number(stats.words) },
    { label: "标签", value: waiting || unavailable ? "—" : number(stats.tags) },
    { label: "日记", value: number(journals.length) },
  ];
  const now = new Date();
  const buckets = journalTrend(stats.journal, now, range);
  const recent = journals.filter(({ date }) => date <= localDate(now)).slice(0, 4);
  const maximum = Math.max(1, ...buckets.map(bucket => bucket.words));
  const written = buckets.reduce((total, bucket) => total + bucket.words, 0);
  const dateRange = `${buckets[0].date} 至 ${buckets[buckets.length - 1].date}`;

  return <div className="dashboard-content">
      {folders.length > 0 && <select className="dashboard-scope" aria-label="统计目录" value={folder} onChange={event => setScope(event.target.value)}>
        <option value="">全部笔记</option>
        <option value="/">根目录笔记</option>
        {folders.map(path => <option key={path} value={path}>{path}/</option>)}
      </select>}
      <dl className="dashboard-stats" aria-label="知识库统计">
        {metrics.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <section className="dashboard-trend" aria-label="日记趋势">
        <header><h3>日记趋势</h3><span>{waiting || unavailable ? "—" : `${number(written)} 字`}</span></header>
        <div className="dashboard-ranges" role="group" aria-label="日记趋势范围">
          {ranges.map(([value, label]) => <button type="button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}
        </div>
        {waiting || unavailable ? <p className="dashboard-trend-state" role="status">{waiting ? "正在统计已保存的笔记…" : "暂时无法读取日记字数"}</p> : written > 0 ?
          <div className="dashboard-bars" role="img" aria-label={`${dateRange}，日记共 ${number(written)} 字`}>
            {buckets.map(({ date, words }) => <div key={date} className="dashboard-bar" title={`${date} · ${number(words)} 字`} aria-hidden="true">
              <span style={{ height: words ? Math.max(4, words / maximum * 100) + "%" : "2px" }} data-empty={words === 0}/>
            </div>)}
          </div> : <p className="dashboard-trend-state">这段时间没有可统计的日记内容</p>}
        <p className="dashboard-date-range">{dateRange}</p>
      </section>
      {recent.length > 0 && <section className="dashboard-recent" aria-label="最近日记">
        <h3>最近日记</h3>
        {recent.map(({ date, path }) => {
          const words = stats.journal.get(date)?.words;
          return <button type="button" key={path} onClick={() => onOpen(path)} disabled={busy}>
            <time dateTime={date}>{date}</time><span>{words === undefined ? "—" : `${number(words)} 字`}</span>
          </button>;
        })}
      </section>}
      <ScanWarnings errors={snapshot.errors}/>
      {settled?.error && <p role="status" className="dashboard-trend-state">统计失败。{settled.error}</p>}
  </div>;
}
