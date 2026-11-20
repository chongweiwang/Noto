import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeStringify from "rehype-stringify";
import type { Root, RootContent, Element } from "hast";
import type { Root as MdRoot } from "mdast";
import { remarkDisplayMath } from "./rich-markdown";
import { remarkWikiLinks } from "./knowledge";
import {resolveWikiTarget,headingProblem} from "./wiki-target";
import {headingIndex,findHeading} from "./heading-index";
import { decodeLink, resolveNoteLink } from "./markdown-links";
import { rehypeHeadingIds, rehypeMathErrors, textOf } from "./markdown-rendering";
import { renderMermaid } from "./mermaid";
import { katexExportCss } from "./export-assets.generated";
import { exportStyles } from "./export-styles";
import { standardExportPreset, type ExportPreset } from "./export-presets";
import { base64Text, bounded, checkCancelled, decodeExportImage, maxExportBytes, safeExportImage } from "./export-resources";
import type { VaultApi } from "./vault-api";
import {loadNoteEmbeds,parseNoteEmbeds,remarkNoteEmbeds,type EmbedResult} from "./note-embed";
import { remarkCallouts } from "./markdown-callouts";

export type ExportSnapshot = { path:string; content:string; unsaved:boolean; conflict:boolean; paths:string[]; drawingPaths:string[]; capturedAt:number };
export type ExportWarning = { line:number; message:string; path?:string };
export type ExportDocument = { html:string; name:string; bytes:number; warnings:ExportWarning[] };
const utf8Size = (text:string) => new TextEncoder().encode(text).byteLength;
export function exportFileName(path:string) {
  let stem = path.split("/").at(-1)?.replace(/\.(?:md|markdown)$/i,"") ?? "";
  stem=stem.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,"_").replace(/[. ]+$/,"").slice(0,120).replace(/[. ]+$/,"");
  if (!stem) stem="笔记";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem="_"+stem;
  return stem+".html";
}
const escape = (s:string) => s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
type ExportApi = Pick<VaultApi, "image"> & Partial<Pick<VaultApi, "read">>;
type RenderOptions = {
  signal?: AbortSignal; decodeImage?: (uri:string, signal?:AbortSignal)=>Promise<void>;
  diagram?: (source:string)=>Promise<string>; maxBytes?:number;
  preset?: ExportPreset;
};
type Section = { id:string; snapshot:ExportSnapshot };

function wrapHtml(title: string, body: string, preset = standardExportPreset) {
  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    +'<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; font-src data:; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">'
    +'<title>'+escape(title)+'</title><style>'+katexExportCss+'\n'+exportStyles(preset)+'</style></head><body>'+body+'</body></html>';
}
function literalHtml() {
  return (root:MdRoot) => {
    function visit(node: {type:string; value?:string; children?:unknown[]}) {
      if (node.type==="html") node.type="text";
      node.children?.forEach((child)=>visit(child as typeof node));
    }
    visit(root);
  };
}

async function renderNote(snapshot:ExportSnapshot, api:ExportApi, options:RenderOptions, sections?:Map<string,Section>) {
  const {signal}=options, limit=options.maxBytes??maxExportBytes;
  checkCancelled(signal);
  let estimated=utf8Size(snapshot.content)+utf8Size(katexExportCss)+utf8Size(exportStyles(options.preset??standardExportPreset));
  if (estimated>limit) throw new Error("导出内容超过大小上限（64 MiB）");
  const warnings:ExportWarning[]=[];
  const section = sections?.get(snapshot.path);
  const scopedAnchor = (section:Section, anchor:string) => section.id+(anchor?"-"+anchor:"");
  const syntaxEmbeds=parseNoteEmbeds(snapshot.content);
  const embeds=api.read&&syntaxEmbeds.length?await loadNoteEmbeds(snapshot.content,snapshot.path,snapshot.paths,path=>bounded(api.read!(path),signal),()=>!!signal?.aborted,snapshot.drawingPaths):null;
  checkCancelled(signal);
  const embedMap=new Map((embeds??[]).map(item=>[item.embed.from,item]));
  const warn=(node:Element,message:string)=>warnings.push({line:node.position?.start.line??1,message});
  const decode=options.decodeImage??decodeExportImage;
  const images=new Map<string,Promise<string>>();
  const drawingImages=new WeakMap<Element,string>(),drawingDecodes=new Map<string,Promise<void>>();
  function count(value:string) { estimated+=utf8Size(value); if(estimated>limit) throw new Error("导出内容超过大小上限（64 MiB）"); }
  function placeholder(node:Element,message:string,source?:string) {
    node.tagName=source?"pre":"span"; node.properties={className:["export-warning"]};
    node.children=[{type:"text",value:message+(source?"\n"+source:"")}];
  }
  function image(link:string,origin:string) {
    const relative=link.split(/[?#]/,1)[0], path=resolveNoteLink(origin,relative);
    if (!path) return Promise.reject(new Error("图片路径无效"));
    let loading=images.get(path);
    if(!loading) {
      loading=(async()=>{
        const uri=safeExportImage(await bounded(api.image(origin,decodeLink(relative)),signal));
        await decode(uri,signal); return uri;
      })();
      images.set(path,loading);
    }
    return loading;
  }
  let ownHeadings:ReturnType<typeof headingIndex>|undefined;
  function embedTree(){
   return (root:Root)=>{
    const used=new Set<string>();let index=0;
    function reserve(node:Root|Element){for(const child of node.children)if(child.type==="element"){if(child.properties.id)used.add(String(child.properties.id));reserve(child);}}
    reserve(root);
    function visit(parent:Root|Element){
     parent.children=(parent.children as RootContent[]).map(node=>{
      if(node.type!=="element")return node;
      const href=String(node.properties.href??"");
      if(node.tagName==="a"&&href.startsWith("noto-embed:")){
       const offset=Number(href.slice(11)),item:EmbedResult|undefined=embedMap.get(offset),found=syntaxEmbeds.find(value=>value.from===offset);
       const error=item?.error??(!api.read?"嵌入目标未读取":!item?"嵌入目标无法读取":undefined);
       if(error||!item?.path||item.content===undefined&&item.image===undefined){
        warn(node,error??"嵌入目标无法读取");node.tagName="span";node.properties={className:["export-warning"]};node.children=[{type:"text",value:(found?snapshot.content.slice(found.from,found.to):"嵌入")+"（"+(error??"无法读取")+"）"}];return node;
       }
       if(item.image){
        const image:Element={type:"element",tagName:"img",properties:{src:item.image,alt:item.embed.label||item.path},children:[],position:node.position};
        drawingImages.set(image,item.path);
        node.tagName="figure";node.properties={className:["export-drawing-embed"],"data-embed-origin":item.path};
        node.children=[{type:"element",tagName:"figcaption",properties:{},children:[{type:"text",value:"白板："+(item.embed.label||item.path)+"（已保存内容）"}]},image];
        if(parent.type==="element"&&parent.tagName==="p")parent.tagName="div";
        return node;
       }
       if(item.content===undefined)return node;
       const processor=unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDisplayMath).use(remarkWikiLinks).use(remarkNoteEmbeds).use(remarkCallouts).use(literalHtml).use(remarkRehype).use(rehypeHeadingIds);
       const child=processor.runSync(processor.parse(item.content),{value:item.content}) as Root;
       const ids=new Set<string>();function gather(value:Root|Element){for(const c of value.children)if(c.type==="element"){if(c.properties.id)ids.add(String(c.properties.id));gather(c);}}gather(child);
       let prefix:string;do{prefix="noto-embed-"+(index++)+"-";}while([...ids].some(id=>used.has(prefix+id)));
       function scope(value:Root|Element){for(const c of value.children)if(c.type==="element"){
        if(c.properties.id){c.properties.id=prefix+String(c.properties.id);used.add(String(c.properties.id));}
        delete c.properties["data-heading-from"];
        const link=c.properties.href;if(typeof link==="string"&&link.startsWith("#")&&ids.has(decodeLink(link.slice(1))))c.properties.href="#"+prefix+decodeLink(link.slice(1));
        for(const key of ["ariaDescribedBy","ariaLabelledBy","htmlFor","headers"]){const value=c.properties[key];if(typeof value==="string")c.properties[key]=value.split(/\s+/).map(id=>ids.has(id)?prefix+id:id).join(" ");else if(Array.isArray(value))c.properties[key]=value.map(id=>ids.has(String(id))?prefix+String(id):id);}
        scope(c);
       }}scope(child);count(item.content);
       node.tagName="section";node.properties={className:["export-note-embed"],"data-embed-origin":item.path};
       node.children=[{type:"element",tagName:"strong",properties:{},children:[{type:"text",value:"嵌入："+item.embed.label+"（已保存内容）"}]},...child.children] as Element["children"];
       if(parent.type==="element"&&parent.tagName==="p")parent.tagName="div";
       return node;
      }
      visit(node);return node;
     }) as typeof parent.children;
    }
    visit(root);
   };
  }
  function exportTree() {
    return async(root:Root)=>{
      const nodes:Element[]=[], ids=new Set<string>(), jobs:(()=>Promise<void>)[]=[],origins=new WeakMap<Element,string>();
      function collect(node:Root|RootContent,origin=snapshot.path) {
        if(node.type!=="root" && node.type!=="element") return;
        if(node.type==="element") { origin=String(node.properties["data-embed-origin"]??origin);delete node.properties["data-embed-origin"];origins.set(node,origin);nodes.push(node); if(node.properties.id) ids.add(String(node.properties.id)); }
        node.children.forEach(child=>collect(child,origin));
      }
      collect(root);
      for(const node of nodes) {
        checkCancelled(signal);
        const origin=origins.get(node)??snapshot.path;
        if(section){
          if(node.properties.id)node.properties.id=scopedAnchor(section,String(node.properties.id));
          for(const key of ["ariaDescribedBy","ariaLabelledBy","htmlFor","headers"]){
            const value=node.properties[key];
            const scope=(id:string)=>ids.has(id)?scopedAnchor(section,id):id;
            if(typeof value==="string")node.properties[key]=value.split(/\s+/).map(scope).join(" ");
            else if(Array.isArray(value))node.properties[key]=value.map(id=>scope(String(id)));
          }
        }
        delete node.properties["data-heading-from"];
        const classes=Array.isArray(node.properties.className)?node.properties.className:[];
        if(classes.includes("rich-error")) warn(node,"公式无法渲染，已保留说明及原文");
        if(node.tagName==="input") { node.properties={type:"checkbox",checked:!!node.properties.checked,disabled:true}; }
        if(node.tagName==="a") {
          const href=String(node.properties.href??"");
          if(href.startsWith("noto-embed:")){warn(node,"嵌套嵌入未展开");node.tagName="span";node.properties={className:["export-warning"]};node.children.push({type:"text",value:"（嵌套嵌入未展开）"});continue;}
          let anchor:string|null=null, explanation="";
          if(href.startsWith("#")) anchor=decodeLink(href.slice(1));
          else if(href.startsWith("noto-wiki:")) {
            const target=decodeLink(href.slice(10)),parsed=resolveWikiTarget(target,origin,[...new Set([...snapshot.paths,snapshot.path])]);
            if(parsed.invalid)explanation="不支持或无效的 Wiki 目标";
            else if(parsed.candidates.length>1)explanation="Wiki 目标有歧义："+target;
            else if(!parsed.candidates.length)explanation="Wiki 目标不存在："+target;
            else if(headingProblem(parsed.fragment))explanation=headingProblem(parsed.fragment)+"："+target;
            else if(parsed.candidates[0]===snapshot.path){
              if(parsed.fragment===null)anchor="";
              else {const heading=findHeading(ownHeadings??=headingIndex(snapshot.content),parsed.fragment);if(heading)anchor=heading.id;else explanation="文内标题不存在："+parsed.fragment;}
            }else {
              const peer=sections?.get(parsed.candidates[0]);
              const heading=peer&&parsed.fragment?findHeading(headingIndex(peer.snapshot.content),parsed.fragment):null;
              if(peer&&(!parsed.fragment||heading)){
                node.properties.href="#"+encodeURIComponent(scopedAnchor(peer,heading?.id??""));
                continue;
              }
              explanation=(peer?"合并文档中未找到目标锚点：":"未包含其他笔记：")+parsed.candidates[0]+(parsed.fragment===null?"":"#"+parsed.fragment);
            }
          } else if(/^(?:https?:\/\/|mailto:)/i.test(href)) {
            node.properties={...node.properties,href,rel:["noopener","noreferrer"]}; continue;
          } else {
            const [raw,fragment]=href.split("#",2), target=resolveNoteLink(origin,raw.split("?",1)[0]);
            if(target===snapshot.path) anchor=fragment===undefined?"":decodeLink(fragment);
            else {
              const peer=target?sections?.get(target):undefined;
              if(peer){
                node.properties.href="#"+encodeURIComponent(scopedAnchor(peer,fragment===undefined?"":decodeLink(fragment)));
                continue;
              }
              explanation=target?"未包含的笔记或附件："+target+(fragment===undefined?"":"#"+decodeLink(fragment)):"不支持或无效的链接目标";
            }
          }
          if(anchor!==null) {
            if(anchor&&!ids.has(anchor)) warn(node,"文内锚点不存在："+anchor);
            node.properties.href="#"+encodeURIComponent(section?scopedAnchor(section,anchor):anchor);
          } else {
            warn(node,explanation);
            node.tagName="span"; node.properties={className:["export-target"]};
            node.children.push({type:"element",tagName:"small",properties:{className:["export-target-note"]},children:[{type:"text",value:"（"+explanation+"）"}]});
          }
        }
        if(node.tagName==="img") {
          const link=String(node.properties.src??""), label=String(node.properties.alt??"图片"),drawingPath=drawingImages.get(node);
          jobs.push(async()=>{
            checkCancelled(signal);
            try {
              let uri:string;
              if(drawingPath){
                let pending=drawingDecodes.get(link);
                if(!pending){pending=bounded(Promise.resolve().then(()=>decode(link,signal)),signal);drawingDecodes.set(link,pending);}
                await pending;uri=link;
              }else uri=await image(link,origin);
              checkCancelled(signal); count(uri);
              node.properties={src:uri,alt:label,...(drawingPath?{className:["export-drawing-image"]}:{})};
            } catch(error) {
              checkCancelled(signal);
              if(error instanceof Error && error.message.includes("导出内容超过")) throw error;
              warn(node,drawingPath?"白板预览无法解码："+drawingPath:"图片未包含或无法读取："+label);
              placeholder(node,drawingPath?"[白板预览无法导出："+drawingPath+"]":"[图片无法导出："+label+"]");
            }
          });
        }
        const code=node.tagName==="pre" && node.children.find((child)=>child.type==="element" && child.tagName==="code");
        if(code && code.type==="element" && Array.isArray(code.properties.className) && code.properties.className.includes("language-mermaid")) {
          const source=textOf(code).replace(/\n$/,"");
          jobs.push(async()=>{
            try {
              const svg=await bounded((options.diagram??renderMermaid)(source),signal);
              checkCancelled(signal);
              const uri="data:image/svg+xml;base64,"+base64Text(svg);
              await decode(uri,signal); count(uri);
              node.tagName="figure"; node.properties={}; node.children=[{type:"element",tagName:"img",properties:{src:uri,alt:"Mermaid 图表",className:["export-diagram"]},children:[]}];
            } catch(error) {
              checkCancelled(signal);
              if(error instanceof Error && error.message.includes("导出内容超过")) throw error;
              warn(node,"Mermaid 图表无法渲染，已保留源码"); placeholder(node,"Mermaid 图表无法渲染",source);
            }
          });
        }
      }
      let next=0;
      await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{
        for(;;) { checkCancelled(signal); const job=jobs[next++]; if(!job) return; await job(); }
      }));
    };
  }
  const file=await unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDisplayMath)
    .use(remarkWikiLinks).use(remarkNoteEmbeds).use(remarkCallouts).use(literalHtml).use(remarkRehype).use(rehypeHeadingIds).use(embedTree).use(rehypeMathErrors)
    .use(rehypeKatex,{trust:false}).use(rehypeHighlight).use(exportTree).use(rehypeStringify).process(snapshot.content);
  checkCancelled(signal);
  warnings.sort((a,b)=>a.line-b.line || a.message.localeCompare(b.message));
  return {body:String(file),warnings};
}

export async function prepareNoteExport(snapshot:ExportSnapshot, api:ExportApi, options:RenderOptions={}):Promise<ExportDocument>{
  const { body, warnings } = await renderNote(snapshot, api, options);
  const html=wrapHtml(exportFileName(snapshot.path).replace(/\.html$/,""), body, options.preset);
  const bytes=utf8Size(html);
  if(bytes>(options.maxBytes??maxExportBytes)) throw new Error("导出内容超过大小上限（64 MiB）");
  return {html,name:exportFileName(snapshot.path),bytes,warnings};
}

export async function prepareMergedNoteExport(snapshots:ExportSnapshot[], api:ExportApi, options:RenderOptions={}):Promise<ExportDocument>{
  const sections=new Map(snapshots.map((snapshot,index)=>[snapshot.path,{snapshot,id:"note-"+(index+1)}]));
  if(!sections.size||sections.size!==snapshots.length)throw new Error("请选择不同的笔记导出");
  const intro='<nav aria-label="目录"><h1>笔记合集</h1><ol>'+[...sections.values()].map(({id,snapshot})=>
    '<li><a href="#'+id+'">'+escape(snapshot.path)+'</a></li>').join("")+'</ol></nav>';
  const body=[intro], warnings:ExportWarning[]=[];
  let bytes=utf8Size(wrapHtml("笔记合集",intro,options.preset));
  for(const {id,snapshot} of sections.values()){
    const {body:rendered,warnings:issues}=await renderNote(snapshot,api,options,sections);
    const segment='<section class="export-note-section" id="'+id+'"><h1>'+escape(snapshot.path)+'</h1>'+rendered+'</section>';
    bytes+=utf8Size(segment);
    if(bytes>(options.maxBytes??maxExportBytes))throw new Error("导出内容超过大小上限（64 MiB）");
    body.push(segment);warnings.push(...issues.map(issue=>({...issue,path:snapshot.path})));
  }
  return {html:wrapHtml("笔记合集",body.join(""),options.preset),name:"笔记合集.html",bytes,warnings};
}
