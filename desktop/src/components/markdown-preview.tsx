"use client";
import {isDocument,isDrawing} from "../lib/document-kind";

import { createContext, memo, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { Element, ElementContent, Root } from "hast";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { rehypeHeadingIds, rehypeMathErrors, textOf } from "../lib/markdown-rendering";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";
import { decodeLink, resolveNoteLink } from "../lib/markdown-links";
import { remarkDisplayMath } from "../lib/rich-markdown";
import { renderMermaid } from "../lib/mermaid";
import { remarkWikiLinks } from "../lib/knowledge";
import {wikiPresentation,type WikiServices,type WikiOpen} from "../lib/wiki-ui";
import { checkboxOffset, setMarkdownCheckbox } from "../lib/markdown-checklist";
import { copyText, isPdfPath, previewImage, previewPdf } from "../lib/ui-actions";
import { remarkCallouts } from "../lib/markdown-callouts";
import type {SearchHighlight} from "../lib/note-search";
import {previewSearch,rehypeSearchBlock,rehypeSearchMark} from "../lib/search-preview";
import {loadNoteEmbeds,parseNoteEmbeds,remarkNoteEmbeds,resolveEmbed,type EmbedResult} from "../lib/note-embed";
import {readEmbedSaved} from "../lib/embed-reads";

function LocalImage({ note, src, alt }: { note: string; src?: string; alt?: string }) {
  const { api: desktop } = useWorkspaceRuntime();
  const [data, setData] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(""); setError("");
    if (!src || /^(?:https?:|data:|\/\/)/i.test(src)) setError("此处仅预览知识库中的图片");
    else desktop.image(note, decodeLink(src)).then((value) => { if (active) setData(value); })
      .catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [note, src]);
  if (error) return <span className="image-error">图片无法预览：{alt || src}（{error}）</span>;
  if (!data) return <span>正在读取图片…</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <span className="markdown-image-open" role="button" tabIndex={0} aria-label={`查看图片 ${alt || src}`} title="点击放大" onClick={(event) => { event.preventDefault(); event.stopPropagation(); previewImage(data, alt || src || "图片"); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); previewImage(data, alt || src || "图片"); } }}><img src={data} alt={alt || ""} /></span>;
}

function CopyCode({ value }: { value: string }) {
  const [label, setLabel] = useState("复制代码"), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <button type="button" className="preview-code-copy" aria-label="复制代码块" onClick={() => { void copyText(value).then((ok) => { setLabel(ok ? "已复制" : "手动复制"); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setLabel("复制代码"), 1600); }); }}>{label}</button>;
}

function MermaidDiagram({ source }: { source: string }) {
  const [result, setResult] = useState<{ svg?: string; error?: string }>({});
  useEffect(() => {
    let active = true;
    setResult({});
    renderMermaid(source).then((svg) => { if (active) setResult({ svg }); })
      .catch((cause) => { if (active) setResult({ error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; };
  }, [source]);
  if (result.error) return <div className="rich-error" role="alert">Mermaid 图表无法渲染：{result.error}<pre>{source}</pre></div>;
  if (!result.svg) return <div className="mermaid-diagram">正在渲染图表…</div>;
  return <div className="mermaid-diagram" aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: result.svg }} />;
}

function MarkdownPre({ node, children }: { node?: Element; children?: ReactNode }) {
  const code = node?.children[0];
  const classes = code?.type === "element" ? code.properties.className : undefined;
  const value = code ? textOf(code).replace(/\n$/, "") : "";
  if (code?.type === "element" && code.tagName === "code" && Array.isArray(classes) && classes.some((name) => String(name).toLowerCase() === "language-mermaid")) return <div className="preview-code-block"><CopyCode value={value} /><MermaidDiagram source={value} /></div>;
  return <div className="preview-code-block"><CopyCode value={value} /><pre>{children}</pre></div>;
}

function rehypeCheckboxLocations() {
  return (tree: { children: ElementContent[] }, file: { value: unknown }) => {
    const source = String(file.value);
    function visit(node: ElementContent) {
      if (node.type !== "element") return;
      if (node.tagName === "li" && node.position?.start.offset !== undefined) {
        const at = checkboxOffset(source, node.position.start.offset);
        const first = node.children.find((child) => child.type === "element");
        const input = first?.type === "element" && first.tagName === "p" ? first.children.find((child) => child.type === "element" && child.tagName === "input") : first;
        if (at !== null && input?.type === "element" && input.tagName === "input" && input.properties.type === "checkbox") {
          input.properties["data-checkbox-offset"] = at;
          input.properties["aria-label"] = `备注任务：${node.children.filter((child) => child.type !== "element" || !["ul", "ol"].includes(child.tagName)).map(textOf).join("").trim()}`;
        }
      }
      node.children.forEach(visit);
    }
    tree.children.forEach(visit);
  };
}

const PreviewContext = createContext<{
  content: string; onChange?: (content: string) => void; disabled: boolean; onError: (error: string) => void;
  note: string; wikiPaths: string[]; drawingPaths:string[]; onOpenNote?: (path: string, anchor?: string) => void;
  onWikiOpen?: WikiOpen; wikiServices?:WikiServices; anchorsInSource: boolean; scrollToAnchor: (value: string) => void;
  embeds:EmbedResult[]|null; nested:boolean; embedScope:string; embedRevision:number; idPrefix:string; retryEmbeds:()=>void;
} | null>(null);

function scopedIds(prefix:string){
 return (tree:Root)=>{
  if(!prefix)return;
  const ids=new Set<string>();
  function collect(node:Root|Element){for(const child of node.children)if(child.type==="element"){if(child.properties.id)ids.add(String(child.properties.id));collect(child);}}
  function change(node:Root|Element){for(const child of node.children)if(child.type==="element"){
   if(child.properties.id)child.properties.id=prefix+String(child.properties.id);
   delete child.properties["data-heading-from"];
   const href=child.properties.href;if(typeof href==="string"&&href.startsWith("#")&&ids.has(decodeLink(href.slice(1))))child.properties.href="#"+prefix+decodeLink(href.slice(1));
   for(const key of ["ariaDescribedBy","ariaLabelledBy","htmlFor","headers"]){const value=child.properties[key];if(typeof value==="string")child.properties[key]=value.split(/\s+/).map(id=>ids.has(id)?prefix+id:id).join(" ");else if(Array.isArray(value))child.properties[key]=value.map(id=>ids.has(String(id))?prefix+String(id):id);}
   change(child);
  }}
  collect(tree);change(tree);
 };
}

function DrawingEmbedImage({image,path,label,onOpen}:{image:string;path:string;label:string;onOpen:()=>void}){
 const [failed,setFailed]=useState("");
 return <button type="button" className="drawing-embed-preview" aria-label={"打开白板 "+path} onPointerDown={event=>event.stopPropagation()} onClick={onOpen}>{failed===image?<span className="note-embed-message">白板预览无法解码，请打开原白板查看</span>:<img src={image} alt={label||path} draggable={false} onError={()=>setFailed(image)}/>}</button>;
}

function EmbedLink({offset,children}:{offset:number;children?:ReactNode}){
 const context=useContext(PreviewContext);if(!context)return <span>{children}</span>;
 const item=context.embeds?.find(entry=>entry.embed.from===offset);
 if(context.nested)return <span className="note-embed-message">{children}（嵌套嵌入未展开）</span>;
 if(!item)return <span className="note-embed-message">{children}（正在读取嵌入…）</span>;
 const target=resolveEmbed(item.embed.target,context.note,context.wikiPaths,context.drawingPaths);
 const open=(chosen?:string)=>{if(chosen&&isDrawing(chosen))context.onOpenNote?.(chosen);else context.onWikiOpen?.(item.embed.target,context.note,chosen);};
 if(!item.embed.standalone)return <span>{children} <button type="button" onClick={()=>open(item.path)}>打开来源</button></span>;
 return <section className="note-embed" role="group" aria-label={"嵌入："+item.embed.label}>
  <button type="button" className="note-embed-title" onClick={()=>open(item.path)}>{item.embed.label||item.embed.target} ↗</button><small>已保存内容</small>
  {item.error?<span className="note-embed-message">{item.error}{item.error.startsWith("读取失败")&&<button type="button" onClick={context.retryEmbeds}>重试读取</button>}{target.candidates.length>1&&target.candidates.map(path=><button key={path} type="button" onClick={()=>open(path)}>{path}</button>)}</span>:
   item.path&&item.image?<DrawingEmbedImage image={item.image} path={item.path} label={item.embed.label} onOpen={()=>open(item.path)}/>:
   item.path&&item.content!==undefined?<MarkdownPreview note={item.path} content={item.content} onError={context.onError} onOpenNote={context.onOpenNote} onWikiOpen={context.onWikiOpen} wikiPaths={context.wikiPaths} drawingPaths={context.drawingPaths} wikiServices={context.wikiServices} anchorsInSource checkboxesDisabled nested embedScope={context.embedScope} embedRevision={context.embedRevision}/>:null}
 </section>;
}

function MarkdownParagraph({node,children,...props}:{node?:Element}&ComponentProps<"p">){
 const hasEmbed=node?.children.some(child=>child.type==="element"&&child.tagName==="a"&&String(child.properties.href??"").startsWith("noto-embed:"));
 return hasEmbed?<div {...props} className={[props.className,"embed-paragraph"].filter(Boolean).join(" ")}>{children}</div>:<p {...props}>{children}</p>;
}

// Keep this component type stable across renders: replacing a renderer during
// autosave would recreate its input and drop keyboard focus after a click.
function MarkdownCheckbox({ node, checked, type }: { node?: Element; checked?: boolean; type?: string }) {
  const context = useContext(PreviewContext);
  const at = Number(node?.properties["data-checkbox-offset"]);
  const editable = !!context?.onChange && !context.disabled && Number.isInteger(at) && at > 0;
  return <input type={type} checked={!!checked} disabled={!editable} aria-label={String(node?.properties["aria-label"] ?? "Markdown 任务框")} onChange={(event) => {
    if (!editable || !context) return;
    try { context.onChange?.(setMarkdownCheckbox(context.content, at, event.target.checked)); }
    catch (cause) { context.onError(cause instanceof Error ? cause.message : String(cause)); }
  }} />;
}

function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const context = useContext(PreviewContext);
  return <LocalImage note={context?.note ?? ""} src={typeof src === "string" ? src : undefined} alt={alt} />;
}

function MarkdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const { api: desktop } = useWorkspaceRuntime();
  const context = useContext(PreviewContext);
  if (!context) return <a href={href}>{children}</a>;
  if(href?.startsWith("noto-embed:"))return <EmbedLink offset={Number(href.slice(11))}>{children}</EmbedLink>;
  const { note, wikiPaths, onWikiOpen, onOpenNote, onError, anchorsInSource, scrollToAnchor, wikiServices } = context;
  return <a href={href} className={href?.startsWith("noto-wiki:")?wikiPresentation(decodeLink(href.slice(10)),note,wikiPaths,wikiServices).className:undefined} title={href?.startsWith("noto-wiki:")?wikiPresentation(decodeLink(href.slice(10)),note,wikiPaths,wikiServices).title:undefined} onClick={(event) => {
    event.preventDefault();
    if (!href) return;
    if (href.startsWith("noto-wiki:")) { onWikiOpen?.(decodeLink(href.slice(10)),note); return; }
    if (href.startsWith("#")) {
      if (anchorsInSource && onOpenNote && !href.slice(1).replace(context.idPrefix,"").startsWith("user-content-fn")) onOpenNote(note, decodeLink(href.slice(1).replace(context.idPrefix,"")));
      else scrollToAnchor(href.slice(1));
      return;
    }
    if (/^(?:https?:|mailto:)/i.test(href)) { desktop.openExternal(href).catch((cause) => onError(String(cause))); return; }
    const [path, fragment] = href.split("#", 2);
    const target = resolveNoteLink(note, path.split("?", 1)[0]);
    if (!target) { onError("链接路径无效或超出知识库。"); return; }
    if (isPdfPath(target) && desktop.readPdf) previewPdf(target, fragment ? decodeLink(fragment) : undefined);
    else if (isDocument(target) && onOpenNote) onOpenNote(target, fragment ? decodeLink(fragment) : undefined);
    else desktop.openAttachment(note, decodeLink(path.split("?", 1)[0])).catch((cause) => onError(String(cause)));
  }}>{children}</a>;
}

export const MarkdownPreview = memo(function MarkdownPreview({ note, content, onError, onOpenNote, anchor, onAnchorHandled, isAnchorCurrent, wikiPaths = [], drawingPaths=[], onWikiOpen, wikiServices, anchorsInSource = false, onCheckboxChange, checkboxesDisabled = false, headingJump, onHeadingHandled, isHeadingCurrent, searchHighlight, onSearchLocated, onSearchClear, isSearchCurrent, initialScroll = 0, onScrollChange, nested=false, hideHtml=false, embedScope="", embedRevision=0, embedActive=true }: {
  note: string; content: string; onError: (error: string) => void;
  onOpenNote?: (path: string, anchor?: string) => void; anchor?: string; onAnchorHandled?: () => void; isAnchorCurrent?:()=>boolean;
  wikiPaths?: string[]; drawingPaths?:string[]; onWikiOpen?: WikiOpen; wikiServices?:WikiServices; anchorsInSource?: boolean;
  onCheckboxChange?: (content: string) => void; checkboxesDisabled?: boolean;
  headingJump?: { from: number; serial: number; content?:string };
  onHeadingHandled?:(serial:number)=>void;
  isHeadingCurrent?:(serial:number)=>boolean;isSearchCurrent?:(serial:number)=>boolean;
  searchHighlight?:SearchHighlight; onSearchLocated?:(serial:number,status:"exact"|"source"|"missing")=>void;onSearchClear?:(serial:number)=>void;
  initialScroll?: number; onScrollChange?: (scroll: number) => void;
  nested?:boolean;hideHtml?:boolean;embedScope?:string;embedRevision?:number;embedActive?:boolean;
}) {
  const [copyMenu,setCopyMenu]=useState<{x:number;y:number;text:string}|null>(null);
  useEffect(()=>{if(!copyMenu)return;const close=()=>setCopyMenu(null);window.addEventListener("pointerdown",close);return ()=>window.removeEventListener("pointerdown",close);},[copyMenu]);
  const {api}=useWorkspaceRuntime(),identity=useId(),idPrefix=nested?"noto-embed-"+identity.replace(/[^a-zA-Z0-9]/g,"")+"-":"";
  const [retryRevision,setRetryRevision]=useState(0);
  const pathsKey=wikiPaths.join("\0"),drawingPathsKey=drawingPaths.join("\0");
  const embedKey=useMemo(()=>JSON.stringify([note,content,pathsKey,drawingPathsKey,embedScope,embedRevision,retryRevision]),
    [note,content,pathsKey,drawingPathsKey,embedScope,embedRevision,retryRevision]);
  const [embedBatch,setEmbedBatch]=useState<{key:string;items:EmbedResult[]}|null>(null);
  const embeds=embedBatch?.key===embedKey?embedBatch.items:null;
  useEffect(()=>{
    if(nested||!embedActive||!content.includes("![[")||!parseNoteEmbeds(content).length){setEmbedBatch(null);return;}
    let cancelled=false,running=false;
    const update=async()=>{if(running||cancelled)return;running=true;try{
      const result=await loadNoteEmbeds(content,note,pathsKey?pathsKey.split("\0"):[],path=>readEmbedSaved(api,embedScope,path,()=>cancelled),()=>cancelled,drawingPathsKey?drawingPathsKey.split("\0"):[]);
      if(!cancelled&&result)setEmbedBatch(previous=>previous?.key===embedKey&&JSON.stringify(previous.items)===JSON.stringify(result)?previous:{key:embedKey,items:result});
    }finally{running=false;}};
    const timer=setTimeout(()=>void update(),200),interval=setInterval(()=>void update(),5000);
    return ()=>{cancelled=true;clearTimeout(timer);clearInterval(interval);};
  },[api,content,note,pathsKey,drawingPathsKey,embedScope,embedRevision,embedActive,nested,retryRevision]);
  const article = useRef<HTMLElement>(null),lastSearch=useRef<number|null>(null);
  const search=useMemo(()=>previewSearch(content,searchHighlight),[content,searchHighlight]);
  const currentSearch=useRef(search);currentSearch.current=search;
  useEffect(()=>{
    if(!search||lastSearch.current===search.serial)return;
    const frame=requestAnimationFrame(()=>{
      if(currentSearch.current?.serial!==search.serial||isSearchCurrent?.(search.serial)===false)return;
      const exact=article.current?.querySelector<HTMLElement>('[data-search-hit="'+search.serial+'"]'),block=article.current?.querySelector<HTMLElement>('[data-search-block="'+search.serial+'"]');
      (exact??block)?.scrollIntoView?.({block:"center"});lastSearch.current=search.serial;
      onSearchLocated?.(search.serial,exact?"exact":block?"source":"missing");
    });
    return ()=>cancelAnimationFrame(frame);
  },[search]);

  useEffect(() => { if (article.current) article.current.scrollTop = initialScroll; }, []);
  useEffect(() => {
    if (!headingJump) return;
    const frame = requestAnimationFrame(() => { if(isHeadingCurrent?.(headingJump.serial)===false)return;if(headingJump.content===undefined||headingJump.content===content)article.current?.querySelector<HTMLElement>(`[data-heading-from="${headingJump.from}"]`)?.scrollIntoView?.({ block: "start" });onHeadingHandled?.(headingJump.serial); });
    return () => cancelAnimationFrame(frame);
  }, [note, content, headingJump?.serial]);
  function scrollToAnchor(value: string) {
    const id = decodeLink(value);
    const target = [...(article.current?.querySelectorAll<HTMLElement>("[id]") ?? [])].find((element) => element.id === id);
    target?.scrollIntoView?.();
  }
  useEffect(() => {
    if (!anchor) return;
    const frame = requestAnimationFrame(() => {
      if(isAnchorCurrent?.()===false)return;
      scrollToAnchor(anchor);
      onAnchorHandled?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [note, content, anchor, onAnchorHandled]);
  const rendered = useMemo(() => (
    <ReactMarkdown skipHtml={hideHtml} remarkPlugins={[remarkGfm, remarkMath, remarkDisplayMath, remarkWikiLinks,remarkNoteEmbeds,remarkCallouts]} urlTransform={(url) => url.startsWith("noto-wiki:")||url.startsWith("noto-embed:") ? url : defaultUrlTransform(url)} rehypePlugins={[rehypeHeadingIds,[scopedIds,idPrefix], rehypeCheckboxLocations, rehypeMathErrors, [rehypeSearchBlock,search], [rehypeKatex, { trust: false }], [rehypeHighlight, { ignoreMissing: true }], [rehypeSearchMark,search]]} components={{ pre: MarkdownPre, input: MarkdownCheckbox, img: MarkdownImage, a: MarkdownAnchor,p:MarkdownParagraph }}>{content}</ReactMarkdown>
  ), [content,hideHtml,idPrefix,search]);
  return <article ref={article} className="markdown-preview" aria-label="Markdown 预览" onMouseUp={()=>{if(search)onSearchClear?.(search.serial);}} onScroll={(event) => onScrollChange?.(event.currentTarget.scrollTop)} onContextMenu={event=>{
    if(nested){event.stopPropagation();return;}
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed &&
      article.current?.contains(selection.anchorNode) && article.current.contains(selection.focusNode) ? selection.toString() : "";
    if (!text) return;
    event.preventDefault();
    setCopyMenu({x:event.clientX,y:event.clientY,text});
  }}>
    <PreviewContext.Provider value={{ content, onChange: onCheckboxChange, disabled: checkboxesDisabled, onError, note, wikiPaths,drawingPaths, onWikiOpen, wikiServices, onOpenNote, anchorsInSource, scrollToAnchor,embeds,nested,embedScope,embedRevision,idPrefix,retryEmbeds:()=>setRetryRevision(value=>value+1) }}>
      {rendered}
    </PreviewContext.Provider>
    {copyMenu&&<div role="menu" className="preview-context-menu" style={{position:"fixed",left:copyMenu.x,top:copyMenu.y,zIndex:1000}} onPointerDown={event=>event.stopPropagation()} onMouseDown={event=>event.preventDefault()} onKeyDown={event=>{if(event.key==="Escape")setCopyMenu(null);}}>
      <button type="button" role="menuitem" onClick={()=>{
        setCopyMenu(null);
        void copyText(copyMenu.text);
      }}>复制</button>
    </div>}
  </article>;
});
