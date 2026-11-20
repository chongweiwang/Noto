"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryEntry, HistorySnapshot } from "../lib/vault-api";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";
import { historyDiff } from "../lib/file-history-diff";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export function FileHistoryDialog({path,content,blocked,restoring,onRestore,onClose}:{path:string;content:string;blocked:string;restoring:boolean;onRestore:(snapshot:HistorySnapshot,expected:string)=>Promise<void>;onClose:()=>void}) {
  const { api } = useWorkspaceRuntime();
  const [entries,setEntries] = useState<HistoryEntry[]>([]), [selected,setSelected] = useState<HistoryEntry|null>(null);
  const [snapshot,setSnapshot] = useState<HistorySnapshot|null>(null), [error,setError] = useState("");
  const [loading,setLoading] = useState(true), [reading,setReading] = useState(false), [revision,setRevision] = useState(0), [mode,setMode] = useState<"preview"|"diff">("diff");
  const panel = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  useEffect(()=>{close.current?.focus();},[]);
  useEffect(()=>{
    let alive = true; setLoading(true); setError(""); setSnapshot(null); setSelected(null);
    void api.fileHistory!(path).then(value=>{if(alive){setEntries(value);setSelected(value[0]?{...value[0]}:null);}}).catch(cause=>{if(alive)setError(message(cause));}).finally(()=>{if(alive)setLoading(false);});
    return ()=>{alive=false;};
  },[api,path,revision]);
  useEffect(()=>{
    let alive = true; setSnapshot(null);
    if(!selected){setReading(false);return;}
    setReading(true);setError("");
    void api.readHistory!(path,selected.id).then(value=>{if(alive)setSnapshot(value);}).catch(cause=>{if(alive)setError(message(cause));}).finally(()=>{if(alive)setReading(false);});
    return ()=>{alive=false;};
  },[api,path,selected]);
  const diff = useMemo(()=>snapshot?historyDiff(snapshot.content,content):null,[snapshot,content]);
  const tooLarge = useMemo(()=>new TextEncoder().encode(content).length>2*1024*1024,[content]);
  const reason = blocked || (tooLarge?"当前内容超过 2 MiB，请先另存后再还原。":"");
  return <div className="modal-backdrop"><div ref={panel} className="file-history-dialog" role="dialog" aria-modal="true" aria-labelledby="file-history-title" onKeyDown={event=>{
    if(event.key==="Escape"){event.stopPropagation();event.preventDefault();if(!restoring)onClose();}
    if(event.key==="Tab"){
      const items=[...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),[tabindex='0']")??[])],first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }}>
    <header><div><h2 id="file-history-title">文件恢复</h2><p title={path}>{path}</p></div><button ref={close} type="button" disabled={restoring} onClick={onClose}>关闭</button></header>
    <p className="history-policy">自动保留保存前的内容，间隔至少 5 分钟。最近 7 天，每篇最多 20 份、合计 16 MiB；支持不超过 2 MiB 的 Markdown 笔记，较大笔记仍可正常保存。</p>
    {error&&<p className="error" role="alert">{error} <button type="button" disabled={restoring} onClick={()=>setRevision(value=>value+1)}>重试</button></p>}
    <div className="history-body" aria-busy={loading||reading}>
      <nav className="history-list" aria-label="近期快照">
        {loading?<p role="status">正在读取快照…</p>:!entries.length?<p>暂无快照</p>:entries.map(entry=><button type="button" key={entry.id} aria-pressed={selected?.id===entry.id} disabled={restoring} onClick={()=>setSelected(entry)}><time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString()}</time><small>{entry.reason==="restore"?"还原前保护":"保存前快照"} · {Math.max(1,Math.ceil(entry.size/1024))} KB</small></button>)}
      </nav>
      <section className="history-detail" aria-label="快照内容">
        <div className="history-toolbar"><button type="button" aria-pressed={mode==="preview"} onClick={()=>setMode("preview")}>预览</button><button type="button" aria-pressed={mode==="diff"} onClick={()=>setMode("diff")}>差异对比</button></div>
        {reading?<p role="status">正在读取内容…</p>:snapshot?<>
          {mode==="diff"?<><p className="history-legend">快照 → 当前编辑内容（含未保存修改）<span>− 快照中原有</span><span>+ 当前新增</span></p><pre className="history-diff" tabIndex={0} aria-label="快照与当前编辑的差异">{diff?.lines.map((line,index)=><span key={index} className={"history-line "+line.kind}>{line.kind==="add"?"+":line.kind==="remove"?"−":" "} {line.text}</span>)}</pre>{diff?.limited&&<p className="history-limit">内容较多，已简化或截断显示；还原仍使用完整快照。</p>}</>:<><pre className="history-preview" tabIndex={0} aria-label="快照原文">{snapshot.content.slice(0,120000)}</pre>{snapshot.content.length>120000&&<p className="history-limit">预览已截断；还原仍使用完整快照。</p>}</>}
        </>:!loading&&<p>选择一份快照查看内容。</p>}
      </section>
    </div>
    <footer><p>{reason || "还原前会保护当前文件和未保存编辑。还原后按原设置自动保存，可用 Ctrl+Z 撤销。"}</p><button type="button" className="primary" disabled={restoring||!!reason||!snapshot||reading||loading||snapshot.content===content} onClick={()=>{if(snapshot)void onRestore(snapshot,content).catch(cause=>setError(message(cause)));}}>{restoring?"正在保护并还原…":"还原到编辑器"}</button></footer>
  </div></div>;
}
