"use client";

import { useEffect, useMemo, useState } from "react";
import { ScanWarnings, useKnowledgeSnapshot } from "./knowledge-sidebar";
import { useVaultAnalysis, type VaultAnalysisClient } from "../lib/vault-analysis-client";
import type { VaultStatistics } from "../lib/vault-analysis";
import type { Note } from "../lib/vault-api";

const number = (value: number) => value.toLocaleString("zh-CN");

export function DashboardPanel({ vault, paths, revision, generation, busy, onOpen, analysis }: {
  vault: string | null; paths: string[]; revision: number; generation: { current: number };
  busy: boolean; onOpen: (path: string) => void;
  analysis?: VaultAnalysisClient;
}) {
  const localAnalysis = useVaultAnalysis(vault ?? undefined);
  const background = analysis ?? localAnalysis;
  const [scope, setScope] = useState("");
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
  const stats = settled?.stats ?? (calculated?.paths === scopedPaths && snapshot.notes.length ? calculated.stats : undefined);
  const waiting = scopedPaths.length > 0 && !stats && (snapshot.loading || snapshot.notes.length > 0 && !settled);
  const unavailable = !!settled?.error || snapshot.errors.length > 0 && snapshot.notes.length === 0;
  const metric = (value?: number) => waiting || unavailable ? "—" : number(value ?? 0);
  const metrics = [
    { label: "笔记", value: number(scopedPaths.length) },
    { label: "字数", value: metric(stats?.words) },
    { label: "平均每篇字数", value: metric(stats?.averageWords) },
    { label: "标签", value: metric(stats?.tags) },
  ];

  return <div className="dashboard-content">
    {folders.length > 0 && <select className="dashboard-scope" aria-label="统计目录" value={folder} onChange={event => setScope(event.target.value)}>
      <option value="">全部笔记</option>
      <option value="/">根目录笔记</option>
      {folders.map(path => <option key={path} value={path}>{path}/</option>)}
    </select>}
    <dl className="dashboard-stats" aria-label="知识库统计">
      {metrics.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    {waiting && <p className="dashboard-state" role="status">正在统计已保存的笔记…</p>}
    {!waiting && !unavailable && <>
      <section className="dashboard-section" aria-label="常用标签">
        <header><h3>常用标签</h3>{!!stats?.readableNotes && <span>{number(stats.taggedNotes)} / {number(stats.readableNotes)} 篇有标签</span>}</header>
        {stats?.topTags.length ? <ul className="dashboard-list">
          {stats.topTags.map(({ label, count }) => <li className="dashboard-tag" key={label}>
            <span className="dashboard-item-name" title={"#" + label}>#{label}</span><span>{number(count)} 篇</span>
            <span className="dashboard-tag-bar" aria-hidden="true"><span style={{ width: `${count / stats.readableNotes * 100}%` }}/></span>
          </li>)}
        </ul> : <p className="dashboard-state">暂无标签</p>}
      </section>
      <section className="dashboard-section" aria-label="篇幅最长的笔记">
        <h3>篇幅最长的笔记</h3>
        {stats?.longestNotes.length ? <ul className="dashboard-list">
          {stats.longestNotes.map(({ path, words }) => <li key={path}>
            <button type="button" title={path} disabled={busy} onClick={() => onOpen(path)}>
              <span className="dashboard-item-name">{path}</span><span>{number(words)} 字</span>
            </button>
          </li>)}
        </ul> : <p className="dashboard-state">暂无可统计的正文</p>}
      </section>
    </>}
    <ScanWarnings errors={snapshot.errors}/>
    {settled?.error && <p role="status" className="dashboard-state">统计失败。{settled.error}</p>}
  </div>;
}
