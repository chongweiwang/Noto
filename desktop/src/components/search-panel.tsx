"use client";
// Compact snippets, 200ms debounce and keyboard selection reference Noteriv's
// VaultSearch (MIT). Files/ranges and cancellation use Noto's shared snapshots.
import {useEffect,useId,useMemo,useRef,useState} from "react";
import {searchQuery,type SearchChoice,type SearchContext,type SearchFile,type SearchHit,type SearchLocal,type SearchResults} from "../lib/note-search";
import type {Snapshot} from "../lib/knowledge";
import { replaceSearchMatches, type SearchOptions } from "../lib/search-options";
import { parseTagFilters } from "../lib/note-tags";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";
import { previewPdf } from "../lib/ui-actions";
import type { AttachmentHit } from "../lib/attachment-search";
import type { Note } from "../lib/vault-api";
import { attachSearchSources, type VaultAnswer } from "../lib/vault-analysis";
import { useVaultAnalysis, type VaultAnalysisClient } from "../lib/vault-analysis-client";

export interface Replacement { note: Note; content: string; hits: number; offset: number }
const keyOf=(choice:SearchChoice)=>choice.file.path+"::"+(choice.hit?.key??"file");
function Snippet({hit}:{hit:SearchHit}){
 const text=hit.snippet;return <>{text.leading?"…":""}{text.text.slice(0,text.from)}<mark>{text.text.slice(text.from,text.to)}</mark>{text.text.slice(text.to)}{text.trailing?"…":""}</>;
}
export function SearchPanel({snapshot,paths,attachmentPaths,onOpen,onChoose,onContext,onClose,local,onGlobal,onReplace,analysis}:{
 snapshot:Snapshot&{loading:boolean};paths?:string[];onOpen?:(path:string)=>void;onChoose?:(choice:SearchChoice)=>void;
 onContext?:(context:SearchContext|null)=>void;onClose:()=>void;local?:SearchLocal|null;onGlobal?:()=>void;
 attachmentPaths?: string[]; onReplace?: (items: Replacement[]) => Promise<{ saved: number; skipped: string[] }>;
 analysis?: VaultAnalysisClient;
}){
 const {api}=useWorkspaceRuntime();
 const localAnalysis=useVaultAnalysis();
 const background=analysis??localAnalysis;
 const [query,setQuery]=useState(""),[composing,setComposing]=useState(false),[batch,setBatch]=useState<{context:SearchContext;result:SearchResults}|null>(null);
 const [options,setOptions]=useState<SearchOptions>({});
 const [replacement,setReplacement]=useState(""),[plan,setPlan]=useState<Replacement[]|null>(null),[applying,setApplying]=useState(false),[replaceReport,setReplaceReport]=useState<{saved:number;skipped:string[]}|null>(null);
 const [attachmentResult,setAttachmentResult]=useState<{matches:AttachmentHit[];failed:string[];partial:boolean}|null>(null),[attachmentBusy,setAttachmentBusy]=useState(false),[attachmentError,setAttachmentError]=useState("");
 const attachmentFlight=useRef<AbortController|null>(null);
 const [searching,setSearching]=useState(false),[error,setError]=useState(""),[limit,setLimit]=useState(200),[collapsed,setCollapsed]=useState<Set<string>>(new Set()),[selected,setSelected]=useState("");
 const callbacks=useRef({onOpen,onChoose,onContext,onClose});callbacks.current={onOpen,onChoose,onContext,onClose};
 const list=useRef<HTMLDivElement>(null),id=useId(),wanted=options.regex?query:searchQuery(query),pathsKey=(paths??snapshot.notes.map(note=>note.path)).join("\0");
 const context=useMemo<SearchContext>(()=>({query:wanted,options}),[wanted,pathsKey,local,options]);
 const constrained=!local&&Boolean(options.tag||options.property||options.folder);
 const attachmentKey=attachmentPaths?.join("\0");
 useEffect(()=>{
  setAttachmentResult(null);setAttachmentBusy(false);setAttachmentError("");
  return ()=>attachmentFlight.current?.abort();
 },[context,attachmentKey]);
 useEffect(()=>{
  callbacks.current.onContext?.(composing?null:context);
  return ()=>callbacks.current.onContext?.(null);
 },[context,composing]);
 useEffect(()=>{setLimit(200);setCollapsed(new Set());setSelected("");},[context]);
 useEffect(()=>{
  const job=new AbortController();setError("");
  if(composing||!wanted&&!constrained){setSearching(false);setBatch(null);return;}
  setSearching(true);
  const timer=setTimeout(()=>{
   const notes=local?[local.note]:snapshot.notes,files=local?[local.note.path]:pathsKey?pathsKey.split("\0"):[];
   const sources=new Map(notes.map(note=>[note.path,note]));
   const show=(answer:VaultAnswer)=>{
    if(!job.signal.aborted&&answer.kind==="search")setBatch({context,result:attachSearchSources(answer.result,sources)});
   };
   void background.run({kind:"search",paths:files,query:wanted,options:local?{regex:options.regex,caseSensitive:options.caseSensitive}:options},notes,job.signal,show).then(answer=>{
    if(!job.signal.aborted){show(answer);setSearching(false);}
   }).catch(cause=>{if(!job.signal.aborted){setSearching(false);setError(cause instanceof Error?cause.message:String(cause));}});
  },200);
  return ()=>{job.abort();clearTimeout(timer);};
 },[background,context,snapshot.notes,local,pathsKey,wanted,composing,options,constrained]);
 const result=!composing&&batch?.context===context?batch.result:null;
 const choices:SearchChoice[]=[],groups:{file:SearchFile;hits:SearchHit[]}[]=[];let remaining=limit;
 for(const file of result?.files??[]){
  if(remaining<=0)break;
  remaining--;
  if(file.pathMatched)choices.push({context,file});
  const hits=collapsed.has(file.path)?[]:file.hits.slice(0,remaining);remaining-=hits.length;groups.push({file,hits});
  choices.push(...hits.map(hit=>({context,file,hit})));
 }
 const current=choices.findIndex(choice=>keyOf(choice)===selected),index=current>=0?current:Math.max(0,choices.findIndex(choice=>!!choice.hit)),active=choices[index];
 const choose=(choice:SearchChoice|undefined)=>{if(!choice||composing)return;setSelected(keyOf(choice));if(callbacks.current.onChoose)callbacks.current.onChoose(choice);else callbacks.current.onOpen?.(choice.file.path);};
 useEffect(()=>{if(!active)return;[...(list.current?.querySelectorAll<HTMLElement>("[data-search-key]")??[])].find(node=>node.dataset.searchKey===keyOf(active))?.scrollIntoView?.({block:"nearest"});},[active?.file.path,active?.hit?.key]);
 const shownHits=groups.reduce((sum,group)=>sum+group.hits.length,0),hasMore=(result?.files.length??0)>groups.length||groups.some(group=>!collapsed.has(group.file.path)&&group.hits.length<group.file.hits.length);
 const canReplace=!!onReplace&&!local&&!!wanted&&!!result?.hits&&!result.truncated&&!searching&&!snapshot.loading;
 function previewReplacement(){
  if(!canReplace||!result)return;
  setReplaceReport(null);
  setPlan(result.files.flatMap(file=>{
   if(!file.note||!file.hits.length)return [];
   const content=replaceSearchMatches(file.note.content,wanted,options,replacement);
   return content===file.note.content?[]:[{note:file.note,content,hits:file.hits.length,offset:file.hits[0].from}];
  }));
 }
 async function applyReplacement(){
  if(!plan?.length||!onReplace||applying)return;
  setApplying(true);
  try{setReplaceReport(await onReplace(plan));setPlan(null);}
  catch(cause){setReplaceReport({saved:0,skipped:[String(cause)]});setPlan(null);}
  finally{setApplying(false);}
 }
 async function scanAttachments(){
  if(!wanted||!attachmentKey||attachmentBusy)return;
  const job=new AbortController();attachmentFlight.current?.abort();attachmentFlight.current=job;
  setAttachmentBusy(true);setAttachmentResult(null);setAttachmentError("");
  try{
   const {searchAttachments}=await import("../lib/attachment-search");
   const result=await searchAttachments(attachmentKey.split("\0"),wanted,options,api,job.signal);
   if(!job.signal.aborted)setAttachmentResult(result);
  }catch(cause){if(!job.signal.aborted)setAttachmentError(String(cause));}
  finally{if(!job.signal.aborted)setAttachmentBusy(false);}
 }
 return <div className="knowledge-panel search-panel">
  <div className="knowledge-heading"><strong>搜索笔记</strong><button type="button" onClick={onClose} aria-label="关闭搜索">×</button></div>
  {local&&<div className="search-local"><span>当前内容：{local.note.path}（{local.label}）</span><button type="button" onClick={onGlobal}>返回全库结果</button></div>}
  <div className="knowledge-input"><input autoFocus type="search" aria-label="搜索笔记" aria-controls={id} placeholder="搜索文件名或内容" value={query}
   onCompositionStart={()=>{setComposing(true);callbacks.current.onContext?.(null);}} onCompositionEnd={()=>setComposing(false)}
   onChange={event=>{callbacks.current.onContext?.(null);setQuery(event.target.value);}}
   onKeyDown={event=>{
    if(event.nativeEvent.isComposing||composing||event.keyCode===229)return;
    if(event.key==="Escape"){event.preventDefault();onClose();}
    else if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();const next=choices[Math.max(0,Math.min(choices.length-1,index+(event.key==="ArrowDown"?1:-1)))];if(next)setSelected(keyOf(next));}
    else if(event.key==="Enter"){event.preventDefault();choose(active);}
   }}/></div>
  <details className="advanced-search"><summary>高级搜索与替换</summary>
   <div className="advanced-fields">
    <label><input type="checkbox" checked={!!options.regex} onChange={event=>setOptions({...options,regex:event.target.checked})}/> 正则表达式</label>
    <label><input type="checkbox" checked={!!options.caseSensitive} onChange={event=>setOptions({...options,caseSensitive:event.target.checked})}/> 区分大小写</label>
    {!local&&<><label>目录<input value={options.folder??""} placeholder="项目/资料" onChange={event=>setOptions({...options,folder:event.target.value.trim()})}/></label>
    <label>标签<input value={options.tag??""} placeholder="#NAS, #Docker" onChange={event=>setOptions({...options,tag:event.target.value})}/></label>
    {parseTagFilters(options.tag??"").length>1&&<label>标签组合方式<select value={options.tagMode??"all"}
      onChange={event=>setOptions({...options,tagMode:event.target.value==="any"?"any":"all"})}>
      <option value="all">全部匹配</option><option value="any">任意匹配</option>
    </select></label>}
    <label>YAML 属性<input value={options.property??""} placeholder="状态=进行中" onChange={event=>setOptions({...options,property:event.target.value})}/></label>
    {onReplace&&<><label>替换为<input value={replacement} maxLength={4096} onChange={event=>setReplacement(event.target.value)}/></label><button type="button" disabled={!canReplace} onClick={previewReplacement}>预览批量替换</button></>}
    {!!attachmentPaths?.length&&<div><button type="button" disabled={!wanted||attachmentBusy||!!options.tag||!!options.property} onClick={()=>void scanAttachments()}>搜索 PDF 和文本附件</button>
    {attachmentBusy&&<button type="button" onClick={()=>{attachmentFlight.current?.abort();setAttachmentBusy(false);}}>停止附件搜索</button>}</div>}</>}
   </div>
  </details>
  {choices.length>0&&<div className="search-navigation"><button type="button" aria-label="上一处搜索结果" disabled={index<=0} onClick={()=>choose(choices[index-1])}>↑</button><span>{index+1} / {choices.length} 项已显示结果</span><button type="button" aria-label="下一处搜索结果" disabled={index>=choices.length-1} onClick={()=>choose(choices[index+1])}>↓</button></div>}
  <div className="knowledge-results" id={id} ref={list} aria-live="polite">
   {error&&<p role="alert">{error}</p>}
   {(snapshot.loading&&!local)&&<p className="knowledge-empty">正在读取知识库，结果可能尚未更新…</p>}
   {searching&&<p className="knowledge-empty">{result?"正在刷新搜索结果…":"正在搜索…"}</p>}
   {composing?<p className="knowledge-empty">等待输入完成…</p>:result&&<>
    {!result.files.length&&!snapshot.loading
     ? <p className="knowledge-empty">没有找到匹配的笔记。</p>
     : <p className="knowledge-count">找到 {result.files.length} 篇笔记，{result.truncated?"至少 ":""}{result.hits} 处正文命中</p>}
    {groups.map(({file,hits})=><section className="search-file" key={file.path} aria-label={"搜索结果："+file.path}>
     <div className="search-file-heading">{file.hits.length>0&&<button type="button" className="search-fold" aria-label={(collapsed.has(file.path)?"展开 ":"折叠 ")+file.path+" 的命中"} aria-expanded={!collapsed.has(file.path)} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);if(next.has(file.path))next.delete(file.path);else next.add(file.path);return next;})}>{collapsed.has(file.path)?"▸":"▾"}</button>}
      <button type="button" className={"search-file-open"+(active?.file.path===file.path&&!active.hit?" selected":"")} title={file.path} aria-label={file.path+(file.pathMatched?"，文件名匹配":"，打开文件")} data-search-key={file.pathMatched?file.path+"::file":undefined} onMouseEnter={()=>{if(file.pathMatched)setSelected(file.path+"::file");}} onClick={()=>choose({context,file})}>{file.path}</button>
      <small>{file.unread?"正文未知":file.hits.length+(file.truncated?"+":"")+" 处"}</small></div>
     {file.pathMatched&&<small className="search-file-note">文件名匹配</small>}{file.unread&&<small className="search-file-note">正文未读取，匹配情况未知</small>}
     {hits.map(hit=><button type="button" key={hit.key} className={"knowledge-result search-match"+(active?.file.path===file.path&&active.hit?.key===hit.key?" selected":"")} data-search-key={file.path+"::"+hit.key} aria-label={file.path+" 第 "+hit.line+" 行，第 "+hit.column+" 列："+hit.snippet.text} onMouseEnter={()=>setSelected(file.path+"::"+hit.key)} onClick={()=>choose({context,file,hit})}>
      <small>第 {hit.line} 行，列 {hit.column}</small><span><Snippet hit={hit}/></span></button>)}
     {file.truncated&&<small className="search-file-note">该文件命中已截断，请缩小关键词。</small>}
    </section>)}
    {hasMore&&<p className="knowledge-hint">当前显示 {groups.length} 篇、{shownHits} 处正文命中。</p>}
    {hasMore&&<button type="button" className="search-more" onClick={()=>setLimit(previous=>previous+200)}>显示更多已收集结果</button>}
    {result.truncated&&<p className="knowledge-hint">结果已截断{result.unscanned?"；"+result.unscanned+" 篇尚未检索":""}，数量不是全库完整总数。</p>}
   </>}
   {!local&&snapshot.errors.length>0&&<details className="knowledge-warnings"><summary>{snapshot.errors.length} 篇笔记无法读取</summary>{snapshot.errors.map(item=><p key={item.path}>{item.path}：{item.error}</p>)}</details>}
   {attachmentBusy&&<p role="status">正在扫描附件…</p>}
   {attachmentError&&<p role="alert">{attachmentError}</p>}
   {attachmentResult&&<section className="search-file" aria-label="附件搜索结果">
    <p>附件命中 {attachmentResult.matches.length} 处{attachmentResult.partial?"，已达到显示上限":""}</p>
    {attachmentResult.matches.map(({path,page,match})=><button type="button" className="knowledge-result search-match" key={JSON.stringify([path,page,match.key])}
      onClick={()=>page?previewPdf(path,"page="+page):void api.openItem(path).catch(cause=>setAttachmentError(String(cause)))}>
      <small>{path} · {page?"第 "+page+" 页":"第 "+match.line+" 行"}</small><span><Snippet hit={match}/></span></button>)}
    {!!attachmentResult.failed.length&&<details><summary>{attachmentResult.failed.length} 个附件无法读取</summary>{attachmentResult.failed.map(path=><p key={path}>{path}</p>)}</details>}
   </section>}
   {replaceReport&&<div role="status">已替换 {replaceReport.saved} 篇{replaceReport.skipped.length>0&&<details open><summary>跳过 {replaceReport.skipped.length} 项</summary>{replaceReport.skipped.map(text=><p key={text}>{text}</p>)}</details>}</div>}
  </div>
  {plan&&<div className="modal-backdrop"><div className="modal batch-replace" role="dialog" aria-modal="true" aria-label="批量替换预览" onKeyDown={event=>{if(event.key==="Escape"&&!applying)setPlan(null);}}>
   <h2>批量替换预览</h2><p>{plan.length} 篇笔记将更改。应用时逐篇核对保存版本与草稿。</p>
   <div className="batch-replace-list">{plan.map(item=><details key={item.note.path}><summary>{item.note.path} · {item.hits} 处</summary>
    <pre>{item.note.content.slice(Math.max(0,item.offset-25),item.offset+90)}</pre><pre>{item.content.slice(Math.max(0,item.offset-25),item.offset+90)}</pre></details>)}</div>
   <div className="modal-actions"><button type="button" autoFocus disabled={applying} onClick={()=>setPlan(null)}>取消</button><button className="primary" type="button" disabled={applying||!plan.length} onClick={()=>void applyReplacement()}>{applying?"正在替换…":"应用替换"}</button></div>
  </div></div>}
 </div>;
}
