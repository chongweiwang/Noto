import {unified} from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {decodeString} from "micromark-util-decode-string";
import {parseKnowledge} from "./wiki-syntax";
import {headingIndex,findHeading} from "./heading-index";
import {resolveWikiTarget,headingProblem,encodeWikiText} from "./wiki-target";
import type {Note} from "./vault-api";
import type {Root} from "mdast";
import type {VFile} from "vfile";
import {blockIndex,findBlock} from "./wiki-block";
import {isDrawing} from "./document-kind";
import {drawingPreview} from "./drawing-preview";

export type NoteEmbed = {from:number;to:number;target:string;label:string;standalone:boolean};
const parser=unified().use(remarkParse).use(remarkGfm).use(remarkMath);

// Use the same text-only boundaries as Wiki links: code, HTML, links and
// images cannot accidentally turn into an embed.
export function parseNoteEmbeds(source:string,parsed= parseKnowledge(source)):NoteEmbed[] {
 const embeds:NoteEmbed[]=[];
 for(const range of parsed.textRanges){
  const text=source.slice(range.from,range.to),pattern=/!\[\[([^\[\]\r\n]*)\]\]/g;
  for(const match of text.matchAll(pattern)){
   const local=match.index,from=range.from+local,to=from+match[0].length;
   const slashes=source.slice(0,from).match(/\\+$/)?.[0].length??0;
   if(slashes%2)continue;
   const inner=decodeString(match[1]),separator=inner.indexOf("|");
   const target=(separator<0?inner:inner.slice(0,separator)).trim();
   const label=(separator<0?target:inner.slice(separator+1).trim())||target;
   const start=source.lastIndexOf("\n",from-1)+1,next=source.indexOf("\n",to),end=next<0?source.length:next;
   embeds.push({from,to,target,label,standalone:!source.slice(start,from).trim()&&!source.slice(to,end).trim()});
  }
 }
 return embeds;
}

// Convert only verified text ranges into a private link understood by the
// preview. Offsets remain tied to the host source, not the rendered text.
export function remarkNoteEmbeds(){
 return (tree:Root,file:VFile)=>{
  const source=String(file.value),embeds=parseNoteEmbeds(source);
  const lines=[0];for(let i=0;i<source.length;i++)if(source[i]==="\n")lines.push(i+1);
  function point(offset:number){let lo=0,hi=lines.length;while(lo+1<hi){const mid=(lo+hi)>>>1;if(lines[mid]<=offset)lo=mid;else hi=mid;}return {offset,line:lo+1,column:offset-lines[lo]+1};}
  type Node={type:string;value?:string;url?:string;children?:Node[];position?:{start:{offset?:number;line?:number;column?:number};end:{offset?:number;line?:number;column?:number}}};
  function visit(parent:Node){
   if(!parent.children||["link","linkReference","image","imageReference"].includes(parent.type))return;
   parent.children=parent.children.flatMap(child=>{
    const from=child.position?.start.offset,to=child.position?.end.offset;
    if(child.type!=="text"||from===undefined||to===undefined){visit(child);return [child];}
    const hits=embeds.filter(embed=>embed.from>=from&&embed.to<=to);
    if(!hits.length)return [child];
    const out:Node[]=[];let cursor=from;
    for(const hit of hits){
     if(hit.from>cursor)out.push({type:"text",value:decodeString(source.slice(cursor,hit.from)).replace(/\r\n?/g,"\n")});
     out.push({type:"link",url:"noto-embed:"+hit.from,children:[{type:"text",value:source.slice(hit.from,hit.to)}],position:{start:point(hit.from),end:point(hit.to)}});
     cursor=hit.to;
    }
    if(cursor<to)out.push({type:"text",value:decodeString(source.slice(cursor,to)).replace(/\r\n?/g,"\n")});
    return out;
   });
  }
  visit(tree as unknown as Node);
 };
}

export type EmbedTarget = {path?:string;fragment:string|null;candidates:string[];error?:string};
export function unsupportedEmbedFile(file:string){return /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|pdf|canvas|drawing|mp3|mp4|zip)$/i.test(file);}
export function resolveEmbed(target:string,source:string,paths:string[],drawingPaths?:string[]):EmbedTarget {
 const drawing=resolveWikiTarget(target,source,drawingPaths??[]);
 if(isDrawing(drawing.file)||drawing.candidates.some(isDrawing)||/\.drawing(?:#|$)/i.test(target.trim())){
  if(!drawingPaths)return {fragment:drawing.fragment,candidates:[],error:"暂不支持此类型的嵌入"};
  if(drawing.invalid)return {fragment:drawing.fragment,candidates:[],error:"无效嵌入目标"};
  if(drawing.candidates.length>1)return {fragment:drawing.fragment,candidates:drawing.candidates,error:"存在同名白板"};
  if(!drawing.candidates.length)return {fragment:drawing.fragment,candidates:[],error:"白板不存在"};
  const path=drawing.candidates[0];
  if(drawing.fragment!==null)return {path,fragment:drawing.fragment,candidates:drawing.candidates,error:"白板不支持标题或块引用"};
  return {path,fragment:null,candidates:drawing.candidates};
 }
 const parsed=resolveWikiTarget(target,source,paths);
 if(parsed.invalid||!target.trim())return {fragment:parsed.fragment,candidates:parsed.candidates,error:"无效嵌入目标"};
 if(unsupportedEmbedFile(parsed.file))return {fragment:parsed.fragment,candidates:[],error:"暂不支持此类型的嵌入"};
 if(parsed.candidates.length>1)return {fragment:parsed.fragment,candidates:parsed.candidates,error:"存在同名笔记"};
 if(!parsed.candidates.length)return {fragment:parsed.fragment,candidates:[],error:"笔记不存在"};
 const path=parsed.candidates[0],problem=headingProblem(parsed.fragment);
 if(problem)return {path,fragment:parsed.fragment,candidates:parsed.candidates,error:problem};
 if(path===source)return {path,fragment:parsed.fragment,candidates:parsed.candidates,error:"不能嵌入当前笔记"};
 return {path,fragment:parsed.fragment,candidates:parsed.candidates};
}

export function formatDrawingEmbed(path:string,paths:string[]):string {
 if(!isDrawing(path)||path.includes("|"))throw new Error("此白板路径无法安全生成嵌入语法");
 const target=path.includes("/")?path:"./"+path,value="![["+encodeWikiText(target)+"]]";
 const parsed=parseNoteEmbeds(value)[0],resolved=resolveEmbed(parsed?.target??"","",[],paths);
 if(!parsed||parsed.target!==target||resolved.path!==path||resolved.error)throw new Error("此白板路径无法唯一解析，请先调整文件名");
 return value;
}

export function embedSection(content:string,fragment:string|null):{content?:string;error?:string} {
 if(fragment===null)return {content};
 if(fragment.startsWith("^")){
  const found=findBlock(blockIndex(content),fragment.slice(1));
  if(found.status!=="resolved"||!found.block)return {error:found.status==="ambiguous"?"块 ID 重复或归属不明确":found.status==="invalid"?"无效块 ID":"文件存在，块不存在"};
  const block=found.block,marker=block.markers[0];
  const text=content.slice(block.from,block.to);let body=marker.standalone?text:text.slice(0,marker.from-block.from)+text.slice(marker.to-block.from);
  if(block.kind==="listItem"){
   const prefix=content.slice(content.lastIndexOf("\n",block.from-1)+1,block.from);
   if(prefix){
    if(!/^ +$/.test(prefix))return {error:"嵌套列表项无法安全提取"};
    const lines=body.split(/(\r\n|\r|\n)/);
    for(let i=2;i<lines.length;i+=2){if(!lines[i].trim())continue;if(!lines[i].startsWith(prefix))return {error:"嵌套列表项无法安全提取"};lines[i]=lines[i].slice(prefix.length);}
    body=lines.join("");
   }
  }
  type RefNode={type:string;identifier?:string;children?:RefNode[];position?:{start:{offset?:number};end:{offset?:number}}};
  const tree=parser.parse(content) as unknown as RefNode,definitions=new Map<string,RefNode>(),pending:string[]=[];
  const key=(node:RefNode)=>node.type.startsWith("footnote")?"footnote:"+node.identifier?.toLowerCase():"link:"+node.identifier?.toLowerCase();
  function collect(node:RefNode){if((node.type==="definition"||node.type==="footnoteDefinition")&&node.identifier&&!definitions.has(key(node)))definitions.set(key(node),node);node.children?.forEach(collect);}collect(tree);
  function references(node:RefNode,inside:boolean){
   const start=node.position?.start.offset,end=node.position?.end.offset;
   const selected=inside||start!==undefined&&end!==undefined&&start>=block.from&&end<=block.to;
   if(selected&&node.identifier&&["footnoteReference","linkReference","imageReference"].includes(node.type))pending.push(key(node));
   node.children?.forEach(child=>references(child,inside));
  }references(tree,false);
  const seen=new Set<string>(),extra:string[]=[];
  while(pending.length){
   const name=pending.shift()!;if(seen.has(name))continue;seen.add(name);if(seen.size>100)return {error:"块引用的脚注或链接定义过多"};
   const definition=definitions.get(name),start=definition?.position?.start.offset,end=definition?.position?.end.offset;
   if(!definition||start===undefined||end===undefined)return {error:"块引用的脚注或链接定义无法安全提取"};
   if(start<block.from||end>block.to)extra.push(content.slice(start,end));
   references(definition,true);
  }
  return {content:body+(extra.length?"\n\n"+extra.join("\n\n"):"")};
 }
 const headings=headingIndex(content),heading=findHeading(headings,fragment);
 if(!heading)return {error:"文件存在，标题不存在"};
 const tree=parser.parse(content);
 const rootHeadings=new Set(tree.children.filter(node=>node.type==="heading").map(node=>node.position?.start.offset));
 if(!rootHeadings.has(heading.from))return {error:"嵌套标题无法安全提取"};
 const index=headings.indexOf(heading),next=headings.slice(index+1).find(item=>item.level<=heading.level);
 if(next&&!rootHeadings.has(next.from))return {error:"嵌套标题无法安全提取"};
 return {content:content.slice(heading.from,next?.from??content.length)};
}

export type EmbedResult={embed:NoteEmbed;path?:string;content?:string;image?:string;error?:string};
// A request owns its cache. It never reads or writes an editor session, and a
// caller must discard the entire result when the surrounding vault changes.
export async function loadNoteEmbeds(source:string,path:string,paths:string[],read:(path:string)=>Promise<Note>,cancelled:()=>boolean=()=>false,drawingPaths?:string[]):Promise<EmbedResult[]|null>{
 const embeds=parseNoteEmbeds(source),results:EmbedResult[]=new Array(embeds.length),reads=new Map<string,Promise<Note>>(),images=new Map<string,string>();
 let cursor=0,imageBytes=0;
 async function worker(){
  while(!cancelled()){
   const i=cursor++;if(i>=embeds.length)return;
   const embed=embeds[i],target=resolveEmbed(embed.target,path,paths,drawingPaths);
   if(!embed.standalone){results[i]={embed,path:target.path,error:"行内嵌入未展开"};continue;}
   if(i>=100){results[i]={embed,path:target.path,error:"嵌入数量超过上限"};continue;}
   if(target.error||!target.path){results[i]={embed,path:target.path,error:target.error??"无效嵌入目标"};continue;}
   try{
    let pending=reads.get(target.path);
    if(!pending){pending=read(target.path);reads.set(target.path,pending);}
    const note=await pending;if(cancelled())return;
    if(isDrawing(target.path)){
     let image=images.get(target.path);
     if(!image){image=drawingPreview(note.content);if(imageBytes+image.length>8*1024*1024)throw new Error("本页白板预览总量超过上限，请打开原白板查看");images.set(target.path,image);imageBytes+=image.length;}
     results[i]={embed,path:target.path,image};continue;
    }
    const section=embedSection(note.content,target.fragment);
    if(section.content!==undefined&&new TextEncoder().encode(section.content).byteLength>256*1024)results[i]={embed,path:target.path,error:"嵌入内容超过 256 KiB 上限"};
    else results[i]={embed,path:target.path,...section};
   }catch(cause){if(cancelled())return;results[i]={embed,path:target.path,error:"读取失败："+(cause instanceof Error?cause.message:String(cause))};}
  }
 }
 await Promise.all(Array.from({length:Math.min(4,embeds.length)},worker));
 return cancelled()?null:results;
}
