import {findHeading,type HeadingEntry} from "./heading-index";
import {resolveWikiTarget,headingProblem} from "./wiki-target";
import {findBlock,type BlockIndex} from "./wiki-block";
export type WikiServices={
 load:(target:string,source:string)=>Promise<{path:string;headings:HeadingEntry[]}>;
 loadBlocks?:(target:string,source:string)=>Promise<{path:string;blocks:BlockIndex}>;
 lookup:(path:string)=>HeadingEntry[]|undefined;
 lookupBlocks?:(path:string)=>BlockIndex|undefined;
 feedback:(message:string,source:string)=>void;
};
export type WikiOpen=(target:string,source?:string,chosen?:string)=>void;
export function wikiPresentation(target:string,source:string,paths:string[],services?:WikiServices){
 const parsed=resolveWikiTarget(target,source,paths),base="wiki-link";
 if(parsed.invalid)return {className:base+" wiki-unresolved",title:!parsed.file?"同篇标题仅用于 Markdown 笔记":"无效 Wiki 路径"};
 if(!parsed.candidates.length)return {className:base+" wiki-unresolved",title:"未找到笔记："+parsed.file};
 if(parsed.candidates.length>1)return {className:base+" wiki-unresolved",title:"存在同名笔记："+parsed.file};
 const path=parsed.candidates[0];
 if(parsed.fragment===null)return {className:base,title:"笔记："+path};
 const problem=headingProblem(parsed.fragment);
 if(problem)return {className:base+" wiki-unresolved",title:problem};
 if(parsed.fragment.startsWith("^")){
  const blocks=services?.lookupBlocks?.(path);
  if(!blocks)return {className:base+" wiki-heading wiki-unverified",title:path+"#"+parsed.fragment+"（块尚未验证）"};
  const hit=findBlock(blocks,parsed.fragment.slice(1));
  return hit.status==="resolved"?{className:base,title:"块："+path+"#"+parsed.fragment}:{className:base+" wiki-unresolved",title:hit.status==="ambiguous"?"块 ID 重复或归属不明确":"文件存在，块不存在"};
 }
 const headings=services?.lookup(path);
 if(!headings)return {className:base+" wiki-heading wiki-unverified",title:path+"#"+parsed.fragment+"（标题尚未验证）"};
 const heading=findHeading(headings,parsed.fragment);
 return heading?{className:base+" wiki-heading",title:path+"#"+heading.id}:{className:base+" wiki-unresolved",title:"文件存在，标题不存在："+path+"#"+parsed.fragment};
}
