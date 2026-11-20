import {unified} from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type {Text} from "@codemirror/state";

export type BlockKind="paragraph"|"listItem"|"list"|"blockquote"|"table";
export type BlockMarker={id:string;from:number;to:number;standalone:boolean};
export type BlockEntry={kind:BlockKind;from:number;to:number;line:number;markers:BlockMarker[];snippet:string;insertAt?:number};
export type BlockIndex={blocks:BlockEntry[];byId:Map<string,BlockEntry[]>};
type Node={type:string;children?:Node[];position?:{start:{offset?:number;line?:number};end:{offset?:number}}};
const parser=unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const allowed=new Set(["paragraph","listItem","list","blockquote","table"]);
export const validBlockId=(id:string)=>/^[A-Za-z0-9-]{1,128}$/.test(id);

// AST positions establish ownership; text-only ranges prevent markers inside
// links, images, code, math, HTML and escaped syntax from acquiring identity.
export function blockIndex(source:string):BlockIndex {
 const root=parser.parse(source) as unknown as Node,plain:{from:number;to:number}[]=[];
 function collect(node:Node){
  if(["link","linkReference","image","imageReference","code","inlineCode","math","inlineMath","html","definition"].includes(node.type))return;
  if(node.type==="text"){const from=node.position?.start.offset,to=node.position?.end.offset;if(from!==undefined&&to!==undefined)plain.push({from,to});return;}
  const tags:string[]=[];
  for(const child of node.children??[]){
   if(child.type!=="html"){if(!tags.length)collect(child);continue;}
   const value=source.slice(child.position?.start.offset,child.position?.end.offset),close=/^<\/([\w:-]+)\s*>/.exec(value);
   if(close){const index=tags.lastIndexOf(close[1].toLowerCase());if(index>=0)tags.splice(index);continue;}
   const open=/^<([a-z][\w:-]*)(?:\s|\/?>)/i.exec(value);
   if(open&&!/\/\s*>$/.test(value)&&!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(open[1])&&!new RegExp("</"+open[1]+"\\s*>","i").test(value))tags.push(open[1].toLowerCase());
  }
 }
 collect(root);
 const front=/^\uFEFF?---[ \t]*(?:\r\n|\r|\n)[\s\S]*?(?:\r\n|\r|\n)---[ \t]*(?:(?:\r\n|\r|\n)|$)/.exec(source)?.[0].length??0;
 const entries=new Map<string,BlockEntry>(),byId=new Map<string,BlockEntry[]>();
 function entry(node:Node):BlockEntry|undefined{
  const from=node.position?.start.offset,to=node.position?.end.offset;
  if(from===undefined||to===undefined||from<front||!allowed.has(node.type))return;
  const key=node.type+":"+from+":"+to;let item=entries.get(key);
  if(!item){item={kind:node.type as BlockKind,from,to,line:node.position?.start.line??1,markers:[],snippet:source.slice(from,to).trim().replace(/\s+/g," ").slice(0,160)};entries.set(key,item);}
  return item;
 }
 function isPlain(from:number,to:number){return plain.some(range=>range.from<=from&&range.to>=to);}
 function walk(node:Node,parent?:Node){
  if(node.type==="paragraph"&&(parent?.type==="root"||parent?.type==="listItem")){
   if(parent.type==="listItem"&&parent.children?.filter(child=>child.type==="paragraph").at(-1)!==node){node.children?.forEach(child=>walk(child,node));return;}
   const owner=parent.type==="listItem"?parent:node,item=entry(owner),start=node.position?.start.offset,end=node.position?.end.offset;
   if(item&&start!==undefined&&end!==undefined){
    if(node.children?.at(-1)?.type==="text"&&!/(?:[ \t]{2,}|\\)$/.test(source.slice(start,end)))item.insertAt=end;
    const raw=source.slice(start,end),match=/(?:[ \t]+|\r\n|\r|\n)\^([A-Za-z0-9-]{1,128})[ \t]*$/.exec(raw);
    if(match){const caret=start+match.index+match[0].indexOf("^"),stop=caret+1+match[1].length;
     if(isPlain(caret,stop))item.markers.push({id:match[1],from:caret,to:stop,standalone:false});}
   }
  }
  if(node.type==="listItem")entry(node);
  if(parent?.type==="root"&&["list","blockquote","table"].includes(node.type))entry(node);
  node.children?.forEach(child=>walk(child,node));
 }
 walk(root);
 for(let i=1;i<(root.children?.length??0);i++){
  const previous=root.children![i-1],marker=root.children![i],start=marker.position?.start.offset,end=marker.position?.end.offset,previousEnd=previous.position?.end.offset;
  if(marker.type!=="paragraph"||start===undefined||end===undefined||previousEnd===undefined||!allowed.has(previous.type)||previous.type==="listItem")continue;
  const raw=source.slice(start,end),match=/^\^([A-Za-z0-9-]{1,128})[ \t]*$/.exec(raw);
  const gap=source.slice(previousEnd,start);
  if(!match||!isPlain(start,start+1+match[1].length)||!/^\s*$/.test(gap)||((gap.match(/\r\n|\r|\n/g)??[]).length>2))continue;
  if(previous.type==="paragraph"&&/^\^[A-Za-z0-9-]+[ \t]*$/.test(source.slice(previous.position!.start.offset!,previousEnd)))continue;
  entry(previous)?.markers.push({id:match[1],from:start,to:start+1+match[1].length,standalone:true});
  entries.delete(marker.type+":"+start+":"+end);
 }
 for(const block of entries.values()){
  let snippet=source.slice(block.from,block.to);
  for(const marker of [...block.markers].sort((a,b)=>b.from-a.from))if(marker.from>=block.from&&marker.to<=block.to)snippet=snippet.slice(0,marker.from-block.from)+snippet.slice(marker.to-block.from);
  block.snippet=snippet.trim().replace(/\s+/g," ").slice(0,160);
  for(const marker of block.markers){const key=marker.id.toLowerCase();byId.set(key,[...(byId.get(key)??[]),block]);}
 }
 return {blocks:[...entries.values()].sort((a,b)=>a.from-b.from||b.to-a.to),byId};
}

export type BlockMarkerPlan={id:string;snippet:string;change?:{from:number;insert:string}};
export function planBlockMarker(source:string,from:number,to:number,random:(bytes:Uint8Array)=>void=(bytes)=>crypto.getRandomValues(bytes)):BlockMarkerPlan {
 const index=blockIndex(source),candidates=index.blocks.filter(block=>block.from<=from&&block.to>=to&&block.from<block.to).sort((a,b)=>(a.to-a.from)-(b.to-b.from));
 if(!candidates.length)throw new Error("请将光标或选区放在可引用的单个块中");
 const block=candidates[0];
 if(from!==to&&["list","blockquote","table"].includes(block.kind)&&(from!==block.from||to!==block.to))throw new Error("请完整选择一个结构块，或选择单个段落/列表项");
 if(block.markers.length){const marker=block.markers[0];if(block.markers.length!==1||findBlock(index,marker.id).status!=="resolved")throw new Error("块 ID 重复或归属不明确，请先调整原文");return {id:marker.id,snippet:block.snippet};}
 let at=block.insertAt,separator=" ";
 if(block.kind!=="paragraph"&&block.kind!=="listItem"){
  at=block.to;separator="\n\n";
  const rest=source.slice(at);if(rest&&!/^(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/.test(rest))throw new Error("结构块后缺少安全的空行，请先调整原文");
 }
 if(at===undefined)throw new Error("当前块无法安全插入标记，请先调整原文");
 if(/(?:^|\s)\^[^\s]+[ \t]*$/.test(source.slice(block.from,at)))throw new Error("当前块已有无法识别的标记，请先调整原文");
 for(let attempt=0;attempt<8;attempt++){
  const bytes=new Uint8Array(16);try{random(bytes);}catch{throw new Error("安全随机数不可用，无法创建块 ID");}
  const id="b-"+[...bytes].map(value=>value.toString(16).padStart(2,"0")).join("");
  if(!index.byId.has(id))return {id,snippet:block.snippet,change:{from:at,insert:separator+"^"+id}};
 }
 throw new Error("无法生成唯一块 ID，请重试");
}

export function findBlock(index:BlockIndex,id:string):{status:"resolved"|"missing"|"ambiguous"|"invalid";block?:BlockEntry}{
 if(!validBlockId(id))return {status:"invalid"};
 const hits=index.byId.get(id.toLowerCase())??[];
 if(!hits.length)return {status:"missing"};
 if(hits.length!==1||hits[0].markers.length!==1)return {status:"ambiguous"};
 return {status:"resolved",block:hits[0]};
}
const documentBlocks=new WeakMap<Text,BlockIndex>();
export function blocksForDoc(doc:Text){let index=documentBlocks.get(doc);if(!index){index=blockIndex(doc.toString());documentBlocks.set(doc,index);}return index;}
