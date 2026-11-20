"use client";
import { useEffect, useRef, useState } from "react";
import type { ExportDocument, ExportSnapshot } from "../lib/note-export";
import { standardExportLabel, standardExportPreset, type ExportPreset } from "../lib/export-presets";
import { readyExportFrame, downloadExportHtml } from "../lib/export-output";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";

export function ExportDialog({ snapshot, batch, error: sourceError, presets, defaultPreset, onClose, onRefresh }: {
  snapshot: ExportSnapshot | null; batch?: ExportSnapshot[]; error: string;
  presets: ExportPreset[]; defaultPreset: string;
  onClose: () => void; onRefresh: () => void;
}) {
  const runtime=useWorkspaceRuntime();
  const [presetName, setPresetName] = useState(defaultPreset);
  const preset = presets.find(item => item.name === presetName) ?? standardExportPreset;
  const [document,setDocument]=useState<ExportDocument|null>(null), [error,setError]=useState(""),[outputError,setOutputError]=useState(""),[notice,setNotice]=useState("");
  const [ready,setReady]=useState(false),[accepted,setAccepted]=useState(false),[output,setOutput]=useState(false);
  const frame=useRef<HTMLIFrameElement>(null), panel=useRef<HTMLDivElement>(null),close=useRef<HTMLButtonElement>(null);
  const controller=useRef<AbortController|null>(null), alive=useRef(true), flight=useRef(false);
  useEffect(()=>{
    alive.current=true;
    const previous=globalThis.document.activeElement as HTMLElement|null;
    close.current?.focus();
    return ()=>{alive.current=false;controller.current?.abort();previous?.isConnected&&previous.focus();};
  },[]);
  useEffect(()=>{
    const abort=new AbortController();controller.current?.abort();controller.current=abort;
    setDocument(null);setReady(false);setError("");setOutputError("");setNotice("");setAccepted(false);
    if(snapshot||batch) void import("../lib/note-export").then(({prepareNoteExport,prepareMergedNoteExport})=>batch?prepareMergedNoteExport(batch,runtime.api,{signal:abort.signal,preset}):prepareNoteExport(snapshot!,runtime.api,{signal:abort.signal,preset})).then((value)=>{
      if(!abort.signal.aborted)setDocument(value);
    }).catch((cause)=>{
      if(!abort.signal.aborted) { setError(cause instanceof Error?cause.message:String(cause));abort.abort(); }
    });
    return ()=>abort.abort();
  },[snapshot,batch,runtime.api,preset]);
  function closeDialog(){if(!flight.current)onClose();}
  async function loaded(){
    const element=frame.current, abort=controller.current, expected=document;
    if(!element||!abort||!expected||!element.contentDocument?.querySelector('meta[http-equiv="Content-Security-Policy"]')) return;
    try {
      await readyExportFrame(element,abort.signal);
      if(!abort.signal.aborted&&alive.current) {
        element.contentDocument?.addEventListener("keydown",(event)=>{if(event.key==="Escape"){event.preventDefault();closeDialog();}});
        element.contentDocument?.addEventListener("click",(event)=>{
          const anchor=(event.target as Element)?.closest("a");
          if(anchor&&!anchor.getAttribute("href")?.startsWith("#")) event.preventDefault();
        });
        setReady(true);
      }
    } catch(cause) {if(!abort.signal.aborted&&alive.current)setError(cause instanceof Error?cause.message:String(cause));}
  }
  const allowed=!!document&&ready&&!sourceError&&!error&&(!document.warnings.length||accepted);
  const sources=batch??(snapshot?[snapshot]:[]);
  const sourceStatus=sources.some(item=>item.conflict)?"当前本地冲突快照 · 原文和草稿仍保留":
    sources.some(item=>item.unsaved)?"当前编辑快照 · 包含未保存内容":batch?"所选笔记的合并快照":
    snapshot?"当前编辑快照":sourceError?"读取来源失败":"正在准备编辑快照…";
  async function save(){
    if(!document||!allowed||flight.current)return;
    const current=document,abort=controller.current;
    flight.current=true;setOutput(true);setNotice("");setOutputError("");
    try {
      if(runtime.kind==="desktop") {
        if(!runtime.saveExportHtml)throw new Error("当前环境没有原生导出保存能力");
        const path=await runtime.saveExportHtml(current.html,current.name);
        if(alive.current&&!abort?.signal.aborted)setNotice(path?"HTML 已保存："+path:"已取消保存。");
      } else {downloadExportHtml(current.html,current.name);setNotice("已发起 HTML 下载，请查看浏览器下载列表。");}
    } catch(cause){if(alive.current&&!abort?.signal.aborted)setOutputError(cause instanceof Error?cause.message:String(cause));}
    finally{flight.current=false;if(alive.current)setOutput(false);}
  }
  function print(){
    if(!allowed||!frame.current?.contentWindow||flight.current)return;
    flight.current=true;setOutput(true);setNotice("");setOutputError("");
    try {frame.current.contentWindow.focus();frame.current.contentWindow.print();setNotice("已请求打印；请在对话框中选择另存为 PDF。");}
    catch(cause){setOutputError("无法打开打印对话框："+(cause instanceof Error?cause.message:String(cause)));}
    finally {flight.current=false;setOutput(false);}
  }
  const htmlButton = <button type="button" className={preset.format === "html" ? "primary" : undefined} disabled={!allowed || output} onClick={() => { void save(); }}>导出 HTML</button>;
  const pdfButton = <button type="button" className={preset.format === "pdf" ? "primary" : undefined} disabled={!allowed || output} onClick={print}>打印 / 另存 PDF</button>;
  return <div className="modal-backdrop export-backdrop"><div ref={panel} className="export-dialog" role="dialog" aria-modal="true" aria-label="本地导出" onKeyDown={(event)=>{
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();closeDialog();}
    if(event.key==="Tab"){
      const elements=[...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),iframe")??[])],first=elements[0],last=elements.at(-1);
      if(event.shiftKey&&globalThis.document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&globalThis.document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }}>
    <header><div><h2>本地导出</h2><p>{batch?`合并 ${batch.length} 篇笔记`:snapshot?.path??"正在等待来源附件导入…"}</p></div><button ref={close} type="button" aria-label="关闭导出预览" disabled={output} onClick={closeDialog}>×</button></header>
    <div className="export-summary"><span>{sourceStatus}</span><div className="export-toolbar">
      {presets.length > 0 && <label className="export-preset-select">导出预设<select value={preset.name} disabled={output} onChange={event => {
        controller.current?.abort();
        setReady(false);
        setPresetName(event.target.value);
      }}>
        <option value="">{standardExportLabel}</option>
        {presets.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select></label>}
      <button type="button" disabled={output} onClick={onRefresh}>更新预览</button>
    </div></div>
    {(sourceError||error||outputError)&&<p className="error" role="alert">{sourceError||error||outputError}{!sourceError&&!error&&outputError&&"；可再次选择导出或打印以重试。"}</p>}
    {!document&&!error&&!sourceError&&<p role="status">正在准备正文、图片、白板、公式和图表…</p>}
    {!!document?.warnings.length&&<div className="export-warnings"><details open><summary>有 {document.warnings.length} 项内容需要注意</summary><ul>{document.warnings.map((warning,index)=><li key={index}>{warning.path&&warning.path+" · "}第 {warning.line} 行：{warning.message}</li>)}</ul></details><label><input type="checkbox" checked={accepted} onChange={(event)=>setAccepted(event.target.checked)}/>我已查看，仍然导出（保留错误说明或源码）</label></div>}
    {document&&<iframe ref={frame} className="export-preview-frame" title="导出文档预览" sandbox="allow-same-origin allow-modals" srcDoc={document.html} onLoad={()=>{void loaded();}}/>}
    <footer><span role="status">{notice||(document?ready?"文档已就绪 · "+(document.bytes/1024).toFixed(1)+" KiB":"正在等待图片与字体…":"")}</span><div>
      <button type="button" disabled={output} onClick={closeDialog}>取消</button>
      {preset.format === "pdf" ? <>{htmlButton}{pdfButton}</> : <>{pdfButton}{htmlButton}</>}
    </div></footer>
  </div></div>;
}
