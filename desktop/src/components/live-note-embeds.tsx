"use client";
import {createRoot,type Root} from "react-dom/client";
import {RangeSetBuilder} from "@codemirror/state";
import {Decoration,EditorView,ViewPlugin,WidgetType,type DecorationSet,type ViewUpdate} from "@codemirror/view";
import {parseNoteEmbeds,resolveEmbed} from "../lib/note-embed";
import {isDrawing} from "../lib/document-kind";
import {WorkspaceRuntimeContext,type WorkspaceRuntime} from "../lib/workspace-runtime";
import type {WikiOpen,WikiServices} from "../lib/wiki-ui";
import {MarkdownPreview} from "./markdown-preview";

type Config={runtime:WorkspaceRuntime;path:string;paths:string[];drawingPaths:string[];scope:string;revision:number;active:boolean;open:WikiOpen;openDocument:(path:string)=>void;services?:WikiServices;error:(value:string)=>void};
const roots=new WeakMap<HTMLElement,Root>();
class EmbedWidget extends WidgetType {
 constructor(readonly from:number,readonly source:string,readonly config:Config,readonly overLimit:boolean){super();}
 eq(other:EmbedWidget){return this.from===other.from&&this.source===other.source&&this.overLimit===other.overLimit&&this.config.scope===other.config.scope&&this.config.revision===other.config.revision&&this.config.active===other.config.active&&this.config.paths.join("\0")===other.config.paths.join("\0")&&this.config.drawingPaths.join("\0")===other.config.drawingPaths.join("\0");}
 toDOM(view:EditorView){
  const holder=document.createElement("span");holder.className="live-note-embed";
  const edit=document.createElement("button");edit.type="button";edit.textContent="编辑嵌入语法";
  const editSource=()=>{if(view.state.sliceDoc(this.from,this.from+this.source.length)!==this.source)return;view.dispatch({selection:{anchor:this.from},scrollIntoView:true});view.focus();};
  edit.addEventListener("mousedown",event=>{event.preventDefault();editSource();});
  edit.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();editSource();}});
  holder.append(edit);
  if(this.overLimit){const hint=document.createElement("span");hint.textContent=" 嵌入数量超过上限 ";holder.append(hint);const open=document.createElement("button");open.type="button";open.textContent="打开来源";open.addEventListener("click",()=>{const target=parseNoteEmbeds(this.source)[0]?.target;if(target){const resolved=resolveEmbed(target,this.config.path,this.config.paths,this.config.drawingPaths);if(resolved.path&&isDrawing(resolved.path))this.config.openDocument(resolved.path);else this.config.open(target,this.config.path);}});holder.append(open);return holder;}
  const mount=document.createElement("span");holder.append(mount);
  const root=createRoot(mount);roots.set(holder,root);
  queueMicrotask(()=>{if(roots.get(holder)!==root)return;root.render(<WorkspaceRuntimeContext.Provider value={this.config.runtime}><MarkdownPreview note={this.config.path} content={this.source} wikiPaths={this.config.paths} drawingPaths={this.config.drawingPaths} onOpenNote={this.config.openDocument} onWikiOpen={this.config.open} wikiServices={this.config.services} onError={this.config.error} embedScope={this.config.scope} embedRevision={this.config.revision} embedActive={this.config.active}/></WorkspaceRuntimeContext.Provider>);});
  return holder;
 }
 ignoreEvent(){return true;}
 destroy(dom:HTMLElement){const root=roots.get(dom);roots.delete(dom);if(root)queueMicrotask(()=>root.unmount());}
}
export function liveNoteEmbeds(config:Config){
 return ViewPlugin.fromClass(class {
  decorations:DecorationSet;
  constructor(view:EditorView){this.decorations=this.build(view);}
  build(view:EditorView){
   const builder=new RangeSetBuilder<Decoration>(),doc=view.state.doc;
   const ranges=view.state.selection.ranges;
   let index=0;for(const embed of parseNoteEmbeds(doc.toString())){
    const overLimit=index++>=100;
    if(!embed.standalone||embed.from<view.viewport.from||embed.to>view.viewport.to)continue;
    const line=doc.lineAt(embed.from);
    if(ranges.some(range=>range.from<=line.to&&range.to>=line.from))continue;
    builder.add(embed.from,embed.to,Decoration.replace({widget:new EmbedWidget(embed.from,doc.sliceString(embed.from,embed.to),config,overLimit)}));
   }
   return builder.finish();
  }
  update(update:ViewUpdate){if(update.docChanged||update.selectionSet||update.viewportChanged)this.decorations=this.build(update.view);}
 },{decorations:plugin=>plugin.decorations});
}
