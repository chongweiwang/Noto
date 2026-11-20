"use client";

import { useEffect, useState } from "react";
import type { DocumentHeading } from "../lib/document-info";
import { WorkspaceIcon } from "./workspace-icon";

// Reference: Noteriv OutlinePanel; parsed Markdown also handles setext headings
// and excludes headings inside code/math, with collapsible child branches.
export function OutlinePanel({ headings, position, onJump, onClose, onCopy }: { headings: DocumentHeading[]; position: number; onJump: (heading: DocumentHeading) => void; onClose: () => void; onCopy?:(heading:DocumentHeading)=>void }) {
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [menu,setMenu]=useState<{heading:DocumentHeading;x:number;y:number}|null>(null);
  useEffect(()=>{if(!menu)return;const close=()=>setMenu(null),escape=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!event.isComposing)close();};window.addEventListener("click",close);window.addEventListener("keydown",escape);return ()=>{window.removeEventListener("click",close);window.removeEventListener("keydown",escape);};},[menu]);
  let active = -1;
  headings.forEach((heading, index) => { if (heading.from <= position) active = index; });
  function hidden(index: number): boolean { let parent = headings[index].parent; while (parent !== null) { if (collapsed.includes(headings[parent].from)) return true; parent = headings[parent].parent; } return false; }
  const depth = (index: number) => { let level = 0, parent = headings[index].parent; while (parent !== null) { level++; parent = headings[parent].parent; } return level; };
  return <aside className="outline-panel" aria-label="标题大纲">
    <div className="outline-header"><strong>标题大纲</strong><button type="button" aria-label="收起标题大纲" title="收起（Ctrl+Shift+O）" onClick={onClose}><WorkspaceIcon name="close" size={15}/></button></div>
    <nav className="outline-list" aria-label="笔记标题">
      {!headings.length && <p>这篇笔记还没有标题。</p>}
      {headings.map((heading, index) => !hidden(index) && <div className={`outline-row ${active === index ? "active" : ""}`} style={{ paddingLeft: 5 + depth(index) * 13 }} key={heading.from} onContextMenu={event=>{if(onCopy){event.preventDefault();setMenu({heading,x:Math.max(8,Math.min(event.clientX,window.innerWidth-210)),y:Math.max(8,Math.min(event.clientY,window.innerHeight-65))});}}}>
        {headings[index + 1]?.parent === index ? <button type="button" className="outline-fold" aria-label={`${collapsed.includes(heading.from) ? "展开" : "折叠"}标题 ${heading.text}`} aria-expanded={!collapsed.includes(heading.from)} onClick={() => setCollapsed((previous) => previous.includes(heading.from) ? previous.filter((from) => from !== heading.from) : [...previous, heading.from])}><WorkspaceIcon name="chevron" size={12}/></button> : <span className="outline-leaf" />}
        <button type="button" className="outline-heading" aria-current={active === index ? "location" : undefined} title={`H${heading.level} · 第 ${heading.line} 行：${heading.text}`} onClick={() => onJump(heading)}>{heading.text}</button>
        {onCopy&&<button type="button" className="outline-copy" aria-label={"复制标题 Wiki 链接："+heading.text+" · 第 "+heading.line+" 行"} title="复制 Wiki 标题链接" onMouseDown={event=>event.preventDefault()} onClick={()=>onCopy(heading)}><WorkspaceIcon name="copy" size={14}/></button>}
      </div>)}
    </nav>
    {menu&&<div className="file-menu" role="menu" aria-label="标题操作" style={{left:menu.x,top:menu.y}}><button type="button" role="menuitem" onClick={()=>{onCopy?.(menu.heading);setMenu(null);}}>复制 Wiki 标题链接</button></div>}
  </aside>;
}
