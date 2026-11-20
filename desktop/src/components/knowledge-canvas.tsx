"use client";
import type {WikiServices,WikiOpen} from "../lib/wiki-ui";
// Node layout, cubic edges, handles and viewport interactions adapted from Noteriv Canvas.tsx (MIT).
import {forwardRef,memo,useEffect,useId,useImperativeHandle,useMemo,useRef,useState,useLayoutEffect,type PointerEvent as ReactPointerEvent} from "react";
import {useWorkspaceRuntime} from "../lib/workspace-runtime";
import {MarkdownPreview} from "./markdown-preview";
import {CanvasHistory,canvasAnchor,canvasColor,canvasEdgeGeometry,canvasFilePath,canvasFreehand,canvasFreehandFallback,canvasSide,canvasVisible,canvasWorld,createCanvasFreehand,createCanvasNode,deleteCanvasSelection,duplicateCanvasNodes,fitCanvas,maxCanvasStrokePoints,moveCanvasNodes,movingCanvasIds,newCanvasId,parseCanvas,serializeCanvas,zoomCanvas,type CanvasData,type CanvasEdge,type CanvasNode,type CanvasViewport,type Point,type Side} from "../lib/canvas-document";
import {eraseCanvasFreehand} from "../lib/canvas-eraser";
import {canvasCapacityWarnings} from "../lib/canvas-capacity";
import {arrangeCanvasNodes,canvasLayoutUnits,snapCanvasMove,type CanvasGuide,type CanvasLayout} from "../lib/canvas-layout";
import {canvasArrowDirection,changeCanvasArrow,changeCanvasEdgeSide,nearestCanvasSide,reconnectCanvasEdge,type CanvasArrowDirection,type CanvasEdgeEnd} from "../lib/canvas-connection";
import {eraserSize as normalizeEraserSize,eraserSizes} from "../lib/eraser-settings";
import {CanvasResources,isCanvasImage,type CanvasResource} from "../lib/canvas-resources";
import {documentPaths,isDocument,isDrawing,isMarkdown,vaultDragType} from "../lib/document-kind";
import {relativePath} from "../lib/vault-structure";
import {readAttachment} from "../lib/attachment-input";
import {copyText} from "../lib/ui-actions";
import {WorkspaceIcon} from "./workspace-icon";
import type {Entry} from "../lib/vault-api";
import type {CanvasViewState} from "../lib/workspace-state";

export type CanvasHandle={flushImports:()=>Promise<void>;hasPendingImports:()=>boolean;focus:()=>void;capture:()=>CanvasViewState;chooseImages:()=>void;resetHistory:()=>void};
type Props={
 path:string;value:string;active:boolean;disabled:boolean;entries:Entry[];scope:string;revision:number;initialState?:CanvasViewState;
 onChange:(value:string)=>void;onError:(message:string)=>void;onOpen:(path:string,anchor?:string)=>void;onWikiOpen:WikiOpen;wikiServices?:WikiServices;
 onViewChange:(state:CanvasViewState)=>void;onImportState:(pending:boolean)=>void;onImported:(path:string)=>void;
};
type StrokePreview={points:Point[];color:string;width:number};
type ErasePreview={data:CanvasData;last:Point;points:Point[];radius:number};
type Gesture={kind:"move"|"resize"|"pan"|"box"|"edge"|"edge-end"|"draw"|"erase";pointer:number;capture:Element;start:Point;world:Point;base:string;data:CanvasData;viewport:CanvasViewport;ids:Set<string>;node?:CanvasNode;corner?:string;side?:Side;draw?:StrokePreview;erase?:ErasePreview;edgeEnd?:{edge:CanvasEdge;end:CanvasEdgeEnd}};
type CanvasMenu=Point&{world:Point};
const defaultCanvasStrokeColor="#3b82f6";
const canvasStrokeColors=[defaultCanvasStrokeColor,"#e86b76","#65a77c","#d69152","#aa80c4","#ffffff","#1f2937"];
const canvasSides:Side[]=["top","right","bottom","left"],sideLabels:Record<Side,string>={top:"上",right:"右",bottom:"下",left:"左"};
const imageName=(name:string)=>isCanvasImage(name);
const activeCardControls="a,button,input,textarea,select,summary,.markdown-image-open,[contenteditable=true]";
function importedPath(canvas:string,relative:string){
 const parts=canvas.split("/").slice(0,-1);
 for(const p of relative.split("/")){if(p===".")continue;if(p===".."){if(!parts.length)throw new Error("附件路径超出知识库");parts.pop();}else parts.push(p);}
 const file=parts.join("/");if(!canvasFilePath(file))throw new Error("附件路径无效");return file;
}
type FilePreviewProps = {
 file:string;pool:CanvasResources;epoch:number;active:boolean;onOpenFile:()=>void;wikiPaths:string[];
} & Pick<Props,"onOpen"|"onWikiOpen"|"wikiServices"|"onError">;
const FilePreview=memo(function FilePreview({file,pool,epoch,active,onOpenFile,wikiPaths,onOpen,onWikiOpen,wikiServices,onError}:FilePreviewProps){
 const [result,setResult]=useState<{file:string;value:CanvasResource}|null>(null),[error,setError]=useState("");
 const value=result?.file===file?result.value:null;
 useEffect(()=>{
  if(!active)return;
  let alive=true;setError("");
  void pool.load(file).then(v=>{if(alive)setResult(previous=>previous?.file===file&&previous.value.text===v.text&&previous.value.image===v.image&&previous.value.version===v.version&&previous.value.previewMarkdown===v.previewMarkdown?previous:{file,value:v});},e=>{if(alive){setResult(null);setError(e instanceof Error?e.message:String(e));}});
  return ()=>{alive=false;};
 },[file,pool,epoch,active]);
 if(error)return <div className="canvas-file-body"><div className="canvas-resource-error" role="status"><strong>引用暂不可用</strong><span>{error}</span><small>检查原文件，或使用“刷新引用”重试。</small></div></div>;
 if(value?.image&&isDrawing(file))return <div className="canvas-file-body">
  <button type="button" className="canvas-drawing-preview" aria-label={"打开白板 "+file} onPointerDown={event=>event.stopPropagation()} onClick={onOpenFile}>
   <img src={value.image} alt={file} draggable={false} onError={()=>setError("白板预览无法解码，请打开原白板或刷新引用")}/><small>已保存白板</small>
  </button></div>;
 if(value?.image)return <div className="canvas-file-body"><img src={value.image} alt={file} draggable={false} onError={()=>setError("图片无法解码，请检查原文件或刷新引用")}/></div>;
 if(isMarkdown(file))return <div className="canvas-file-body canvas-note-preview">
  {value
   ? <MarkdownPreview note={file} content={value.previewMarkdown??value.text} onOpenNote={onOpen} onWikiOpen={onWikiOpen}
       wikiPaths={wikiPaths} wikiServices={wikiServices} onError={onError} checkboxesDisabled nested hideHtml embedActive={false}/>
   : <p role="status">正在读取笔记…</p>}
 </div>;
 return <div className="canvas-file-body"><small>{file}</small><p>{value?.text??(imageName(file)?"正在读取图片…":isDrawing(file)?"正在读取白板…":"正在读取文件…")}</p></div>;
});
const CanvasStroke=memo(function CanvasStroke({node,zoom}:{node:CanvasNode;zoom:number}){
 const stroke=canvasFreehand(node)!;
 const points=stroke.points.map(([x,y])=>({x:x*node.width,y:y*node.height}));
 const coordinates=points.map(p=>`${p.x},${p.y}`).join(" ");
 return <svg className="canvas-freehand-svg" viewBox={`0 0 ${node.width} ${node.height}`} preserveAspectRatio="none" aria-hidden="true">
  {points.length===1?<><circle cx={points[0].x} cy={points[0].y} r={stroke.strokeWidth/2} fill={stroke.strokeColor}/><circle className="canvas-freehand-hit" cx={points[0].x} cy={points[0].y} r={Math.max(stroke.strokeWidth/2,7/zoom)} fill="transparent"/></>:<><polyline points={coordinates} fill="none" stroke={stroke.strokeColor} strokeWidth={stroke.strokeWidth} strokeLinecap="round" strokeLinejoin="round"/><polyline className="canvas-freehand-hit" points={coordinates} fill="none" stroke="transparent" strokeWidth={Math.max(stroke.strokeWidth,14/zoom)} strokeLinecap="round" strokeLinejoin="round"/></>}
 </svg>;
});
const CanvasMinimap=memo(function CanvasMinimap({nodes,viewport,size,onNavigate}:{nodes:CanvasNode[];viewport:CanvasViewport;size:{width:number;height:number};onNavigate:(point:Point)=>void}){
 if(!nodes.length)return null;
 const view={x:-viewport.x/viewport.zoom,y:-viewport.y/viewport.zoom,width:size.width/viewport.zoom,height:size.height/viewport.zoom};
 const minX=Math.min(view.x,...nodes.map(n=>n.x))-40,minY=Math.min(view.y,...nodes.map(n=>n.y))-40;
 const maxX=Math.max(view.x+view.width,...nodes.map(n=>n.x+n.width))+40,maxY=Math.max(view.y+view.height,...nodes.map(n=>n.y+n.height))+40;
 const scale=Math.min(154/Math.max(1,maxX-minX),94/Math.max(1,maxY-minY));
 const ox=(160-(maxX-minX)*scale)/2,oy=(100-(maxY-minY)*scale)/2;
 const x=(n:number)=>ox+(n-minX)*scale,y=(n:number)=>oy+(n-minY)*scale;
 return <button type="button" className="canvas-minimap" aria-label="画布缩略图，点击定位" title="点击或使用方向键定位" onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>{
  const direction:Record<string,Point>={ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1}},delta=direction[event.key];
  if(delta){event.preventDefault();event.stopPropagation();onNavigate({x:view.x+view.width*(.5+delta.x*.25),y:view.y+view.height*(.5+delta.y*.25)});}
 }} onClick={event=>{
  const r=event.currentTarget.getBoundingClientRect();if(!r.width||!r.height)return;
  const keyboard=event.detail===0&&event.clientX===0&&event.clientY===0,px=keyboard?r.width/2:event.clientX-r.left,py=keyboard?r.height/2:event.clientY-r.top;
  onNavigate({x:minX+(px*160/r.width-ox)/scale,y:minY+(py*100/r.height-oy)/scale});
 }}><svg viewBox="0 0 160 100" aria-hidden="true" preserveAspectRatio="none">
  {nodes.map(n=><rect key={n.id} className={n.type==="group"?"minimap-group":"minimap-node"} x={x(n.x)} y={y(n.y)} width={Math.max(1,n.width*scale)} height={Math.max(1,n.height*scale)}/>)}
  <rect className="minimap-viewport" x={x(view.x)} y={y(view.y)} width={view.width*scale} height={view.height*scale}/>
 </svg></button>;
});
export const KnowledgeCanvas=forwardRef<CanvasHandle,Props>(function KnowledgeCanvas(props,ref){
 const {api}=useWorkspaceRuntime(),live=useRef(props);live.current=props;
 const source=useRef(props.value),history=useRef(new CanvasHistory());
 const [historyRevision,setHistoryRevision]=useState(0),[historyTrimmed,setHistoryTrimmed]=useState(false);
 const parsed=useMemo(()=>{try{return {data:parseCanvas(props.value),error:""};}catch(e){return {data:null,error:e instanceof Error?e.message:String(e)};}},[props.value]);
 const [viewport,setViewport]=useState<CanvasViewport>(props.initialState?.viewport??{x:0,y:0,zoom:1});
 const [grid,setGrid]=useState(props.initialState?.grid??true);
 const [selected,setSelected]=useState<string[]>(props.initialState?.selected??[]),[edge,setEdge]=useState<string|null>(null),[editing,setEditing]=useState<string|null>(null);
 const viewRef=useRef(viewport),selectedRef=useRef(selected);viewRef.current=viewport;selectedRef.current=selected;
 const [size,setSize]=useState({width:800,height:600}),[preview,setPreview]=useState<CanvasData|null>(null);
 const [box,setBox]=useState<{x:number;y:number;width:number;height:number}|null>(null),[connection,setConnection]=useState<{from:Point;to:Point}|null>(null);
 const [guides,setGuides]=useState<CanvasGuide[]>([]);
 const [tool,setTool]=useState<"select"|"draw"|"erase">("select"),[strokeColor,setStrokeColor]=useState(defaultCanvasStrokeColor),[strokeWidth,setStrokeWidth]=useState(3),[strokePreview,setStrokePreview]=useState<StrokePreview|null>(null);
 const [eraserSize,setEraserSize]=useState(()=>normalizeEraserSize(props.initialState?.eraserSize));
 const eraserSizeRef=useRef(eraserSize);eraserSizeRef.current=eraserSize;
 const [picker,setPicker]=useState<"note"|"image"|"drawing"|null>(null),[query,setQuery]=useState(""),[menu,setMenu]=useState<CanvasMenu|null>(null),[notice,setNotice]=useState("");
 const [epoch,setEpoch]=useState(0),[space,setSpace]=useState(false);
 const groupInput=useRef<HTMLInputElement>(null);
 const stage=useRef<HTMLDivElement>(null),fileInput=useRef<HTMLInputElement>(null),textInput=useRef<HTMLTextAreaElement>(null),eraserCursor=useRef<HTMLDivElement>(null);
 const alive=useRef(true),fitOnce=useRef(!!props.initialState),gesture=useRef<Gesture|null>(null),raf=useRef(0),pending=useRef(new Set<Promise<void>>());
 const pool=useMemo(()=>new CanvasResources(api,props.path),[api,props.path]);
 const resourcesRevision=useRef(props.revision);
 const prefix=useId().replace(/[^a-z\d_-]/gi,"")+"canvas";
 const data=preview??parsed.data,disabled=props.disabled||!parsed.data,interactive=props.active&&!disabled;
 const error=(cause:unknown)=>{const message=cause instanceof Error?cause.message:String(cause);setNotice(message);live.current.onError(message);};
 function choose(ids:string[]){selectedRef.current=ids;setSelected(ids);setEdge(null);}
 function updateViewport(next:CanvasViewport){viewRef.current=next;setViewport(next);}
 function cancel(){
  const old=gesture.current;gesture.current=null;cancelAnimationFrame(raf.current);raf.current=0;
  setPreview(null);setBox(null);setConnection(null);setGuides([]);setStrokePreview(null);
  if(old)try{old.capture.releasePointerCapture?.(old.pointer);}catch{}
 }
 useLayoutEffect(()=>{
  if(props.value!==source.current){
   source.current=props.value;history.current.clear();setHistoryTrimmed(false);setHistoryRevision(n=>n+1);cancel();
   setNotice("画布内容已更新，失效的撤销历史已重置。");
  }
 },[props.value]);
 useEffect(()=>{
  if(!props.active||props.disabled){cancel();setSpace(false);setMenu(null);setPicker(null);}
 },[props.active,props.disabled]);
 useEffect(()=>{
  alive.current=true;return ()=>{alive.current=false;cancelAnimationFrame(raf.current);pool.dispose();};
 },[pool]);
 useEffect(()=>{
  const el=stage.current;if(!el)return;
  const observer=new ResizeObserver(entries=>{
   const {width,height}=entries[0]?.contentRect??{};if(width>0&&height>0)setSize({width,height});
  });observer.observe(el);return ()=>observer.disconnect();
 },[!!parsed.data]);
 useEffect(()=>{
  const element=stage.current;if(!element)return;
  const wheel=(event:WheelEvent)=>{
   if(!live.current.active||(event.target as Element).closest(".canvas-node-body"))return;
   if(gesture.current){event.preventDefault();return;}
   event.preventDefault();const rect=element.getBoundingClientRect();
   updateViewport(zoomCanvas(viewRef.current,{x:event.clientX-rect.left,y:event.clientY-rect.top},viewRef.current.zoom*Math.exp(-event.deltaY*.0015)));
  };
  element.addEventListener("wheel",wheel,{passive:false});
  return ()=>element.removeEventListener("wheel",wheel);
 },[!!parsed.data]);
 useEffect(()=>{
  if(!parsed.data)return;
  const ids=new Set(parsed.data.nodes.map(n=>n.id)),next=selectedRef.current.filter(id=>ids.has(id));
  if(next.length!==selectedRef.current.length)choose(next);
  if(editing&&!ids.has(editing))setEditing(null);
  if(edge&&!parsed.data.edges.some(e=>e.id===edge))setEdge(null);
 },[parsed.data]);
 useEffect(()=>{
  if(props.active&&parsed.data&&!fitOnce.current&&stage.current?.clientWidth){
   fitOnce.current=true;updateViewport(fitCanvas(parsed.data.nodes,stage.current.clientWidth,stage.current.clientHeight||600));
  }
 },[props.active,parsed.data,size]);
 useEffect(()=>{live.current.onViewChange({viewport,selected,eraserSize,grid});},[viewport,selected,eraserSize,grid]);
 useEffect(()=>{
  if(props.active&&editing)(textInput.current??groupInput.current)?.focus();
 },[props.active,editing]);
 useEffect(()=>{
  if(!props.active)return;
  const interval=setInterval(()=>setEpoch(n=>n+1),5000);return ()=>clearInterval(interval);
 },[props.active]);
 useEffect(()=>{
  if(resourcesRevision.current!==props.revision){resourcesRevision.current=props.revision;pool.invalidate();setEpoch(n=>n+1);}
 },[props.revision,pool]);
 useEffect(()=>{
  if(!props.active)return;
  const blur=()=>{cancel();setSpace(false);},hide=()=>{if(document.hidden)blur();};
  window.addEventListener("blur",blur);document.addEventListener("visibilitychange",hide);
  return ()=>{window.removeEventListener("blur",blur);document.removeEventListener("visibilitychange",hide);};
 },[props.active]);

 function commit(next:CanvasData,group?:string,allowBusy=false){
  if(!alive.current||(!allowBusy&&live.current.disabled))return false;
  try {
   const value=serializeCanvas(next),before=source.current;
   if(before===value)return true;
   if(history.current.record(before,value,group))setHistoryTrimmed(true);source.current=value;live.current.onChange(value);
   setHistoryRevision(n=>n+1);return true;
  }catch(e){error(e);return false;}
 }
 function current(){return parseCanvas(source.current);}
 function undo(redo=false){
  if(disabled)return;
  cancel();const value=redo?history.current.redo(source.current):history.current.undo(source.current);
  if(value!==null){source.current=value;live.current.onChange(value);setHistoryRevision(n=>n+1);}
 }
 function center():Point{return canvasWorld({x:size.width/2,y:size.height/2},viewRef.current);}
 function selectTool(next:"select"|"draw"|"erase"){
  cancel();setTool(next);setEditing(null);setMenu(null);if(next!=="select")choose([]);stage.current?.focus();
 }
 function add(type:CanvasNode["type"],fields:Partial<CanvasNode>={},point=center()){
  if(disabled)return;
  if(tool!=="select"){cancel();setTool("select");}
  setMenu(null);const doc=current(),node=createCanvasNode(type,point,fields);
  node.x=Math.round(point.x-node.width/2);node.y=Math.round(point.y-node.height/2);
  if(commit({...doc,nodes:type==="group"?[node,...doc.nodes]:[...doc.nodes,node]})){choose([node.id]);if(type==="text")setEditing(node.id);}
 }
 function addSticky(point?:Point){add("text",{width:200,height:200,color:"#f9e2af",notoCardStyle:"sticky"},point);}
 function patchNode(id:string,patch:Partial<CanvasNode>,group?:string){
  const doc=current();commit({...doc,nodes:doc.nodes.map(n=>n.id===id?{...n,...patch}:n)},group);
 }
 function remove(){
  if(disabled||!selectedRef.current.length&&!edge)return;
  commit(deleteCanvasSelection(current(),new Set(selectedRef.current),edge));choose([]);setEdge(null);setEditing(null);setMenu(null);
 }
 function duplicate(){
  if(disabled||!selectedRef.current.length)return;
  const result=duplicateCanvasNodes(current(),new Set(selectedRef.current));if(commit(result.data))choose(result.ids);setMenu(null);
 }
 function layer(front:boolean){
  const doc=current(),ids=new Set(selectedRef.current),items=doc.nodes.filter(n=>ids.has(n.id)),other=doc.nodes.filter(n=>!ids.has(n.id));
  commit({...doc,nodes:front?[...other,...items]:[...items,...other]});setMenu(null);
 }
 function arrange(layout:CanvasLayout){
  if(disabled)return;
  try{cancel();const doc=current(),next=arrangeCanvasNodes(doc,new Set(selectedRef.current),layout);if(next===doc||commit(next))setNotice("");}
  catch(cause){error(cause);}
 }
 function edgeSide(end:CanvasEdgeEnd,side:Side|"auto"){
  if(disabled||!edge)return;cancel();const doc=current(),next=changeCanvasEdgeSide(doc,edge,end,side);if(next===doc||commit(next))setNotice("");
 }
 function edgeArrow(direction:CanvasArrowDirection){
  if(disabled||!edge)return;cancel();const doc=current(),next=changeCanvasArrow(doc,edge,direction);if(next===doc||commit(next))setNotice("");
 }
 function changeColor(color:string){
  const doc=current();
  commit(edge?{...doc,edges:doc.edges.map(e=>e.id===edge?{...e,color:color||undefined}:e)}:{...doc,nodes:doc.nodes.map(n=>{
   if(!selectedRef.current.includes(n.id))return n;
   const drawing=canvasFreehand(n);
   return {...n,color:color||undefined,...(drawing?{notoDrawing:{...drawing,strokeColor:color?canvasColor(color):defaultCanvasStrokeColor}}:{})};
  })});
 }
 function attach(files:File[],point=center()){
  if(disabled||!alive.current)return;
  const work=(async()=>{
   for(const [index,file] of files.entries()){
    if(!imageName(file.name)){error(new Error("画布仅导入支持的图片文件"));continue;}
    try {
     if(!api.importAttachmentData)throw new Error("当前环境不支持图片导入");
     const bytes=await readAttachment(file),relative=await api.importAttachmentData(props.path,file.name,bytes);
     if(!alive.current)return;
     const doc=current(),node=createCanvasNode("file",{x:point.x+index*24-150,y:point.y+index*24-100},{file:importedPath(props.path,relative),width:300,height:240});
     if(commit({...doc,nodes:[...doc.nodes,node]},undefined,true)){choose([node.id]);live.current.onImported(relative);}
     else error(new Error("图片已导入 "+relative+"，但无法插入；请从已有图片中选择"));
    }catch(e){if(alive.current)error(e);}
   }
  })();
  pending.current.add(work);live.current.onImportState(true);
  void work.finally(()=>{pending.current.delete(work);if(alive.current)live.current.onImportState(pending.current.size>0);});
 }
 async function flushImports(){while(pending.current.size)await Promise.all([...pending.current]);}
 useImperativeHandle(ref,()=>({flushImports,hasPendingImports:()=>pending.current.size>0,focus:()=>{if(editing)(textInput.current??groupInput.current)?.focus();else stage.current?.focus();},capture:()=>({viewport:viewRef.current,selected:selectedRef.current,eraserSize:eraserSizeRef.current,grid}),chooseImages:()=>fileInput.current?.click(),resetHistory:()=>{cancel();setHistoryTrimmed(false);if(history.current.past.length||history.current.future.length){history.current.clear();setHistoryRevision(n=>n+1);setNotice("文件路径已调整，画布撤销历史已重置；当前内容和视口保留。");}}}),[editing,grid]);
 const local=(clientX:number,clientY:number)=>{const r=stage.current?.getBoundingClientRect();return {x:clientX-(r?.left??0),y:clientY-(r?.top??0)};};
 function moveEraserCursor(x:number,y:number){
  if(!eraserCursor.current)return;const p=local(x,y);eraserCursor.current.style.left=p.x+"px";eraserCursor.current.style.top=p.y+"px";eraserCursor.current.style.visibility="visible";
 }
 function begin(event:ReactPointerEvent,kind:Gesture["kind"],node?:CanvasNode,corner?:string,side?:Side,ids=new Set(selectedRef.current),edgeEnd?:Gesture["edgeEnd"]){
  if(!interactive||gesture.current||event.button!==0&&event.button!==1)return;
  event.preventDefault();event.stopPropagation();setMenu(null);
  const p=local(event.clientX,event.clientY),doc=current();
  const capture=event.currentTarget;
  const world=canvasWorld(p,viewRef.current),draw=kind==="draw"?{points:[world],color:strokeColor,width:strokeWidth}:undefined,erase=kind==="erase"?{data:doc,last:world,points:[],radius:eraserSize/2/viewRef.current.zoom}:undefined;
  gesture.current={kind,pointer:event.pointerId,capture,start:p,world,base:source.current,data:doc,viewport:viewRef.current,ids,node,corner,side,draw,erase,edgeEnd};
  if(draw)setStrokePreview({...draw,points:[world]});
  stage.current?.focus();
  try{capture.setPointerCapture?.(event.pointerId);}catch{}
  if(erase)try{step(event,false);}catch(cause){cancel();error(cause);}
 }
 function nodeDown(event:ReactPointerEvent,node:CanvasNode,resize?:string,side?:Side){
  if(!interactive||gesture.current)return;if(space||event.button===1){begin(event,"pan");return;}event.stopPropagation();setEditing(null);
  if(side){begin(event,"edge",node,undefined,side);return;}
  const selectedNow=selectedRef.current;
  if(event.shiftKey&&!resize){choose(selectedNow.includes(node.id)?selectedNow.filter(id=>id!==node.id):[...selectedNow,node.id]);return;}
  const ids=selectedNow.includes(node.id)?selectedNow:[node.id];choose(ids);
  begin(event,resize?"resize":"move",node,resize,undefined,movingCanvasIds(current(),ids));
 }
 function nodeAt(doc:CanvasData,point:Point,clientX:number,clientY:number,margin=0){
  const rect=stage.current?.getBoundingClientRect();
  if(rect&&rect.width>0&&rect.height>0&&(clientX<rect.left||clientX>rect.right||clientY<rect.top||clientY>rect.bottom))return undefined;
  const target=document.elementFromPoint?.(clientX,clientY);
  if(target&&(!stage.current?.contains(target)||target.closest(".canvas-minimap,.canvas-view-controls")))return undefined;
  const element=target?.closest<HTMLElement>("[data-canvas-node]");
  const hit=element?doc.nodes.find(n=>n.id===element.dataset.canvasNode):undefined;
  const nodes=[...doc.nodes].reverse(),inside=(node:CanvasNode,pad:number)=>point.x>=node.x-pad&&point.x<=node.x+node.width+pad&&point.y>=node.y-pad&&point.y<=node.y+node.height+pad;
  return hit??nodes.find(node=>inside(node,0))??(margin?nodes.find(node=>inside(node,margin)):undefined);
 }
 function step(event:{clientX:number;clientY:number;altKey?:boolean},final=false){
  const g=gesture.current;if(!g)return;
  if(!live.current.active||live.current.disabled){cancel();return;}
  if(g.base!==source.current){cancel();return;}
  const p=local(event.clientX,event.clientY),dx=(p.x-g.start.x)/g.viewport.zoom,dy=(p.y-g.start.y)/g.viewport.zoom;
  const moved=Math.hypot(p.x-g.start.x,p.y-g.start.y)>=4;
  if(g.kind==="erase"){
   const erasing=g.erase!,points=erasing.points.splice(0);points.push(canvasWorld(p,g.viewport));
   for(const point of points){erasing.data=eraseCanvasFreehand(erasing.data,erasing.last,point,erasing.radius);erasing.last=point;}
   if(final){if(erasing.data!==g.data&&commit(erasing.data)){const ids=new Set(erasing.data.nodes.map(n=>n.id));choose(selectedRef.current.filter(id=>ids.has(id)));}}
   else if(erasing.data!==g.data)setPreview(erasing.data);
   return;
  }
  if(g.kind==="draw"){
   const drawing=g.draw!,world=canvasWorld(p,g.viewport),last=drawing.points.at(-1)!;
   if(final&&Math.hypot(world.x-last.x,world.y-last.y)>.001){
    if(drawing.points.length>=maxCanvasStrokePoints){cancel();error(new Error("单笔超过 10000 点，本次笔迹已取消"));return;}
    drawing.points.push(world);
   }
   if(final){const node=createCanvasFreehand(drawing.points,drawing.color,drawing.width);commit({...g.data,nodes:[...g.data.nodes,node]});}
   else setStrokePreview({...drawing,points:[...drawing.points]});
   return;
  }
  if(g.kind==="edge"){
   const end=canvasWorld(p,g.viewport);
   if(!final){setConnection({from:canvasAnchor(g.node!,g.side!),to:end});return;}
   const target=nodeAt(g.data,end,event.clientX,event.clientY);
   if(target&&target.id!==g.node!.id){
    if(g.data.edges.some(e=>e.fromNode===g.node!.id&&e.toNode===target.id)){setNotice("这两个节点已连接");return;}
    const e={id:newCanvasId(),fromNode:g.node!.id,toNode:target.id,fromSide:g.side!,toSide:canvasSide(target,g.node!)};
    if(commit({...g.data,edges:[...g.data.edges,e]})){choose([]);setEdge(e.id);}
   }
  }else if(g.kind==="edge-end"){
   const moving=g.edgeEnd!,edge=moving.edge,from=g.data.nodes.find(n=>n.id===edge.fromNode),to=g.data.nodes.find(n=>n.id===edge.toNode);
   if(!from||!to)return;
   const end=canvasWorld(p,g.viewport),fixed=moving.end==="from"?to:from,fixedSide=moving.end==="from"?(edge.toSide??canvasSide(to,from)):(edge.fromSide??canvasSide(from,to));
   if(!final){setConnection({from:canvasAnchor(fixed,fixedSide),to:end});return;}
   if(!moved)return;
   const target=nodeAt(g.data,end,event.clientX,event.clientY,8/g.viewport.zoom);
   if(!target||target.id===fixed.id){setNotice("请将连接端点拖到其他节点边缘。");return;}
   const next=reconnectCanvasEdge(g.data,edge.id,moving.end,target.id,nearestCanvasSide(target,end));
   if(next===g.data||commit(next))setNotice("");
  }else if(g.kind==="pan"){
   if(moved)updateViewport({...g.viewport,x:g.viewport.x+p.x-g.start.x,y:g.viewport.y+p.y-g.start.y});
   else if(final){choose([]);setEditing(null);}
  }else if(g.kind==="box"){
   const end=canvasWorld(p,g.viewport),rect={x:Math.min(end.x,g.world.x),y:Math.min(end.y,g.world.y),width:Math.abs(end.x-g.world.x),height:Math.abs(end.y-g.world.y)};
   setBox(rect);
   if(final&&moved)choose(g.data.nodes.filter(n=>n.x>=rect.x&&n.y>=rect.y&&n.x+n.width<=rect.x+rect.width&&n.y+n.height<=rect.y+rect.height).map(n=>n.id));
  }else if(g.kind==="move"){
   if(!moved){if(!final){setPreview(null);setGuides([]);}return;}
   const movement=event.altKey?{dx:Math.round(dx),dy:Math.round(dy),guides:[]}:snapCanvasMove(g.data,g.ids,dx,dy,g.viewport,size.width,size.height);
   const next=moveCanvasNodes(g.data,g.ids,movement.dx,movement.dy);
   if(final){if(movement.dx||movement.dy)commit(next);}else{setPreview(next);setGuides(movement.guides);}
  }else if(moved){
   const n=g.node!;
   const next={...g.data,nodes:g.data.nodes.map(item=>{
    if(item.id!==n.id)return item;
    const west=g.corner!.includes("w"),north=g.corner!.includes("n"),minimum=canvasFreehand(n)?1:100,minHeight=canvasFreehand(n)?1:60,width=Math.max(minimum,Math.round(n.width+(west?-dx:dx))),height=Math.max(minHeight,Math.round(n.height+(north?-dy:dy)));
    return {...item,width,height,x:west?n.x+n.width-width:n.x,y:north?n.y+n.height-height:n.y};
   })};
   if(final)commit(next);else setPreview(next);
  }
 }
 function pointerUp(event:ReactPointerEvent){
  if(!gesture.current||gesture.current.pointer!==event.pointerId)return;
  cancelAnimationFrame(raf.current);try{step(event,true);}catch(cause){error(cause);}finally{cancel();}
 }
 function openFile(file:string,subpath?:string){
  if(isDocument(file))live.current.onOpen(file,subpath?.slice(1));
  else void api.openAttachment(props.path,relativePath(props.path,file)).catch(error);
 }
 const candidates=useMemo(()=>{
  function flatten(items:Entry[]):Entry[]{return items.flatMap(e=>e.isDirectory?flatten(e.children):[e]);}
  return flatten(props.entries).filter(e=>picker==="image"?isCanvasImage(e.path):picker==="drawing"?isDrawing(e.path):isMarkdown(e.path)).filter(e=>!query||e.path.toLowerCase().includes(query.toLowerCase())).slice(0,100);
 },[props.entries,picker,query]);
 const fileList=useMemo(()=>documentPaths(props.entries).filter(isMarkdown),[props.entries]);
 const drawingList=useMemo(()=>documentPaths(props.entries).filter(isDrawing),[props.entries]);
 const nodeMap=useMemo(()=>new Map(data?.nodes.map(n=>[n.id,n])??[]),[data]);
 const visibleNodes=data?.nodes.filter(n=>editing===n.id||gesture.current?.ids.has(n.id)||canvasVisible(n,viewport,size.width,size.height))??[];
 const selectedEdge=data?.edges.find(e=>e.id===edge);
 const edgeFrom=selectedEdge&&nodeMap.get(selectedEdge.fromNode),edgeTo=selectedEdge&&nodeMap.get(selectedEdge.toNode);
 const edgeAnchors=selectedEdge&&edgeFrom&&edgeTo?{from:canvasAnchor(edgeFrom,selectedEdge.fromSide??canvasSide(edgeFrom,edgeTo)),to:canvasAnchor(edgeTo,selectedEdge.toSide??canvasSide(edgeTo,edgeFrom))}:null;
 const layoutCount=useMemo(()=>parsed.data&&selected.length>1?canvasLayoutUnits(parsed.data,new Set(selected)).length:0,[parsed.data,selected]);
 const colors=new Set(data?.nodes.filter(n=>selected.includes(n.id)).map(n=>canvasFreehand(n)?.strokeColor??n.color??"")??[]);
 const selectedColor=edge?(selectedEdge?.color??""):colors.size>1?"__mixed__":(colors.values().next().value??"");
 const warnings=useMemo(()=>parsed.data?canvasCapacityWarnings(parsed.data,props.value,history.current,historyTrimmed):[],[parsed.data,props.value,historyRevision,historyTrimmed]);
 if(!parsed.data)return <div className="canvas-invalid"><p role="alert">{parsed.error}。图形编辑已禁用，原始文件没有被转换。</p><button type="button" onClick={()=>{void copyText(props.value);}}>复制原文</button><details><summary>只读原文</summary><pre>{props.value}</pre></details></div>;
 return <div className="knowledge-canvas" data-capacity-warning={warnings.length?true:undefined} onPaste={event=>{
  if(!interactive||(event.target as HTMLElement).closest("input,textarea"))return;
  const files=[...event.clipboardData.files];if(files.length){event.preventDefault();attach(files);}
 }} onKeyDown={event=>{
  if(!props.active||event.nativeEvent.isComposing)return;
  if((event.target as HTMLElement).closest("button"))return;
  const input=(event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]");
  if(input){if(event.key==="Escape"){event.preventDefault();setEditing(null);setPicker(null);stage.current?.focus();}return;}
  if(event.key==="Escape"){event.preventDefault();cancel();setTool("select");setPicker(null);setMenu(null);setEditing(null);choose([]);setSpace(false);return;}
  if(event.code==="Space"){event.preventDefault();setSpace(true);}
  if(disabled)return;
  if(event.key==="Delete"||event.key==="Backspace"){event.preventDefault();remove();}
  if(event.ctrlKey||event.metaKey){
   if(event.key.toLowerCase()==="z"){event.preventDefault();undo(event.shiftKey);}
   if(event.key.toLowerCase()==="a"){event.preventDefault();choose(current().nodes.map(n=>n.id));}
   if(event.key.toLowerCase()==="d"){event.preventDefault();duplicate();}
  }else if(!event.altKey&&event.key.toLowerCase()==="d"){event.preventDefault();selectTool("draw");}
  else if(!event.altKey&&event.key.toLowerCase()==="v"){event.preventDefault();selectTool("select");}
  else if(!event.altKey&&event.key.toLowerCase()==="e"){event.preventDefault();selectTool("erase");}
 }} onKeyUp={event=>{if(event.code==="Space")setSpace(false);}}>
  <div className="canvas-toolbar" role="toolbar" aria-label="画布工具">
   <button type="button" aria-label="画布选择工具" title="选择（V）" aria-pressed={tool==="select"} disabled={disabled} onClick={()=>selectTool("select")}><WorkspaceIcon name="pointer"/></button>
   <button type="button" aria-label="画布画笔工具" title="画笔（D）" aria-pressed={tool==="draw"} disabled={disabled} onClick={()=>selectTool("draw")}><WorkspaceIcon name="drawing"/></button>
   <button type="button" aria-label="画布橡皮工具" title="橡皮（E）" aria-pressed={tool==="erase"} disabled={disabled} onClick={()=>selectTool("erase")}><WorkspaceIcon name="eraser"/></button>
   {tool==="erase"&&<div className="canvas-drawing-options" role="group" aria-label="画布橡皮设置"><label>橡皮尺寸<select aria-label="画布橡皮尺寸" value={eraserSize} disabled={disabled} onChange={event=>{cancel();setEraserSize(normalizeEraserSize(Number(event.target.value)));}}>{eraserSizes.map(size=><option key={size} value={size}>{size} px</option>)}</select></label></div>}
   {tool==="draw"&&<div className="canvas-drawing-options" role="group" aria-label="画布画笔样式"><label>颜色<input type="color" aria-label="画布画笔颜色" value={strokeColor} disabled={disabled} onChange={event=>setStrokeColor(event.target.value)}/></label><div className="canvas-drawing-presets" role="group" aria-label="画布常用笔色">{canvasStrokeColors.map(color=><button type="button" key={color} aria-label={"画布笔色 "+color} title={color} aria-pressed={strokeColor.toLowerCase()===color} disabled={disabled} style={{background:color}} onClick={()=>setStrokeColor(color)}/>)}</div><label>笔宽<select aria-label="画布画笔宽度" value={strokeWidth} disabled={disabled} onChange={event=>setStrokeWidth(Number(event.target.value))}>{[1,2,3,4,6,8,12,16].map(n=><option key={n} value={n}>{n} px</option>)}</select></label></div>}
   <span className="canvas-divider"/>
   <button type="button" aria-label="＋ 文本" title="添加文本" disabled={disabled} onClick={()=>add("text")}><WorkspaceIcon name="text"/><span>文本</span></button>
   <button type="button" aria-label="便签" title="添加便签" disabled={disabled} onClick={()=>addSticky()}><WorkspaceIcon name="sticky"/><span>便签</span></button>
   <button type="button" aria-label="笔记" title="添加笔记引用" disabled={disabled} onClick={()=>{setPicker("note");setQuery("");}}><WorkspaceIcon name="file"/><span>笔记</span></button>
   <button type="button" aria-label="白板" title="添加白板引用" disabled={disabled} onClick={()=>{setPicker("drawing");setQuery("");}}><WorkspaceIcon name="drawing"/><span>白板</span></button>
   <button type="button" aria-label="图片" title="选择知识库图片" disabled={disabled} onClick={()=>{setPicker("image");setQuery("");}}><WorkspaceIcon name="image"/><span>图片</span></button>
   <button type="button" aria-label="导入图片" title="导入图片" disabled={disabled} onClick={()=>fileInput.current?.click()}><WorkspaceIcon name="attachment"/><span>导入图片</span></button>
   <button type="button" aria-label="分组" title="添加分组" disabled={disabled} onClick={()=>add("group")}><WorkspaceIcon name="group"/><span>分组</span></button>
   <span className="canvas-divider"/>
   <button type="button" aria-label="画布撤销" title="撤销" disabled={disabled||!history.current.past.length} onClick={()=>undo()}><WorkspaceIcon name="undo"/></button>
   <button type="button" aria-label="画布重做" title="重做" disabled={disabled||!history.current.future.length} onClick={()=>undo(true)}><WorkspaceIcon name="redo"/></button>
   <button type="button" aria-label="刷新引用" title="刷新引用" onClick={()=>{pool.invalidate();setEpoch(n=>n+1);}}><WorkspaceIcon name="refresh"/></button>
  </div>
  <input ref={fileInput} className="canvas-file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/svg+xml" multiple aria-label="导入画布图片" onChange={event=>{attach([...(event.target.files??[])]);event.target.value="";}}/>
  <div ref={stage} role="region" aria-label="知识画布" data-grid={grid} tabIndex={props.active?0:-1} className={"canvas-viewport"+(space?" canvas-hand":tool==="draw"?" canvas-draw-mode":tool==="erase"?" canvas-erase-mode":"")} onPointerDown={event=>{
   if(event.target!==event.currentTarget&&!(event.target as Element).closest(".canvas-edge-layer"))return;
   if(event.button===2)return;
   if(tool==="erase"&&!space&&event.button===0)moveEraserCursor(event.clientX,event.clientY);
   setEditing(null);begin(event,!space&&event.button===0&&tool!=="select"?tool:event.shiftKey?"box":"pan");
  }} onPointerMove={event=>{
   if(gesture.current&&event.pointerId!==gesture.current.pointer)return;
   if(tool==="erase"&&!space&&interactive)moveEraserCursor(event.clientX,event.clientY);
   if(!gesture.current||event.pointerId!==gesture.current.pointer)return;
   if(gesture.current.kind==="draw"||gesture.current.kind==="erase"){
    const native=event.nativeEvent,events=typeof native.getCoalescedEvents==="function"?native.getCoalescedEvents():[];
    for(const item of events.length?events:[native]){
     const g=gesture.current;if(!g)return;
     const p=canvasWorld(local(item.clientX,item.clientY),g.viewport);
     if(g.erase){g.erase.points.push(p);continue;}
     if(g.draw){const last=g.draw.points.at(-1)!;if(Math.hypot(p.x-last.x,p.y-last.y)>=.75/g.viewport.zoom){
      if(g.draw.points.length>=maxCanvasStrokePoints){cancel();error(new Error("单笔超过 10000 点，本次笔迹已取消"));return;}g.draw.points.push(p);
     }}
    }
   }
   const point={clientX:event.clientX,clientY:event.clientY,altKey:event.altKey};cancelAnimationFrame(raf.current);raf.current=requestAnimationFrame(()=>{try{step(point);}catch(cause){cancel();error(cause);}});
  }} onPointerLeave={event=>{if((!gesture.current||gesture.current.pointer===event.pointerId)&&eraserCursor.current)eraserCursor.current.style.visibility="hidden";}} onPointerUp={pointerUp} onPointerCancel={event=>{if(gesture.current?.pointer===event.pointerId)cancel();}} onLostPointerCapture={event=>{if(gesture.current?.pointer===event.pointerId)cancel();}} onContextMenu={event=>{if(!interactive)return;event.preventDefault();setMenu({x:event.clientX,y:event.clientY,world:canvasWorld(local(event.clientX,event.clientY),viewRef.current)});}} onDragOver={event=>{
   if(interactive&&(event.dataTransfer.types.includes(vaultDragType)||event.dataTransfer.types.includes("Files"))){event.preventDefault();event.dataTransfer.dropEffect="copy";}
  }} onDrop={event=>{
   if(!interactive)return;event.preventDefault();event.stopPropagation();
   const p=canvasWorld(local(event.clientX,event.clientY),viewRef.current),files=[...event.dataTransfer.files];
   if(files.length){attach(files,p);return;}
   try{
    const payload=JSON.parse(event.dataTransfer.getData(vaultDragType));
    const flatten=(entries:Entry[]):Entry[]=>entries.flatMap(e=>e.isDirectory?flatten(e.children):[e]);
    if(payload.scope!==props.scope||!canvasFilePath(payload.path)||!flatten(props.entries).some(e=>e.path===payload.path))throw new Error("请从当前知识库拖入文件");
    add("file",{file:payload.path},p);
   }catch(e){error(e);}
  }}>
   <div className="canvas-transform" style={{transform:`translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`}}>
    <svg className="canvas-edge-layer" aria-label="画布连接">
     {data!.edges.map((e,index)=>{
      const from=nodeMap.get(e.fromNode),to=nodeMap.get(e.toNode);if(!from||!to)return null;
      const bounds={...from,x:Math.min(from.x,to.x)-80,y:Math.min(from.y,to.y)-80,width:Math.max(from.x+from.width,to.x+to.width)-Math.min(from.x,to.x)+160,height:Math.max(from.y+from.height,to.y+to.height)-Math.min(from.y,to.y)+160};
      if(!canvasVisible(bounds,viewport,size.width,size.height)&&edge!==e.id)return null;
      const geometry=canvasEdgeGeometry(e,from,to),color=e.color?canvasColor(e.color):"var(--text-secondary)",marker=prefix+"arrow"+index;
      return <g key={e.id} className={edge===e.id?"canvas-edge selected":"canvas-edge"} style={{color}}>
       <defs><marker id={marker} markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0,0 L10,4 L0,8 Z" fill={color}/></marker></defs>
       <path d={geometry.d} fill="none" stroke="transparent" strokeWidth={14} className="canvas-edge-hit" role="button" tabIndex={props.active?0:-1} aria-label={"选择连接 "+(e.label||e.fromNode+" → "+e.toNode)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();choose([]);setEdge(e.id);setEditing(null);stage.current?.focus();}}} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();choose([]);setEdge(e.id);setEditing(null);stage.current?.focus();}}/>
       <path d={geometry.d} className="canvas-edge-line" fill="none" stroke={color} markerStart={e.fromEnd==="arrow"?"url(#"+marker+")":undefined} markerEnd={e.toEnd!=="none"?"url(#"+marker+")":undefined}/>
       {e.label&&<text x={geometry.x} y={geometry.y-10} className="canvas-edge-label">{e.label}</text>}
      </g>;
     })}
     {connection&&<line x1={connection.from.x} y1={connection.from.y} x2={connection.to.x} y2={connection.to.y} className="canvas-edge-line" stroke="var(--accent)" strokeDasharray="6 4"/>}
    </svg>
    {visibleNodes.map(node=>{const freehand=canvasFreehand(node);return <div key={node.id} data-canvas-node={node.id} className={"canvas-node canvas-node-"+node.type+(freehand?" canvas-node-freehand":node.type==="text"&&node.notoCardStyle==="sticky"?" canvas-node-sticky":"")+(node.type==="file"&&node.file&&imageName(node.file)?" canvas-node-image":"")+(selected.includes(node.id)?" selected":"")} style={{left:node.x,top:node.y,width:node.width,height:node.height,zIndex:data!.nodes.indexOf(node)+1,borderColor:node.color&&!freehand?canvasColor(node.color):undefined,background:freehand?"transparent":node.type==="text"&&node.notoCardStyle==="sticky"?"color-mix(in srgb, "+(node.color?canvasColor(node.color):"#f9e2af")+" 75%, white)":node.color?"color-mix(in srgb, "+canvasColor(node.color)+" 12%, var(--bg-primary))":undefined}} onPointerDown={event=>{
      if(space||event.button===1){begin(event,"pan");return;}event.stopPropagation();
      if(!interactive||gesture.current||(event.target as HTMLElement).closest(activeCardControls))return;
      if(node.type!=="group"&&(event.target as HTMLElement).closest(".canvas-node-body,.canvas-freehand-hit")){nodeDown(event,node);return;}
      if(!selectedRef.current.includes(node.id))choose(event.shiftKey?[...selectedRef.current,node.id]:[node.id]);
     }} onDoubleClick={event=>{
      if(!interactive||(event.target as HTMLElement).closest(activeCardControls))return;
      if(node.type==="file")openFile(node.file!,node.subpath);else{choose([node.id]);if(!freehand)setEditing(node.id);}
     }} onContextMenu={event=>{if(!interactive)return;event.preventDefault();event.stopPropagation();if(!selected.includes(node.id))choose([node.id]);setMenu({x:event.clientX,y:event.clientY,world:canvasWorld(local(event.clientX,event.clientY),viewRef.current)});}}>
     <div className="canvas-node-header" role="button" tabIndex={props.active?0:-1} aria-label={freehand?"选择画布笔迹":"选择卡片 "+(node.file??node.label??node.text?.slice(0,24)??"文本")} onKeyDown={event=>{
      if(event.target!==event.currentTarget||!interactive||event.nativeEvent.isComposing)return;
      if(event.key==="Enter"||event.key===" "){event.preventDefault();event.stopPropagation();choose([node.id]);if(event.key==="Enter"&&!freehand){if(node.type==="file")openFile(node.file!,node.subpath);else setEditing(node.id);}else stage.current?.focus();}
      const direction:{[key:string]:Point}={ArrowLeft:{x:-10,y:0},ArrowRight:{x:10,y:0},ArrowUp:{x:0,y:-10},ArrowDown:{x:0,y:10}};
      const delta=direction[event.key];if(delta){event.preventDefault();choose([node.id]);const doc=current();commit(moveCanvasNodes(doc,movingCanvasIds(doc,[node.id]),delta.x,delta.y),"keyboard:"+node.id);}
     }} onPointerDown={event=>nodeDown(event,node)}><span className="canvas-node-title" title={node.file}><WorkspaceIcon name={freehand?"drawing":node.type==="group"?"group":node.type==="file"?(node.file&&imageName(node.file)?"image":"file"):"text"} size={14}/><span>{freehand?"笔迹":node.type==="group"?node.label||"分组":node.type==="file"?node.file?.split("/").at(-1):"文本"}</span></span>
      {node.type==="file"&&<button type="button" aria-label={"打开 "+node.file} onPointerDown={event=>event.stopPropagation()} onClick={()=>openFile(node.file!,node.subpath)}>↗</button>}
     </div>
     {freehand?<><CanvasStroke node={node} zoom={viewport.zoom}/>{node.text&&node.text!==canvasFreehandFallback&&<span className="canvas-freehand-caption">{node.text}</span>}</>:node.type==="group"?<div className="canvas-group-body">{editing===node.id&&<input ref={groupInput} autoFocus aria-label="分组名称" value={node.label??""} disabled={disabled} onChange={event=>patchNode(node.id,{label:event.target.value},"label:"+node.id)} onKeyDown={event=>{if(event.key==="Enter"&&!event.nativeEvent.isComposing)setEditing(null);}}/>}</div>:<div className="canvas-node-body">
      {node.type==="text"?(editing===node.id?<textarea ref={textInput} aria-label="画布文本" value={node.text??""} disabled={disabled} onChange={event=>patchNode(node.id,{text:event.target.value},"text:"+node.id)} onPointerDown={event=>event.stopPropagation()}/>:<MarkdownPreview note={props.path} content={node.text||"双击编辑文本"} wikiPaths={fileList} drawingPaths={drawingList} embedScope={props.scope} embedRevision={props.revision} embedActive={props.active} onError={props.onError} onOpenNote={props.onOpen} onWikiOpen={props.onWikiOpen} wikiServices={props.wikiServices}/>):<FilePreview file={node.file!} pool={pool} epoch={epoch} active={props.active} onOpenFile={()=>openFile(node.file!,node.subpath)} wikiPaths={fileList} onOpen={props.onOpen} onWikiOpen={props.onWikiOpen} wikiServices={props.wikiServices} onError={props.onError}/>}
     </div>}
     {selected.includes(node.id)&&interactive&&(["nw","ne","sw","se"] as const).map(corner=><button type="button" key={corner} className={"canvas-resize-handle "+corner} aria-label={"调整尺寸 "+corner} onPointerDown={event=>nodeDown(event,node,corner)}/>)}
     {interactive&&(["top","right","bottom","left"] as Side[]).map(side=><button type="button" key={side} className={"canvas-edge-anchor "+side} aria-label={"连接 "+side} aria-hidden={!selected.includes(node.id)} tabIndex={selected.includes(node.id)?0:-1} onPointerDown={event=>nodeDown(event,node,undefined,side)}/>)}
    </div>;})}
    {box&&<div className="canvas-selection-box" style={{left:box.x,top:box.y,width:box.width,height:box.height}}/>}
    {strokePreview&&<svg className="canvas-stroke-preview" aria-hidden="true">{strokePreview.points.length===1?<circle cx={strokePreview.points[0].x} cy={strokePreview.points[0].y} r={strokePreview.width/2} fill={strokePreview.color}/>:<polyline points={strokePreview.points.map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke={strokePreview.color} strokeWidth={strokePreview.width} strokeLinecap="round" strokeLinejoin="round"/>}</svg>}
    <svg className="canvas-interaction-layer">
     {guides.map(guide=><line key={guide.axis} className="canvas-guide" x1={guide.axis==="x"?guide.at:guide.start} y1={guide.axis==="y"?guide.at:guide.start} x2={guide.axis==="x"?guide.at:guide.end} y2={guide.axis==="y"?guide.at:guide.end} vectorEffect="non-scaling-stroke"/>)}
     {interactive&&selectedEdge&&edgeAnchors&&(["from","to"] as const).map(end=>{
      const point=gesture.current?.kind==="edge-end"&&gesture.current.edgeEnd?.end===end&&connection?connection.to:edgeAnchors[end];
      return <circle key={end} className="canvas-edge-endpoint" cx={point.x} cy={point.y} r={7/viewport.zoom} vectorEffect="non-scaling-stroke" role="button" tabIndex={0} aria-label={end==="from"?"调整连接起点":"调整连接终点"} onPointerDown={event=>begin(event,"edge-end",undefined,undefined,undefined,undefined,{edge:selectedEdge,end})} onKeyDown={event=>{
       const direction:Record<string,Side>={ArrowUp:"top",ArrowRight:"right",ArrowDown:"bottom",ArrowLeft:"left"},side=direction[event.key];
       if(side){event.preventDefault();event.stopPropagation();edgeSide(end,side);}
      }}><title>拖动到节点边缘，或用方向键调整</title></circle>;
     })}
    </svg>
   </div>
   {tool==="erase"&&interactive&&!space&&<div ref={eraserCursor} className="canvas-eraser-cursor" style={{width:eraserSize,height:eraserSize}} aria-hidden="true"/>}
   <CanvasMinimap nodes={data!.nodes} viewport={viewport} size={size} onNavigate={point=>updateViewport({...viewRef.current,x:size.width/2-point.x*viewRef.current.zoom,y:size.height/2-point.y*viewRef.current.zoom})}/>
   <div className="canvas-view-controls" role="group" aria-label="画布视图控制">
    <button type="button" aria-label="缩小画布" title="缩小" onClick={()=>updateViewport(zoomCanvas(viewRef.current,{x:size.width/2,y:size.height/2},viewport.zoom/1.2))}>−</button>
    <button type="button" aria-label="画布恢复100%" title="恢复 100%" onClick={()=>updateViewport(zoomCanvas(viewRef.current,{x:size.width/2,y:size.height/2},1))}>{Math.round(viewport.zoom*100)}%</button>
    <button type="button" aria-label="放大画布" title="放大" onClick={()=>updateViewport(zoomCanvas(viewRef.current,{x:size.width/2,y:size.height/2},viewport.zoom*1.2))}>＋</button>
    <button type="button" aria-label="适应全部" title="适应全部" onClick={()=>updateViewport(fitCanvas(current().nodes,size.width,size.height))}><WorkspaceIcon name="fit"/></button>
    <button type="button" aria-label="画布网格" aria-pressed={grid} title={grid?"隐藏网格":"显示网格"} onClick={()=>setGrid(visible=>!visible)}><WorkspaceIcon name="grid"/></button>
   </div>
  </div>
  {(!!selected.length||edge)&&<div className="canvas-selection-actions" aria-label="画布选择操作">
   <span>{edge?"连接":selected.length+" 个节点"}</span>
   <select aria-label="画布颜色" value={selectedColor} disabled={disabled} onChange={event=>{if(event.target.value!=="__mixed__")changeColor(event.target.value);}}>{selectedColor==="__mixed__"&&<option value="__mixed__" disabled>混合颜色</option>}{selectedColor.startsWith("#")&&<option value={selectedColor}>自定义 {selectedColor}</option>}{[["","默认"],["1","红"],["2","橙"],["3","黄"],["4","绿"],["5","蓝"],["6","紫"]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
   {selected.length>1&&!edge&&<select aria-label="画布对齐与分布" title={layoutCount<2?"分组和组内节点作为一个整体，请选择至少两个独立对象":"对齐或等间距排列所选对象"} value="" disabled={disabled||layoutCount<2} onChange={event=>{const value=event.target.value;if(value)arrange(value as CanvasLayout);event.currentTarget.value="";}}><option value="">对齐与分布</option><optgroup label="对齐"><option value="left">左对齐</option><option value="center-x">水平居中</option><option value="right">右对齐</option><option value="top">顶端对齐</option><option value="center-y">垂直居中</option><option value="bottom">底端对齐</option></optgroup><optgroup label="等间距分布"><option value="distribute-x" disabled={layoutCount<3}>水平分布</option><option value="distribute-y" disabled={layoutCount<3}>垂直分布</option></optgroup></select>}
   {edge&&selectedEdge&&<><select aria-label="连接起点位置" value={selectedEdge.fromSide??"auto"} disabled={disabled} onChange={event=>edgeSide("from",event.target.value as Side|"auto")}><option value="auto">起点：自动</option>{canvasSides.map(side=><option key={side} value={side}>{"起点："+sideLabels[side]}</option>)}</select><select aria-label="连接终点位置" value={selectedEdge.toSide??"auto"} disabled={disabled} onChange={event=>edgeSide("to",event.target.value as Side|"auto")}><option value="auto">终点：自动</option>{canvasSides.map(side=><option key={side} value={side}>{"终点："+sideLabels[side]}</option>)}</select><select aria-label="连接箭头方向" value={canvasArrowDirection(selectedEdge)} disabled={disabled} onChange={event=>edgeArrow(event.target.value as CanvasArrowDirection)}><option value="end">箭头：终点</option><option value="start">箭头：起点</option><option value="both">箭头：双向</option><option value="none">箭头：无</option></select><input aria-label="连接标签" placeholder="连接标签" value={selectedEdge.label??""} disabled={disabled} onChange={event=>{const doc=current();commit({...doc,edges:doc.edges.map(e=>e.id===edge?{...e,label:event.target.value}:e)},"edge-label:"+edge);}}/></>}
   {!edge&&<><button type="button" disabled={disabled} onClick={duplicate}>复制</button><button type="button" disabled={disabled} onClick={()=>layer(true)}>置顶</button><button type="button" disabled={disabled} onClick={()=>layer(false)}>置底</button>{data!.nodes.find(n=>n.id===selected[0])?.type==="group"&&<button type="button" disabled={disabled} onClick={()=>setEditing(selected[0])}>分组名称</button>}</>}
   <button type="button" disabled={disabled} onClick={remove}>删除</button>
  </div>}
  <div className="canvas-capacity-warnings" role="status" aria-label="画布容量提醒" aria-atomic="false">{warnings.map(warning=><p key={warning.key}>{warning.message}</p>)}</div>
  <footer className="canvas-status"><span role="status">{notice || (tool === "erase" ? "橡皮局部擦除笔迹" : "")}</span><span>{data!.nodes.length} 个节点 · {data!.edges.length} 条连接 · 已选 {selected.length} · {Math.round(viewport.zoom*100)}%</span></footer>
  {picker&&<div className="canvas-picker" role="dialog" aria-modal="true" aria-label={picker==="image"?"选择知识库图片":picker==="drawing"?"选择白板":"选择笔记"}><header><strong>{picker==="image"?"知识库图片":picker==="drawing"?"知识库白板":"知识库笔记"}</strong><button type="button" aria-label="关闭画布选择器" onClick={()=>setPicker(null)}>×</button></header><input autoFocus aria-label="筛选画布引用" placeholder="按名称或路径筛选" value={query} onChange={event=>setQuery(event.target.value)}/><div>{candidates.map(entry=><button type="button" key={entry.path} onClick={()=>{add("file",{file:entry.path,...(picker!=="note"?{width:300,height:240}:{})});setPicker(null);}}>{entry.name}<small>{entry.path}</small></button>)}{!candidates.length&&<p>没有匹配文件</p>}</div></div>}
  {menu&&<div className="file-menu canvas-menu" role="menu" aria-label="画布操作" style={{left:Math.min(menu.x,window.innerWidth-200),top:Math.min(menu.y,window.innerHeight-275)}} onClick={()=>setMenu(null)}><button type="button" role="menuitem" onClick={()=>add("text",{},menu.world)}>新增文本</button><button type="button" role="menuitem" onClick={()=>addSticky(menu.world)}>新增便签</button><button type="button" role="menuitem" onClick={()=>add("group",{},menu.world)}>新增分组</button><button type="button" role="menuitem" disabled={!selected.length} onClick={duplicate}>复制选中</button><button type="button" role="menuitem" disabled={!selected.length} onClick={()=>layer(true)}>置于顶层</button><button type="button" role="menuitem" disabled={!selected.length} onClick={()=>layer(false)}>置于底层</button><button type="button" role="menuitem" disabled={!selected.length&&!edge} onClick={remove}>删除选中</button><button type="button" role="menuitem" onClick={()=>setMenu(null)}>关闭菜单</button></div>}
 </div>;
});
