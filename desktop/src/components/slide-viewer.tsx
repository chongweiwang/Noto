"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { splitSlides } from "../lib/slides";
import { MarkdownPreview } from "./markdown-preview";
import type { ExportSnapshot } from "../lib/note-export";

export function SlideViewer({ snapshot, onClose, onOpenNote, onWikiOpen }: {
  snapshot:ExportSnapshot; onClose:()=>void; onOpenNote:(path:string,anchor?:string)=>void;
  onWikiOpen:(target:string,source?:string,chosen?:string)=>void;
}) {
  const slides=useMemo(()=>splitSlides(snapshot.content),[snapshot.content]);
  const panel=useRef<HTMLDivElement>(null);
  const [index,setIndex]=useState(0),[notes,setNotes]=useState(false),[error,setError]=useState("");
  const slide=slides[index];
  useEffect(()=>{
    const original=document.activeElement;
    panel.current?.focus();
    return ()=>{if(original instanceof HTMLElement&&original.isConnected)original.focus();};
  },[]);
  const previous=()=>setIndex(value=>Math.max(0,value-1));
  const next=()=>setIndex(value=>Math.min(slides.length-1,value+1));
  return <div className="modal-backdrop slides-backdrop"><div className="slides-viewer" role="dialog" aria-modal="true" aria-label="Markdown 幻灯片" ref={panel} tabIndex={-1} onKeyDown={event=>{
    if(event.key==="Escape"){event.stopPropagation();onClose();return;}
    if(event.altKey||event.ctrlKey||event.metaKey||event.nativeEvent.isComposing)return;
    if(event.key==="Tab"){
      const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],summary")??[]);
      const first=nodes[0],last=nodes.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      return;
    }
    if(event.key===" "&&(event.target as HTMLElement).closest("button,a,summary"))return;
    const action:Record<string,()=>void>={ArrowLeft:previous,PageUp:previous,ArrowRight:next,PageDown:next," ":next,Home:()=>setIndex(0),End:()=>setIndex(slides.length-1)};
    if(Object.hasOwn(action,event.key)){event.preventDefault();action[event.key]();}
  }}>
    <header><strong title={snapshot.path}>{snapshot.path.split("/").at(-1)}</strong><button type="button" onClick={previous} disabled={index===0}>上一张</button><span aria-live="polite">{index+1} / {slides.length}</span><button type="button" onClick={next} disabled={index+1===slides.length}>下一张</button>
      <button type="button" aria-pressed={notes} onClick={()=>setNotes(!notes)} disabled={!slide.notes}>演讲备注</button><button type="button" onClick={onClose}>结束放映</button></header>
    {error&&<p role="alert">{error}</p>}
    <MarkdownPreview key={index} note={snapshot.path} content={slide.content} wikiPaths={snapshot.paths} drawingPaths={snapshot.drawingPaths} onError={setError} checkboxesDisabled
      onOpenNote={(path,anchor)=>{onClose();onOpenNote(path,anchor);}}
      onWikiOpen={(target,source,chosen)=>{onClose();onWikiOpen(target,source,chosen);}}/>
    {notes&&slide.notes&&<aside aria-label="演讲备注">{slide.notes}</aside>}
  </div></div>;
}
