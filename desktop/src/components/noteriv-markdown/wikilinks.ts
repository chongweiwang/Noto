// Cursor-aware links and completion adapted from Noteriv (MIT; third_party/noteriv).
// File/heading access and navigation are supplied by Noto's protected workspace.
import {Facet,RangeSetBuilder} from "@codemirror/state";
import {autocompletion,type CompletionContext,type Completion} from "@codemirror/autocomplete";
import {Decoration,type DecorationSet,EditorView,ViewPlugin,type ViewUpdate,WidgetType} from "@codemirror/view";
import {decodeString} from "micromark-util-decode-string";
import {knowledgeForDoc,parseKnowledge,wikiCompletionAllowed,type WikiLink} from "../../lib/wiki-syntax";
import {wikiTargetForPath,resolveWikiTarget,formatWikiHeading,formatWikiBlock,encodeWikiText,wikiFileRange} from "../../lib/wiki-target";
import {blockIndex,findBlock} from "../../lib/wiki-block";
import {headingIndex} from "../../lib/heading-index";
import {wikiPresentation,type WikiServices} from "../../lib/wiki-ui";

export type WikiConfig={paths:string[];notePath?:string;onOpen:(target:string)=>void;services?:WikiServices;active?:()=>boolean};
const emptyConfig:WikiConfig={paths:[],onOpen:()=>{}};
export const wikiConfigFacet=Facet.define<WikiConfig,WikiConfig>({combine:values=>values.at(-1)??emptyConfig});
class WikiWidget extends WidgetType{
 constructor(readonly link:WikiLink,readonly config:WikiConfig){super();}
 eq(other:WikiWidget){return this.link.target===other.link.target&&this.link.label===other.link.label&&this.config===other.config;}
 toDOM(){
  const element=document.createElement("a"),info=wikiPresentation(this.link.target,this.config.notePath??"",this.config.paths,this.config.services);
  element.className=info.className;element.title=info.title;element.href="#";element.textContent=this.link.label;
  element.addEventListener("mousedown",event=>{event.preventDefault();event.stopPropagation();});
  element.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();this.config.onOpen(this.link.target);});
  return element;
 }
 ignoreEvent(){return true;}
}
function decorations(view:EditorView):DecorationSet{
 const builder=new RangeSetBuilder<Decoration>(),config=view.state.facet(wikiConfigFacet);
 for(const link of knowledgeForDoc(view.state.doc).wiki){
  const line=view.state.doc.lineAt(link.from);
  if(view.state.selection.ranges.some(selection=>selection.from<=line.to&&selection.to>=line.from))continue;
  if(link.to<view.viewport.from||link.from>view.viewport.to)continue;
  builder.add(link.from,link.to,Decoration.replace({widget:new WikiWidget(link,config)}));
 }
 return builder.finish();
}
export const wikiLinkPlugin=ViewPlugin.fromClass(class{
 decorations:DecorationSet;
 constructor(view:EditorView){this.decorations=decorations(view);}
 update(update:ViewUpdate){if(update.docChanged||update.selectionSet||update.viewportChanged||update.startState.facet(wikiConfigFacet)!==update.state.facet(wikiConfigFacet))this.decorations=decorations(update.view);}
},{decorations:plugin=>plugin.decorations});
export function openWikiAtCursor(view:EditorView){
 const position=view.state.selection.main.head,link=knowledgeForDoc(view.state.doc).wiki.find(item=>position>=item.from&&position<=item.to);
 if(!link)return false;view.state.facet(wikiConfigFacet).onOpen(link.target);return true;
}
function applyLink(view:EditorView,context:CompletionContext,start:number,formatted:string){
 const config=context.state.facet(wikiConfigFacet),current=view.state.facet(wikiConfigFacet);
 if(view.compositionStarted||config.active?.()===false||current.notePath!==config.notePath||current.paths.join("\0")!==config.paths.join("\0")||view.state.doc!==context.state.doc||view.state.selection.main.head!==context.pos)return;
 const source=view.state.doc.toString(),line=view.state.doc.lineAt(context.pos);
 let end=context.pos,suffix="";
 const existing=parseKnowledge(source).wiki.find(link=>link.from===start&&link.to>=context.pos);
 if(existing){const range=wikiFileRange(source,existing,existing.target);suffix=source.slice(range.to,existing.to-2);end=existing.to;}
 else {
  while(end<line.to&&end<context.pos+2&&source[end]==="]")end++;
  // An unfinished alias belongs to this link only when the rest of the line
  // can itself round-trip as a single Wiki; never consume unrelated prose.
  if(source[context.pos]==="|"){
   const raw=source.slice(start+2,line.to),trial="[["+raw+"]]",parsed=parseKnowledge(trial).wiki[0];
   if(parsed&&parsed.to===trial.length){const range=wikiFileRange(trial,parsed,parsed.target);suffix=trial.slice(range.to,-2);end=line.to;}
  }
 }
 const generated=parseKnowledge(formatted).wiki[0];if(!generated)throw new Error("无法安全插入 Wiki 链接");
 const range=wikiFileRange(formatted,generated,generated.target);
 const body=decodeString(suffix).includes("|")?formatted.slice(2,range.to)+suffix:formatted.slice(2,-2)+suffix;
 const insert=body+"]]";
 view.dispatch({changes:{from:start+2,to:end,insert},selection:{anchor:start+2+insert.length}});
}
export async function wikiCompletionSource(context:CompletionContext){
 if(context.view?.compositionStarted)return null;
 const line=context.state.doc.lineAt(context.pos),before=line.text.slice(0,context.pos-line.from),match=before.match(/\[\[([^\[\]\n|]*)$/);
 if(!match)return null;
 const start=context.pos-match[0].length,source=context.state.doc.toString();
 if(!wikiCompletionAllowed(source,start,context.pos))return null;
 const config=context.state.facet(wikiConfigFacet),path=config.notePath??"",target=decodeString(match[1]);
 if(target.includes("|"))return null;
 const destination=resolveWikiTarget(target,path,config.paths);
 if(destination.fragment?.startsWith("^")){
  try{
   config.services?.feedback("正在读取块…",path);
   const result=config.services?.loadBlocks?await config.services.loadBlocks(target,path):destination.candidates.length===1&&destination.candidates[0]===path?{path,blocks:blockIndex(source)}:null;
   if(context.aborted||context.view?.compositionStarted||config.active?.()===false)return null;
   if(!result)throw new Error("块补全需要明确的 Markdown 目标");
   const query=destination.fragment.slice(1).toLowerCase();
   const found=result.blocks.blocks.filter(block=>block.markers.length===1&&findBlock(result.blocks,block.markers[0].id).status==="resolved"&&(block.markers[0].id.toLowerCase().includes(query)||block.snippet.toLowerCase().includes(query)));
   config.services?.feedback(found.length?"块补全："+Math.min(50,found.length)+" / "+found.length+" 项":"没有匹配的块",path);
   const options:Completion[]=found.slice(0,50).map(block=>({label:block.markers[0].id,detail:block.kind+" · 第 "+block.line+" 行 · "+block.snippet,type:"text",apply(view){try{applyLink(view,context,start,formatWikiBlock(result.path,block.markers[0].id,block.snippet,config.paths));}catch(cause){config.services?.feedback(cause instanceof Error?cause.message:String(cause),path);}}}));
   return {from:start+2,options,filter:false};
  }catch(cause){if(!context.aborted&&config.active?.()!==false)config.services?.feedback("块补全："+(cause instanceof Error?cause.message:String(cause)),path);return null;}
 }
 if(target.includes("#")&&destination.fragment!==null){
  try{
   config.services?.feedback("正在读取标题…",path);
   const result=config.services?await config.services.load(target,path):
    destination.candidates.length===1&&destination.candidates[0]===path?{path,headings:headingIndex(source)}:null;
   if(context.aborted||context.view?.compositionStarted||config.active?.()===false)return null;
   if(!result)throw new Error("标题补全需要明确的 Markdown 目标");
   const query=(destination.fragment??"").toLowerCase();
   const found=result.headings.filter(h=>h.text.toLowerCase().includes(query)||h.id.toLowerCase().includes(query));
   config.services?.feedback(found.length?"标题补全："+Math.min(50,found.length)+" / "+found.length+" 项":"没有匹配标题",path);
   const options:Completion[]=found.slice(0,50).map(heading=>({label:heading.text,detail:"H"+heading.level+" · 第 "+heading.line+" 行 · #"+heading.id,type:"text",
    apply(view){try{applyLink(view,context,start,formatWikiHeading(result.path,heading,config.paths));}catch(cause){config.services?.feedback(cause instanceof Error?cause.message:String(cause),path);}}
   }));
   return {from:start+2,options,filter:false};
  }catch(cause){if(!context.aborted&&config.active?.()!==false)config.services?.feedback("标题补全："+(cause instanceof Error?cause.message:String(cause)),path);return null;}
 }
 const query=target.toLowerCase();
 const options:Completion[]=config.paths.filter(file=>file.toLowerCase().includes(query)).slice(0,50).map(file=>({
  label:file.replace(/\.(?:md|markdown)$/i,""),detail:file,type:"text",
  apply(view){try{applyLink(view,context,start,"[["+encodeWikiText(wikiTargetForPath(file,config.paths))+"]]");}catch(cause){config.services?.feedback(String(cause),path);}}
 }));
 return {from:start+2,options,filter:false};
}
export const wikiCompletion=autocompletion({override:[wikiCompletionSource],activateOnTyping:true,activateOnTypingDelay:100});
