import {unified} from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import {decodeString} from "micromark-util-decode-string";
import type {Root,RootContent,Element,Text} from "hast";
import {remarkDisplayMath} from "./rich-markdown";
import {remarkWikiLinks} from "./wiki-syntax";
import {textOf} from "./heading-ids";
import type {SearchHighlight} from "./note-search";
import {normalizeSearchText,rawSearchOffset} from "./note-search";
import {blockIndex,findBlock} from "./wiki-block";

type Projection={kind:"text"|"code";nodeFrom:number;nodeTo:number;from:number;to:number;value:string};
export type PreviewSearch={serial:number;block?:{from:number;tag:string};exact?:Projection};
const processor=unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDisplayMath).use(remarkWikiLinks).use(remarkRehype);
const blocks=new Set(["p","pre","li","blockquote","h1","h2","h3","h4","h5","h6","td","th"]);
function mapped(raw:string,decode:boolean,newline="\n"){
 let text="",at=0;const boundaries=new Map<number,number>([[0,0]]);
 while(at<raw.length){
  const rest=raw.slice(at),atom=/^\r\n|^\r|^\n/.exec(rest)?.[0]??(decode?(/^\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.exec(rest)?.[0]??/^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]*);/.exec(rest)?.[0]):undefined)??String.fromCodePoint(raw.codePointAt(at)!);
  text+=/^[\r\n]/.test(atom)?newline:decode?decodeString(atom):atom;at+=atom.length;boundaries.set(at,text.length);
 }
 return {text,boundaries};
}
function codeProjection(raw:string,value:string,from:number,to:number){
 const fenced=/^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n)/.exec(raw);
 if(fenced){
  if(fenced[1])return; // Indented/dedented code needs a different proven map.
  const start=fenced[0].length,lines=[...raw.matchAll(/\r\n|\r|\n/g)],last=lines.at(-1),lastStart=last?last.index+last[0].length:0;
  const closing=new RegExp("^ {0,3}"+fenced[2][0]+"{"+fenced[2].length+",}[\\t ]*$").test(raw.slice(lastStart));
  const end=closing?lastStart:raw.length,body=raw.slice(start,end),map=mapped(body,false);
  if(map.text!==value&&map.text+"\n"!==value)return;
  const a=map.boundaries.get(from-start),b=map.boundaries.get(to-start);
  if(a!==undefined&&b!==undefined&&a<b)return {from:a,to:b};
  return;
 }
 const ticks=/^`+/.exec(raw)?.[0];if(!ticks||!raw.endsWith(ticks))return;
 const map=mapped(raw.slice(ticks.length,-ticks.length),false," ");let trim=0;
 if(map.text!==value&&map.text.startsWith(" ")&&map.text.endsWith(" ")&&map.text.slice(1,-1)===value)trim=1;
 if(map.text.slice(trim,trim?map.text.length-1:undefined)!==value)return;
 const a=map.boundaries.get(from-ticks.length),b=map.boundaries.get(to-ticks.length);
 if(a!==undefined&&b!==undefined&&a-trim>=0&&b-trim<=value.length&&a<b)return {from:a-trim,to:b-trim};
}
// The same Markdown semantics as the preview, before expensive renderers.
// Only a verified source-to-text mapping is eligible for exact highlighting.
export function previewSearch(content:string,highlight?:SearchHighlight):PreviewSearch|undefined{
 if(!highlight||highlight.content!==content)return;
 const {from,to,serial}=highlight,result:PreviewSearch={serial},tree=processor.runSync(processor.parse(content),{value:content}) as Root;
 const index=blockIndex(content),markers=index.blocks.flatMap(block=>block.markers.length===1&&findBlock(index,block.markers[0].id).status==="resolved"?[block.markers[0]]:[]);
 let width=Infinity;
 function visit(node:RootContent,inCode=false){
  const start=node.position?.start.offset,end=node.position?.end.offset;
  if(node.type==="element"){
   if(start!==undefined&&end!==undefined&&blocks.has(node.tagName)&&start<=from&&end>=to&&end-start<width){result.block={from:start,tag:node.tagName};width=end-start;}
   if(node.tagName==="code"){
    const classes=String(node.properties.className??"");
    if(start!==undefined&&end!==undefined&&start<=from&&end>=to&&!/mermaid|math/.test(classes)){
     const value=textOf(node),projection=codeProjection(content.slice(start,end),value,from-start,to-start);
     if(projection)result.exact={kind:"code",nodeFrom:start,nodeTo:end,...projection,value};
    }
    return;
   }
   node.children.forEach(child=>visit(child,inCode));return;
  }
  if(node.type==="text"&&!inCode&&start!==undefined&&end!==undefined&&start<=from&&end>=to){
   const map=mapped(content.slice(start,end),true),a=map.boundaries.get(from-start),b=map.boundaries.get(to-start);
   if(map.text===node.value&&a!==undefined&&b!==undefined&&a<b){
    const marker=markers.find(item=>!item.standalone&&item.from>=start&&item.to<=end),raw=content.slice(start,end);
    if(marker&&normalizeSearchText(raw)===node.value){
     const m=rawSearchOffset(raw,marker.from-start),n=rawSearchOffset(raw,marker.to-start),strip=m>0&&/[ \t]/.test(node.value[m-1])?m-1:m;
     if(b<=strip||a>=n){const shift=a>=n?n-strip:0;result.exact={kind:"text",nodeFrom:start,nodeTo:end,from:a-shift,to:b-shift,value:node.value.slice(0,strip)+node.value.slice(n)};}
    }else result.exact={kind:"text",nodeFrom:start,nodeTo:end,from:a,to:b,value:node.value};
   }
  }
 }
 tree.children.forEach(node=>visit(node));return result;
}
export function rehypeSearchBlock(search?:PreviewSearch){
 return (root:Root)=>{
  if(!search?.block)return;
  const block=search.block;
  function visit(parent:Root|Element){
   parent.children=(parent.children as RootContent[]).flatMap((node):RootContent[]=>{
    if(node.type!=="element")return [node];
    if(node.position?.start.offset===block.from&&node.tagName===block.tag){
     const properties={"data-search-block":search!.serial,className:search!.exact?["search-hit-container"]:["search-hit-block"]};
     if(node.tagName==="pre")return [{type:"element",tagName:"div",properties,children:[node]} as Element];
     node.properties={...node.properties,...properties,className:[...(Array.isArray(node.properties.className)?node.properties.className:[]),...properties.className]};
     return [node];
    }
    visit(node);return [node];
   }) as typeof parent.children;
  }
  visit(root);
 };
}
function splitText(node:Text,from:number,to:number,serial:number):RootContent[]{
 const parts:RootContent[]=[];
 if(from>0)parts.push({type:"text",value:node.value.slice(0,from)});
 parts.push({type:"element",tagName:"mark",properties:{className:["search-hit-mark"],"data-search-hit":serial},children:[{type:"text",value:node.value.slice(from,to)}]});
 if(to<node.value.length)parts.push({type:"text",value:node.value.slice(to)});
 return parts;
}
export function rehypeSearchMark(search?:PreviewSearch){
 return (root:Root)=>{
  if(!search?.exact)return;
  const {exact,serial}=search;
  function codeMark(node:Element){
   if(textOf(node)!==exact!.value)return;
   let offset=0;
   function walk(parent:Element){
    parent.children=parent.children.flatMap(child=>{
     if(child.type==="element"){walk(child);return [child];}
     if(child.type!=="text")return [child];
     const start=offset;offset+=child.value.length;
     const from=Math.max(0,exact!.from-start),to=Math.min(child.value.length,exact!.to-start);
     return from<to?splitText(child,from,to,serial):[child];
    }) as Element["children"];
   }
   walk(node);
  }
  function walk(parent:Root|Element){
   parent.children=(parent.children as RootContent[]).flatMap((node):RootContent[]=>{
    const start=node.position?.start.offset,end=node.position?.end.offset;
    if(exact!.kind==="text"&&node.type==="text"&&start===exact!.nodeFrom&&end===exact!.nodeTo&&node.value===exact!.value)return splitText(node,exact!.from,exact!.to,serial);
    if(node.type==="element"){
     if(exact!.kind==="code"&&node.tagName==="code"&&start===exact!.nodeFrom&&end===exact!.nodeTo){codeMark(node);return [node];}
     walk(node);
    }
    return [node];
   }) as typeof parent.children;
  }
  walk(root);
 };
}
