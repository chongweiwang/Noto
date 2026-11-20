import type {Element,Root,RootContent} from "hast";
import {blockIndex,findBlock,type BlockMarker} from "./wiki-block";
import {normalizeSearchText,rawSearchOffset} from "./note-search";

// Hide only a uniquely identified marker whose raw text can be mapped without
// guessing; keep invalid and ambiguous markers visible for correction.
export function rehypeBlockLocations(options:{navigation?:boolean;anchors?:Map<string,string>;skipEmbeds?:boolean}={}){
 return (root:Root,file:{value:unknown})=>{
  const source=String(file.value),index=blockIndex(source),markers:BlockMarker[]=[];
  const targets=new Map<string,{from:number;id?:string;kind:string}>(),used=new Set<string>();
  function reserve(node:Root|Element){for(const child of node.children)if(child.type==="element"){if(child.properties.id)used.add(String(child.properties.id));reserve(child);}}reserve(root);
  const tags={paragraph:"p",listItem:"li",list:"",blockquote:"blockquote",table:"table"};
  for(const block of index.blocks){
   const unique=block.markers.length===1&&findBlock(index,block.markers[0].id).status==="resolved";
   if(unique)markers.push(block.markers[0]);
   const tag=block.kind==="list"?"list":tags[block.kind];targets.set(block.from+":"+tag,{from:block.from,id:unique?block.markers[0].id:undefined,kind:block.kind});
  }
  function visit(parent:Root|Element){
   parent.children=(parent.children as RootContent[]).flatMap((node):RootContent[]=>{
    const from=node.position?.start.offset,to=node.position?.end.offset;
    if(node.type==="element"){
     if(options.skipEmbeds&&node.properties["data-embed-origin"])return [node];
     if(node.tagName==="p"&&from!==undefined&&to!==undefined&&markers.some(marker=>marker.standalone&&marker.from===from&&marker.to<=to))return [];
     if(from!==undefined){const tag=node.tagName==="ul"||node.tagName==="ol"?"list":node.tagName;const target=targets.get(from+":"+tag);if(target){
      if(options.navigation!==false){node.properties["data-block-from"]=target.from;node.properties["data-block-kind"]=target.kind;}
      if(options.anchors&&target.id){const base="noto-block-"+target.id.toLowerCase();let id=base,n=1;while(used.has(id))id=base+"-"+n++;used.add(id);node.properties.id=id;options.anchors.set(target.id.toLowerCase(),id);}
     }}
     visit(node);return [node];
    }
    if(node.type==="text"&&from!==undefined&&to!==undefined){
     const marker=markers.find(item=>!item.standalone&&item.from>=from&&item.to<=to);
     const raw=source.slice(from,to);
     if(marker&&normalizeSearchText(raw)===node.value){
      const start=rawSearchOffset(raw,marker.from-from),end=rawSearchOffset(raw,marker.to-from);
      const strip=start>0&&/[ \t]/.test(node.value[start-1])?start-1:start;
      return [{...node,value:node.value.slice(0,strip)+node.value.slice(end)}];
     }
    }
    return [node];
   }) as typeof parent.children;
  }
  visit(root);
 };
}
