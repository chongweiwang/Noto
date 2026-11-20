"use client";
import { useMemo, useState } from "react";

export function BatchExportPicker({ paths, current, onConfirm, onClose }: {
  paths:string[]; current:string|null; onConfirm:(paths:string[])=>void; onClose:()=>void;
}) {
  const [query,setQuery]=useState(""),[selection,setSelection]=useState(()=>current&&paths.includes(current)?[current]:[]);
  const matches=useMemo(()=>paths.filter(path=>path.toLowerCase().includes(query.trim().toLowerCase())),[paths,query]);
  const [limit,setLimit]=useState(200);
  function move(index:number,delta:number){
    setSelection(items=>{
      const target=index+delta;
      if(target<0||target>=items.length)return items;
      const next=[...items];[next[index],next[target]]=[next[target],next[index]];return next;
    });
  }
  return <div className="modal-backdrop"><div className="modal batch-export" role="dialog" aria-modal="true" aria-label="选择合并导出的笔记" onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();onClose();}}}>
    <h2>多篇合并导出</h2>
    <input type="search" autoFocus aria-label="筛选导出的笔记" placeholder="筛选笔记路径" value={query} onChange={event=>{setQuery(event.target.value);setLimit(200);}}/>
    <div className="batch-export-paths">
      {matches.slice(0,limit).map(path=><label key={path}><input type="checkbox" checked={selection.includes(path)} onChange={event=>setSelection(items=>event.target.checked?[...items,path]:items.filter(item=>item!==path))}/> {path}</label>)}
      {!matches.length&&<p>没有匹配的笔记。</p>}
      {matches.length>limit&&<button type="button" onClick={()=>setLimit(value=>value+200)}>显示更多笔记</button>}
    </div>
    <h3>导出顺序 · {selection.length} 篇</h3>
    <ol className="batch-export-order">{selection.map((path,index)=><li key={path}><span>{path}</span><button type="button" disabled={index===0} aria-label={path+" 上移"} onClick={()=>move(index,-1)}>↑</button><button type="button" disabled={index===selection.length-1} aria-label={path+" 下移"} onClick={()=>move(index,1)}>↓</button></li>)}</ol>
    <div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={selection.length<2} onClick={()=>onConfirm(selection)}>生成预览</button></div>
  </div></div>;
}
