"use client";
// Canvas rendering, tool layout and hit testing adapted from Noteriv DrawingEditor.tsx (MIT).
// Files, drafts and saves are owned by the shared workspace, never by this view.
import {forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type ReactNode,type PointerEvent as Pointer} from "react";
import {drawingUiColors} from "../lib/drawing-ui";
import {parseDrawing,serializeDrawing,DrawingHistory,moveDrawing,duplicateDrawing,drawingTextSize,drawingTextBounds,defaultDrawingStyle,drawingTools,newDrawingId,maxStrokePoints,type DrawingData,type DrawingElement,type DrawingTool,type DrawingStyle} from "../lib/drawing-document";
import {createDrawingElement,pencilElement,drawingBox,drawingBounds,hitDrawing,eraseDrawingSegment,resizeDrawingElement,boxContains,drawingVisible,drawingSurfaceSize,paintDrawingElement,fitDrawing,drawingWorld,zoomDrawing,type Box} from "../lib/drawing-geometry";
import {eraserMode as normalizeEraserMode,eraserSize as normalizeEraserSize,eraserSizes,type EraserMode} from "../lib/eraser-settings";
import type {Point,CanvasViewport} from "../lib/canvas-document";
import type {Entry} from "../lib/vault-api";
import type {DrawingViewState} from "../lib/workspace-state";
import {documentPaths,isMarkdown,vaultDragType} from "../lib/document-kind";
import {drawingToSvg,downloadDrawingSvg} from "../lib/drawing-svg";
import type { GraphicFormat } from "../lib/graphic-export";
import {useWorkspaceRuntime} from "../lib/workspace-runtime";
import {copyText} from "../lib/ui-actions";
import {WorkspaceIcon} from "./workspace-icon";

export type DrawingHandle={capture:()=>DrawingViewState;flushImports:()=>Promise<void>;focus:()=>void;resetHistory:()=>void;exportSvg:()=>Promise<void>;exportGraphic:(format:GraphicFormat)=>Promise<void>};
type Props={path:string;value:string;active:boolean;disabled:boolean;scope:string;entries:Entry[];initialState?:DrawingViewState;onChange:(value:string)=>void;onError:(message:string)=>void;onOpen:(path:string,anchor?:string)=>void;onViewChange:(state:DrawingViewState)=>void};
type Gesture={kind:"move"|"resize"|"pan"|"box"|"draw"|"erase";pointer:number;base:string;data:DrawingData;start:Point;world:Point;last:Point;viewport:CanvasViewport;ids:Set<string>;points:Point[];id:string;tool:DrawingTool;style:DrawingStyle;corner?:string;element?:DrawingElement;eraseData:DrawingData;erasePoints:Point[];eraseRadius:number;eraseMode:EraserMode;moved:boolean};
const names:Record<DrawingTool,string>={select:"选择",hand:"平移",pencil:"画笔",rectangle:"矩形",ellipse:"椭圆",line:"直线",arrow:"箭头",text:"文字",eraser:"橡皮"};
const shortcuts:Record<DrawingTool,string>={select:"V",hand:"H",pencil:"P",rectangle:"R",ellipse:"O",line:"L",arrow:"A",text:"T",eraser:"E"};
const penColors=["#1f2937","#2563eb","#dc2626","#16803c","#ca8a04","#9333ea"];
const icons:Record<DrawingTool,ReactNode>={select:<path d="M4 2.5 14 11l-4 .5-2 4-1.5-4Z"/>,hand:<path d="M6.5 9V4a1 1 0 0 1 2 0v4-5a1 1 0 0 1 2 0v5-4a1 1 0 0 1 2 0v4-2.5a1 1 0 0 1 2 0v5l-2.5 5H7l-3-4.5a1.2 1.2 0 0 1 2-1.3Z"/>,pencil:<path d="m4 13.8-.6 3 3-.6 9.8-9.8-2.4-2.4L4 13.8ZM12.5 5.3l2.4 2.4"/>,rectangle:<rect x="3.5" y="4" width="13" height="12" rx="1"/>,ellipse:<ellipse cx="10" cy="10" rx="6.5" ry="5.5"/>,line:<path d="M4 16 16 4"/>,arrow:<path d="M4 16 16 4M10 4h6v6"/>,text:<path d="M4 4h12M10 4v12M7 16h6"/>,eraser:<><path d="m3 12 7-8a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-6 6H7ZM6 9l5 5M10 16h6"/></>};
function DrawingPopup({label,onClose,children}:{label:string;onClose:()=>void;children:ReactNode}){
  const panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    (panel.current?.querySelector<HTMLElement>("input,textarea")??panel.current?.querySelector<HTMLElement>("button"))?.focus();
    return ()=>{if(previous?.isConnected&&!previous.closest("[hidden]"))previous.focus();};
  },[]);
  return <div className="drawing-dialog-backdrop" onPointerDown={event=>{event.stopPropagation();}}>
    <div ref={panel} className="drawing-dialog" role="dialog" aria-modal="true" aria-label={label} onKeyDown={event=>{
      if(event.nativeEvent.isComposing)return;
      if(event.key==="Escape"){event.preventDefault();event.stopPropagation();onClose();}
      if(event.key==="Tab"){
        const all=[...(panel.current?.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled),textarea:not(:disabled),select:not(:disabled)")??[])],first=all[0],last=all.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>{children}</div>
  </div>;
}
export const DrawingWhiteboard=forwardRef<DrawingHandle,Props>(function DrawingWhiteboard(props,ref){
  const runtime=useWorkspaceRuntime(),live=useRef(props);live.current=props;
  const source=useRef(props.value),history=useRef(new DrawingHistory()),[historyRevision,setHistoryRevision]=useState(0);
  const parsed=useMemo(()=>{try{return {data:parseDrawing(props.value),error:""};}catch(cause){return {data:null,error:cause instanceof Error?cause.message:String(cause)};}},[props.value]);
  const [viewport,setViewport]=useState<CanvasViewport>(props.initialState?.viewport??{x:0,y:0,zoom:1});
  const eraserCursor=useRef<HTMLDivElement>(null);
  const [selected,setSelected]=useState<string[]>(props.initialState?.selected??[]);
  const [tool,setTool]=useState<DrawingTool>(props.initialState?.tool??"select"),[style,setStyle]=useState<DrawingStyle>(props.initialState?.style??defaultDrawingStyle),[grid,setGrid]=useState(props.initialState?.grid??true);
  const [eraserSize,setEraserSize]=useState(()=>normalizeEraserSize(props.initialState?.eraserSize)),[eraserMode,setEraserMode]=useState(()=>normalizeEraserMode(props.initialState?.eraserMode));
  const [size,setSize]=useState({width:800,height:600}),[preview,setPreview]=useState<DrawingData|null>(null),[box,setBox]=useState<Box|null>(null),[editing,setEditing]=useState<string|null>(null),[space,setSpace]=useState(false);
  const [picker,setPicker]=useState(false),[query,setQuery]=useState(""),[clearAsk,setClearAsk]=useState(false),[list,setList]=useState(false),[notice,setNotice]=useState(""),[exporting,setExporting]=useState(false),[focusMode,setFocusMode]=useState(false);
  const canvas=useRef<HTMLCanvasElement>(null),stage=useRef<HTMLDivElement>(null),textInput=useRef<HTMLTextAreaElement>(null),outer=useRef<HTMLDivElement>(null),gesture=useRef<Gesture|null>(null),raf=useRef(0),fitOnce=useRef(!!props.initialState),alive=useRef(true),exportSerial=useRef(0);
  const viewRef=useRef(viewport),selectionRef=useRef(selected),styleRef=useRef(style),toolRef=useRef(tool),gridRef=useRef(grid),eraserSizeRef=useRef(eraserSize),eraserModeRef=useRef(eraserMode);
  viewRef.current=viewport;selectionRef.current=selected;styleRef.current=style;toolRef.current=tool;gridRef.current=grid;eraserSizeRef.current=eraserSize;eraserModeRef.current=eraserMode;
  const data=preview??parsed.data,disabled=props.disabled||!parsed.data,interactive=props.active&&!disabled&&!picker&&!clearAsk&&!exporting;
  const current=()=>parseDrawing(source.current);
  function error(cause:unknown){const message=cause instanceof Error?cause.message:String(cause);setNotice(message);live.current.onError(message);}
  function choose(ids:string[]){selectionRef.current=ids;setSelected(ids);}
  function view(next:CanvasViewport){viewRef.current=next;setViewport(next);}
  function cancel(){
    const old=gesture.current;gesture.current=null;cancelAnimationFrame(raf.current);raf.current=0;setPreview(null);setBox(null);
    if(old)try{stage.current?.releasePointerCapture?.(old.pointer);}catch{}
  }
  function resetHistory(){cancel();history.current.clear();setHistoryRevision(n=>n+1);setNotice("文件路径或来源已调整，白板撤销历史已重置。");}
  function commit(next:DrawingData,group?:string){
    if(!alive.current||live.current.disabled)return false;
    try{
      const after=serializeDrawing(next),before=source.current;if(before===after)return true;
      history.current.record(before,after,group);source.current=after;live.current.onChange(after);setHistoryRevision(n=>n+1);setNotice("");return true;
    }catch(cause){error(cause);return false;}
  }
  function capture():DrawingViewState{return {viewport:{...viewRef.current},selected:[...selectionRef.current],tool:toolRef.current,style:{...styleRef.current},grid:gridRef.current,eraserSize:eraserSizeRef.current,eraserMode:eraserModeRef.current};}
  useLayoutEffect(()=>{
    if(props.value!==source.current){
      source.current=props.value;resetHistory();setEditing(null);setPicker(false);setClearAsk(false);
      const ids=new Set(parsed.data?.elements.map(e=>e.id));choose(selectionRef.current.filter(id=>ids.has(id)));
    }
  },[props.value]);
  useEffect(()=>{
    if(!props.active||props.disabled){cancel();setSpace(false);setPicker(false);setClearAsk(false);setFocusMode(false);++exportSerial.current;setExporting(false);}
  },[props.active,props.disabled]);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;++exportSerial.current;cancelAnimationFrame(raf.current);};},[]);
  useEffect(()=>{
    const blur=()=>{cancel();setSpace(false);},hidden=()=>{if(document.hidden)blur();};
    window.addEventListener("blur",blur);document.addEventListener("visibilitychange",hidden);
    return ()=>{window.removeEventListener("blur",blur);document.removeEventListener("visibilitychange",hidden);};
  },[]);
  useLayoutEffect(()=>{
    const el=stage.current;if(!el)return;
    const measure=()=>{
      const r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)return;
      setSize(previous=>previous.width===r.width&&previous.height===r.height?previous:{width:r.width,height:r.height});
      if(!fitOnce.current&&live.current.active){fitOnce.current=true;view(fitDrawing(parsed.data?.elements??[],r.width,r.height));}
    };
    measure();const observer=new ResizeObserver(measure);observer.observe(el);return ()=>observer.disconnect();
  },[!!parsed.data,props.active]);
  useEffect(()=>{
    const el=stage.current;if(!el)return;
    const wheel=(event:WheelEvent)=>{
      if(!live.current.active||live.current.disabled||gesture.current||(event.target as HTMLElement).closest("textarea,input,[role=dialog]"))return;
      event.preventDefault();const r=el.getBoundingClientRect();view(zoomDrawing(viewRef.current,{x:event.clientX-r.left,y:event.clientY-r.top},viewRef.current.zoom*(event.deltaY<0?1.1:1/1.1)));
    };
    el.addEventListener("wheel",wheel,{passive:false});return ()=>el.removeEventListener("wheel",wheel);
  },[!!parsed.data]);
  useEffect(()=>{live.current.onViewChange(capture());},[viewport,selected,tool,style,grid,eraserSize,eraserMode]);
  useLayoutEffect(()=>{
    if(!editing||!props.active)return;
    const field=textInput.current;field?.focus();field?.setSelectionRange(field.value.length,field.value.length);
  },[editing]);
  useEffect(()=>{
    const el=canvas.current;if(!el)return;
    if(!props.active){el.width=1;el.height=1;return;}
    const frame=requestAnimationFrame(()=>{
      const ctx=el.getContext("2d");if(!ctx||!data)return;
      const surface=drawingSurfaceSize(size.width,size.height,window.devicePixelRatio);
      if(el.width!==surface.width)el.width=surface.width;if(el.height!==surface.height)el.height=surface.height;
      ctx.setTransform(surface.ratio,0,0,surface.ratio,0,0);ctx.clearRect(0,0,size.width,size.height);ctx.fillStyle=data.background;ctx.fillRect(0,0,size.width,size.height);
      const uiColors=drawingUiColors(data.background);
      if(grid){ctx.fillStyle=uiColors.grid;const step=24*viewport.zoom;if(step>6){for(let x=viewport.x%step;x<size.width;x+=step)for(let y=viewport.y%step;y<size.height;y+=step)ctx.fillRect(x,y,1,1);}}
      ctx.save();ctx.translate(viewport.x,viewport.y);ctx.scale(viewport.zoom,viewport.zoom);
      for(const raw of data.elements){
        const e=drawingTextBounds(raw,(line,fontSize)=>{ctx.font=fontSize+"px sans-serif";return ctx.measureText(line).width;});
        if(!drawingVisible(e,viewport,size.width,size.height))continue;
        if(e.id!==editing)paintDrawingElement(ctx,e);
        if(selected.includes(e.id)){const b=drawingBounds(e);ctx.save();ctx.setLineDash([4/viewport.zoom,3/viewport.zoom]);ctx.strokeStyle=uiColors.selection;ctx.lineWidth=1/viewport.zoom;ctx.strokeRect(b.x-3/viewport.zoom,b.y-3/viewport.zoom,b.width+6/viewport.zoom,b.height+6/viewport.zoom);ctx.restore();}
      }
      ctx.restore();
    });
    return ()=>cancelAnimationFrame(frame);
  },[data,props.active,size,viewport,selected,grid,editing]);
  function local(x:number,y:number){const r=stage.current!.getBoundingClientRect();return {x:x-r.left,y:y-r.top};}
  function measureLine(line:string,fontSize:number){const ctx=canvas.current?.getContext("2d");if(!ctx)return [...line].length*fontSize;ctx.font=fontSize+"px sans-serif";return ctx.measureText(line).width;}
  function topHit(p:Point){return [...current().elements].reverse().map(e=>drawingTextBounds(e,measureLine)).find(e=>hitDrawing(e,p,6/viewRef.current.zoom));}
  function begin(event:Pointer,kind:Gesture["kind"],element?:DrawingElement,corner?:string){
    event.preventDefault();event.stopPropagation();if(!interactive||gesture.current||event.button===2)return;
    const start=local(event.clientX,event.clientY),world=drawingWorld(start,viewRef.current);
    const data=current();
    gesture.current={kind,pointer:event.pointerId,base:source.current,data,start,world,last:world,viewport:{...viewRef.current},ids:new Set(selectionRef.current),points:[world],id:newDrawingId(),tool,style:{...style},corner,element,eraseData:data,erasePoints:[],eraseRadius:eraserSize/2/viewRef.current.zoom,eraseMode:eraserMode,moved:false};
    stage.current?.focus({preventScroll:true});try{stage.current?.setPointerCapture?.(event.pointerId);}catch{}
    if(kind==="erase")try{step(event,false);}catch(cause){cancel();error(cause);}
  }
  function down(event:Pointer){
    if(event.target!==canvas.current&&event.target!==stage.current||!interactive||event.button===2)return;
    if(gesture.current){event.preventDefault();return;}
    setEditing(null);
    if(event.button===1||space||tool==="hand"){begin(event,"pan");return;}
    const p=drawingWorld(local(event.clientX,event.clientY),viewRef.current);
    if(tool==="select"){
      const hit=topHit(p);
      if(hit){
        const ids=event.shiftKey?selectionRef.current.includes(hit.id)?selectionRef.current.filter(id=>id!==hit.id):[...selectionRef.current,hit.id]:selectionRef.current.includes(hit.id)?selectionRef.current:[hit.id];
        choose(ids);if(ids.includes(hit.id))begin(event,"move",hit);return;
      }
      begin(event,event.shiftKey?"box":"pan");return;
    }
    if(tool==="eraser"){begin(event,"erase");return;}
    if(tool==="text"){
      const e=createDrawingElement("text",p,p,style);if(commit({...current(),elements:[...current().elements,e]})){choose([e.id]);setEditing(e.id);}return;
    }
    begin(event,"draw");
  }
  function step(event:{clientX:number;clientY:number},final:boolean){
    const g=gesture.current;if(!g)return;
    if(g.base!==source.current||!live.current.active||live.current.disabled){cancel();return;}
    const p=local(event.clientX,event.clientY),world=drawingWorld(p,g.viewport),dx=world.x-g.world.x,dy=world.y-g.world.y;
    g.moved=g.moved||Math.hypot(p.x-g.start.x,p.y-g.start.y)>=4;
    if(g.kind==="pan"){if(g.moved)view({...g.viewport,x:g.viewport.x+p.x-g.start.x,y:g.viewport.y+p.y-g.start.y});else if(final)choose([]);return;}
    if(g.kind==="box"){
      const rect={x:Math.min(world.x,g.world.x),y:Math.min(world.y,g.world.y),width:Math.abs(dx),height:Math.abs(dy)};setBox(rect);
      if(final&&g.moved)choose(g.data.elements.filter(e=>boxContains(rect,drawingBox(drawingTextBounds(e,measureLine)))).map(e=>e.id));return;
    }
    if(g.kind==="erase"){
      const points=g.erasePoints.splice(0);points.push(world);
      for(const point of points){g.eraseData=eraseDrawingSegment(g.eraseData,g.last,point,g.eraseRadius,measureLine,g.eraseMode);g.last=point;}
      if(final){if(g.eraseData!==g.data&&commit(g.eraseData)){const ids=new Set(g.eraseData.elements.map(e=>e.id));choose(selectionRef.current.filter(id=>ids.has(id)));}}
      else if(g.eraseData!==g.data)setPreview(g.eraseData);
      return;
    }
    let next:DrawingData;
    if(g.kind==="draw"){
      let e:DrawingElement;
      if(g.tool==="pencil"){
        const last=g.points.at(-1)!;
        if(Math.hypot(world.x-last.x,world.y-last.y)>=(final ? .001 : .75/g.viewport.zoom)){
          if(g.points.length>=maxStrokePoints){cancel();error("单笔超过 10000 点，本次笔划已取消，请分笔绘制");return;}
          g.points.push(world);
        }
        e=pencilElement(g.points,g.style,g.id);
      }else {
        if(!g.moved)return;
        e=createDrawingElement(g.tool as DrawingElement["type"],g.world,world,g.style,g.id);
      }
      next={...g.data,elements:[...g.data.elements,e]};
      if(final){if(commit(next))choose([e.id]);}else setPreview(next);return;
    }
    if(!g.moved)return;
    next=g.kind==="move"?moveDrawing(g.data,g.ids,dx,dy):{...g.data,elements:g.data.elements.map(e=>e.id===g.element!.id?resizeDrawingElement(e,g.corner!,dx,dy):e)};
    if(final)commit(next);else setPreview(next);
  }
  function pointerMove(event:Pointer){
    if(gesture.current&&gesture.current.pointer!==event.pointerId)return;
    if(toolRef.current==="eraser"&&eraserCursor.current){const position=local(event.clientX,event.clientY);eraserCursor.current.style.left=position.x+"px";eraserCursor.current.style.top=position.y+"px";eraserCursor.current.style.visibility="visible";}
    if(!gesture.current||gesture.current.pointer!==event.pointerId)return;
    const native=event.nativeEvent;
    if(gesture.current.kind==="draw"&&gesture.current.tool==="pencil"){
      const events=typeof native.getCoalescedEvents==="function"?native.getCoalescedEvents():[];
      // Capture points synchronously; display work still coalesces to one RAF.
      for(const item of events.length?events:[native]){
        const g=gesture.current;if(!g)return;
        const p=drawingWorld(local(item.clientX,item.clientY),g.viewport),last=g.points.at(-1)!;
        if(Math.hypot(p.x-last.x,p.y-last.y)>=.75/g.viewport.zoom){if(g.points.length>=maxStrokePoints){cancel();error("单笔超过 10000 点，本次笔划已取消");return;}g.points.push(p);}
      }
    }
    if(gesture.current?.kind==="erase"){
      const events=typeof native.getCoalescedEvents==="function"?native.getCoalescedEvents():[];
      for(const item of events.length?events:[native]){
        const g=gesture.current;if(!g)return;
        g.erasePoints.push(drawingWorld(local(item.clientX,item.clientY),g.viewport));
      }
    }
    cancelAnimationFrame(raf.current);const p={clientX:event.clientX,clientY:event.clientY};
    raf.current=requestAnimationFrame(()=>{try{step(p,false);}catch(cause){cancel();error(cause);}});
  }
  function pointerUp(event:Pointer){if(gesture.current?.pointer!==event.pointerId)return;cancelAnimationFrame(raf.current);try{step(event,true);}catch(cause){error(cause);}finally{cancel();}}
  function undo(redo=false){
    if(!interactive)return;cancel();const next=redo?history.current.redo(source.current):history.current.undo(source.current);
    if(next!==null){source.current=next;live.current.onChange(next);setEditing(null);choose(selectionRef.current.filter(id=>parseDrawing(next).elements.some(e=>e.id===id)));setHistoryRevision(n=>n+1);}
  }
  function remove(){if(!interactive)return;cancel();commit({...current(),elements:current().elements.filter(e=>!selectionRef.current.includes(e.id))});choose([]);setEditing(null);}
  function duplicate(){if(!interactive)return;const result=duplicateDrawing(current(),new Set(selectionRef.current));if(commit(result.data))choose(result.ids);}
  function layer(front:boolean){if(!interactive)return;const doc=current(),yes=doc.elements.filter(e=>selected.includes(e.id)),no=doc.elements.filter(e=>!selected.includes(e.id));commit({...doc,elements:front?[...no,...yes]:[...yes,...no]});}
  function textSize(text:string,fontSize:number){
    const ctx=canvas.current?.getContext("2d");if(ctx)ctx.font=fontSize+"px sans-serif";
    return drawingTextSize(text,fontSize,ctx?(line)=>ctx.measureText(line).width:undefined);
  }
  function editText(id:string,text:string){
    const doc=current();commit({...doc,elements:doc.elements.map(e=>e.id===id?{...e,text,...textSize(text,e.fontSize!)}:e)},"text:"+id);
  }
  function changeStyle(patch:Partial<DrawingStyle>){
    if(!interactive)return;setStyle(previous=>({...previous,...patch}));
    if(!selected.length)return;
    const doc=current();commit({...doc,elements:doc.elements.map(e=>{
      if(!selected.includes(e.id))return e;const next={...e};
      if(patch.strokeColor)next.strokeColor=patch.strokeColor;
      if(patch.fillColor!==undefined&&["rectangle","ellipse"].includes(e.type))next.fillColor=patch.fillColor;
      if(patch.strokeWidth&&e.type!=="text")next.strokeWidth=patch.strokeWidth;
      if(patch.fontSize&&e.type==="text"){next.fontSize=patch.fontSize;Object.assign(next,textSize(e.text!,patch.fontSize));}
      return next;
    })});
  }
  function openLink(){const e=current().elements.find(e=>e.id===selectionRef.current[0]);if(e?.link)live.current.onOpen(e.link.file,e.link.subpath?.slice(1));}
  function linkNote(file?:string){
    const doc=current();commit({...doc,elements:doc.elements.map(e=>{
      if(!selected.includes(e.id))return e;
      if(file){const {subpath,...previous}=e.link??{};void subpath;return {...e,link:{...previous,file}};}
      const {link,...rest}=e;void link;return rest;
    })});setPicker(false);
  }
  async function exportDrawing(format: "svg" | GraphicFormat = "svg"){
    if(!live.current.active||disabled||gesture.current||picker||clearAsk){error("请先确认恢复草稿，并完成或取消当前绘制/选择操作后导出");return;}
    const serial=++exportSerial.current,snapshot=source.current,path=live.current.path,scope=live.current.scope;setExporting(true);
    try{
      await Promise.resolve();
      if(!alive.current||serial!==exportSerial.current||!live.current.active||live.current.path!==path||live.current.scope!==scope)return;
      if (format !== "svg") {
        const { drawingRaster, saveGraphic } = await import("../lib/graphic-export");
        const canvas = await drawingRaster(snapshot, measureLine);
        if (!alive.current || serial !== exportSerial.current || !live.current.active || live.current.scope !== scope) return;
        const notice = await saveGraphic(runtime, canvas, path, format);
        if (alive.current && serial === exportSerial.current) setNotice(notice);
        return;
      }
      const svg=drawingToSvg(snapshot,measureLine),name=path.split("/").at(-1)!.replace(/\.drawing$/i,"")+".svg";
      if(runtime.kind==="desktop"){
        if(!runtime.saveDrawingSvg)throw new Error("当前桌面运行时缺少受控 SVG 保存能力");
        const saved=await runtime.saveDrawingSvg(svg,name);
        if(alive.current&&serial===exportSerial.current)setNotice(saved?"SVG 已保存："+saved:"已取消 SVG 保存");
      }else {downloadDrawingSvg(svg,name);if(serial===exportSerial.current)setNotice("已发起 SVG 下载；快照不会随白板自动更新。");}
    }catch(cause){if(alive.current&&serial===exportSerial.current)error(cause);}
    finally{if(alive.current&&serial===exportSerial.current)setExporting(false);}
  }
  useImperativeHandle(ref,()=>({capture,focus:()=>{if(editing)textInput.current?.focus();else stage.current?.focus();},flushImports:async()=>{cancel();++exportSerial.current;setExporting(false);},resetHistory,exportSvg:()=>exportDrawing(),exportGraphic:exportDrawing}));
  const first=data?.elements.find(e=>e.id===selected[0]),text=data?.elements.find(e=>e.id===editing&&e.type==="text");
  const chosen=data?.elements.filter(e=>selected.includes(e.id))??[];
  const widths=chosen.filter(e=>e.type!=="text"),shapes=chosen.filter(e=>e.type==="rectangle"||e.type==="ellipse"),texts=chosen.filter(e=>e.type==="text");
  const mixedStroke=new Set(chosen.map(e=>e.strokeColor)).size>1;
  const mixedWidth=new Set(widths.map(e=>e.strokeWidth??2)).size>1;
  const mixedFill=new Set(shapes.map(e=>e.fillColor??"transparent")).size>1;
  const mixedFont=new Set(texts.map(e=>e.fontSize)).size>1;
  const showPaint=tool!=="eraser"&&(chosen.length>0||!["select","hand"].includes(tool));
  const showWidth=chosen.length?widths.length>0:!["select","hand","eraser","text"].includes(tool);
  const showFill=chosen.length?shapes.length>0:tool==="rectangle"||tool==="ellipse";
  const showFont=chosen.length?texts.length>0:tool==="text";
  const stroke=first?.strokeColor??style.strokeColor,width=widths.length?(widths[0].strokeWidth??2):style.strokeWidth,fill=shapes.length?(shapes[0].fillColor??"transparent"):style.fillColor,fontSize=texts[0]?.fontSize??style.fontSize;
  const notePaths=useMemo(()=>documentPaths(props.entries).filter(isMarkdown),[props.entries]);
  const candidates=notePaths.filter(path=>path.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,200);
  const screen=(p:Point)=>({x:p.x*viewport.zoom+viewport.x,y:p.y*viewport.zoom+viewport.y});
  const handles=first&&selected.length===1&&first.type!=="text"?(first.type==="line"||first.type==="arrow"?[{id:"start",p:screen(first)},{id:"end",p:screen({x:first.x+first.width,y:first.y+first.height})}]:["nw","ne","sw","se"].map(id=>({id,p:screen({x:first.x+(id.includes("e")?first.width:0),y:first.y+(id.includes("s")?first.height:0)})}))):[];
  if(!parsed.data)return <section className="drawing-invalid" role="alert"><h2>白板暂时只读</h2><p>{parsed.error}</p><button type="button" onClick={()=>void copyText(props.value)}>复制原文</button><details><summary>查看原始 JSON</summary><pre>{props.value}</pre></details></section>;
  return <div ref={outer} className={"drawing-workspace"+(focusMode?" is-focused":"")} aria-label="绘图白板工作区" onKeyDown={event=>{
    if(!props.active||event.nativeEvent.isComposing)return;
    if((event.target as HTMLElement).closest("input,textarea,select,button,summary,[role=dialog]"))return;
    if(event.key==="Escape"){event.preventDefault();cancel();if(editing)setEditing(null);else if(selected.length){setTool("select");choose([]);}else if(focusMode)setFocusMode(false);else setTool("select");return;}
    if(!interactive)return;
    const mod=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
    if(mod&&key==="enter"){event.preventDefault();openLink();return;}
    if(mod&&["a","d","z"].includes(key)){event.preventDefault();if(key==="a")choose(current().elements.map(e=>e.id));else if(key==="d")duplicate();else undo(event.shiftKey);return;}
    if(event.key==="Delete"||event.key==="Backspace"){event.preventDefault();remove();return;}
    if(event.key===" "){event.preventDefault();setSpace(true);return;}
    const delta:{[key:string]:Point}={ArrowLeft:{x:-10,y:0},ArrowRight:{x:10,y:0},ArrowUp:{x:0,y:-10},ArrowDown:{x:0,y:10}};
    if(delta[event.key]&&selected.length){event.preventDefault();commit(moveDrawing(current(),new Set(selected),delta[event.key].x,delta[event.key].y),"keyboard");return;}
    if(mod||event.altKey)return;
    const keys:Record<string,DrawingTool>={v:"select",h:"hand",p:"pencil",r:"rectangle",o:"ellipse",l:"line",a:"arrow",t:"text",e:"eraser"};
    if(keys[key]){event.preventDefault();cancel();setTool(keys[key]);setEditing(null);}
  }} onKeyUp={event=>{if(event.key===" ")setSpace(false);}}>
    <div className="drawing-toolbar" role="toolbar" aria-label="白板工具">
      <div className="drawing-tool-group">{drawingTools.map(t=><button key={t} type="button" aria-label={names[t]+"工具"} aria-pressed={tool===t} disabled={!interactive} title={names[t]+"（"+shortcuts[t]+"）"} onClick={()=>{cancel();setTool(t);setEditing(null);stage.current?.focus();}}><span aria-hidden="true"><svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{icons[t]}</svg></span><span>{names[t]}</span></button>)}</div>
      {tool==="eraser"&&<div className="drawing-properties" role="group" aria-label="白板橡皮设置"><label>橡皮尺寸<select aria-label="白板橡皮尺寸" value={eraserSize} disabled={!interactive} onChange={event=>{cancel();setEraserSize(normalizeEraserSize(Number(event.target.value)));}}>{eraserSizes.map(size=><option key={size} value={size}>{size} px</option>)}</select></label><label>模式<select aria-label="白板橡皮模式" value={eraserMode} disabled={!interactive} onChange={event=>{cancel();setEraserMode(normalizeEraserMode(event.target.value));}}><option value="stroke">仅擦笔迹（局部）</option><option value="object">擦除对象（整件）</option></select></label></div>}
      {showPaint&&<div className="drawing-properties" aria-label="白板样式">
        <label>笔色<input type="color" aria-label="白板笔色" disabled={!interactive} value={stroke} onChange={event=>changeStyle({strokeColor:event.target.value})}/>{mixedStroke&&<span className="drawing-mixed">混合</span>}</label>
        <div className="drawing-color-presets" role="group" aria-label="常用笔色">{penColors.map(color=><button key={color} type="button" aria-label={"笔色 "+color} title={color} aria-pressed={!mixedStroke&&stroke.toLowerCase()===color} disabled={!interactive} style={{"--preset-color":color} as CSSProperties} onClick={()=>changeStyle({strokeColor:color})}/>)}</div>
        {showWidth&&<><label>笔宽<select aria-label="白板笔宽" disabled={!interactive} value={mixedWidth?"mixed":width} onChange={event=>{if(event.target.value!=="mixed")changeStyle({strokeWidth:Number(event.target.value)});}}>{mixedWidth&&<option value="mixed" disabled>混合</option>}{[1,2,4,6,8,12,16].map(n=><option key={n} value={n}>{n} px</option>)}</select></label><div className="drawing-width-presets" role="group" aria-label="常用笔宽">{[1,2,4,6].map(n=><button type="button" key={n} aria-label={"笔宽 "+n+" px"} title={"笔宽 "+n+" px"} aria-pressed={!mixedWidth&&width===n} disabled={!interactive} onClick={()=>changeStyle({strokeWidth:n})}><span style={{height:n}}/></button>)}</div></>}
        {showFill&&<label>填充<input type="checkbox" aria-label="启用白板填充" ref={el=>{if(el)el.indeterminate=mixedFill;}} disabled={!interactive} checked={!mixedFill&&fill!=="transparent"} onChange={event=>changeStyle({fillColor:event.target.checked?"#dbeafe":"transparent"})}/><input type="color" aria-label="白板填充颜色" disabled={!interactive} value={fill==="transparent"?"#dbeafe":fill} onChange={event=>changeStyle({fillColor:event.target.value})}/>{mixedFill&&<span className="drawing-mixed">混合</span>}</label>}
        {showFont&&<label>字号<input type="number" aria-label="白板字号" min={12} max={96} disabled={!interactive} value={mixedFont?"":fontSize} placeholder={mixedFont?"混合":undefined} onChange={event=>{const n=Number(event.target.value);if(n>=12&&n<=96)changeStyle({fontSize:n});}}/></label>}
      </div>}
    <div className="drawing-viewbar">
      <button type="button" title="撤销" disabled={!interactive||!history.current.past.length} onClick={()=>undo()} aria-label="撤销白板"><WorkspaceIcon name="undo"/></button><button type="button" title="重做" disabled={!interactive||!history.current.future.length} onClick={()=>undo(true)} aria-label="重做白板"><WorkspaceIcon name="redo"/></button>
      <label><input type="checkbox" checked={grid} onChange={event=>setGrid(event.target.checked)}/>网格</label>
      <label>纸张<input type="color" aria-label="白板背景色" value={data!.background} disabled={!interactive} onChange={event=>commit({...current(),background:event.target.value})}/></label>
      <button type="button" aria-expanded={list} onClick={()=>setList(v=>!v)}>元素列表</button>
      <button type="button" aria-label={focusMode?"退出白板专注模式":"进入白板专注模式"} title={focusMode?"退出专注模式":"专注模式"} aria-pressed={focusMode} onClick={()=>{cancel();setFocusMode(value=>!value);stage.current?.focus();}}><WorkspaceIcon name="fit"/></button>
      <details className="note-more drawing-more"><summary aria-label="白板更多操作">⋯</summary><div><button type="button" disabled={disabled||exporting||!!gesture.current} onClick={()=>void exportDrawing()}>导出 SVG 快照</button><button type="button" disabled={disabled||exporting||!!gesture.current} onClick={()=>void exportDrawing("png")}>导出白板 PNG</button><button type="button" disabled={disabled||exporting||!!gesture.current} onClick={()=>void exportDrawing("pdf")}>导出白板 PDF</button><button type="button" disabled={!interactive||!data!.elements.length} onClick={()=>{cancel();setClearAsk(true);}}>清空白板</button></div></details>
    </div>
    </div>
    <div ref={stage} role="region" aria-label="绘图白板" tabIndex={props.active?0:-1} className={"drawing-stage tool-"+(space?"hand":tool)} style={{"--drawing-selection":drawingUiColors(data!.background).selection} as CSSProperties} onPointerDown={down} onPointerMove={pointerMove} onPointerLeave={event=>{if((!gesture.current||gesture.current.pointer===event.pointerId)&&eraserCursor.current)eraserCursor.current.style.visibility="hidden";}} onPointerUp={pointerUp} onPointerCancel={event=>{if(gesture.current?.pointer===event.pointerId)cancel();}} onLostPointerCapture={event=>{if(gesture.current?.pointer===event.pointerId)cancel();}} onDoubleClick={event=>{
      if(!interactive||event.target!==canvas.current||tool!=="select")return;
      const e=topHit(drawingWorld(local(event.clientX,event.clientY),viewRef.current));if(e?.type==="text"){choose([e.id]);setEditing(e.id);}
    }} onDragOver={event=>{if(interactive&&event.dataTransfer.types.includes(vaultDragType)){event.preventDefault();event.dataTransfer.dropEffect="copy";}}} onDrop={event=>{
      event.preventDefault();event.stopPropagation();if(!interactive)return;
      try{
        const payload=JSON.parse(event.dataTransfer.getData(vaultDragType));
        if(payload.scope!==props.scope||!isMarkdown(payload.path)||!notePaths.includes(payload.path))throw new Error("请从当前知识库拖入 Markdown 笔记");
        cancel();const p=drawingWorld(local(event.clientX,event.clientY),viewRef.current),label=payload.path.split("/").at(-1).replace(/\.(md|markdown)$/i,"");
        const e={...createDrawingElement("text",p,p,style),text:label,...textSize(label,style.fontSize),link:{file:payload.path}};
        if(commit({...current(),elements:[...current().elements,e]}))choose([e.id]);
      }catch(cause){error(cause);}
    }}>
      <canvas ref={canvas} aria-label="白板绘制区域" style={{width:"100%",height:"100%"}}/>
      {tool==="eraser"&&interactive&&!space&&<div ref={eraserCursor} className="drawing-eraser-cursor" style={{width:eraserSize,height:eraserSize}} aria-hidden="true"/>}
      <div className="drawing-view-controls" role="group" aria-label="白板视图控制">
        <button type="button" aria-label="缩小白板" title="缩小" onClick={()=>view(zoomDrawing(viewRef.current,{x:size.width/2,y:size.height/2},viewport.zoom/1.2))}>−</button>
        <button type="button" aria-label="白板恢复100%" title="恢复 100%" onClick={()=>view(zoomDrawing(viewRef.current,{x:size.width/2,y:size.height/2},1))}>{Math.round(viewport.zoom*100)}%</button>
        <button type="button" aria-label="放大白板" title="放大" onClick={()=>view(zoomDrawing(viewRef.current,{x:size.width/2,y:size.height/2},viewport.zoom*1.2))}>＋</button>
        <button type="button" aria-label="适应全部" title="适应全部" onClick={()=>view(fitDrawing(current().elements,size.width,size.height))}><WorkspaceIcon name="fit"/></button>
      </div>
      {interactive&&handles.map(h=><button key={h.id} type="button" className="drawing-resize" aria-label={"调整白板 "+h.id} style={{left:h.p.x-5,top:h.p.y-5}} onPointerDown={event=>begin(event,"resize",first!,h.id)}/>)}
      {box&&<div className="drawing-box" style={{left:screen(box).x,top:screen(box).y,width:box.width*viewport.zoom,height:box.height*viewport.zoom}}/>}
      {text&&<textarea ref={textInput} className="drawing-text-input" aria-label="白板文字" value={text.text} disabled={disabled} spellCheck={false} style={{left:screen(text).x,top:screen(text).y,width:Math.max(120,text.width)*viewport.zoom,height:Math.max(text.height,text.fontSize!*1.4)*viewport.zoom,fontSize:text.fontSize!*viewport.zoom,lineHeight:1.4,color:text.strokeColor,background:data!.background}} onPointerDown={event=>event.stopPropagation()} onChange={event=>editText(text.id,event.target.value)} onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();setEditing(null);stage.current?.focus();}}}/>}
      {list&&<aside className="drawing-elements" aria-label="白板元素列表">{data!.elements.map(e=><button key={e.id} type="button" aria-pressed={selected.includes(e.id)} onClick={event=>{choose(event.shiftKey?[...new Set([...selected,e.id])]:[e.id]);setEditing(null);view(fitDrawing([e],size.width,size.height));}}>{names[e.type]} {e.text?.slice(0,30)||e.id.slice(0,8)}</button>)}</aside>}
    </div>
    {!!selected.length&&<div className="drawing-selection" aria-label="白板选择操作"><span>{selected.length} 个元素</span><button type="button" disabled={!interactive} onClick={duplicate}>复制</button><button type="button" disabled={!interactive} onClick={()=>layer(true)}>置顶</button><button type="button" disabled={!interactive} onClick={()=>layer(false)}>置底</button><button type="button" disabled={!interactive} onClick={remove}>删除</button><span className="drawing-tool-divider"/><button type="button" disabled={!interactive} onClick={()=>{cancel();setQuery("");setPicker(true);}}>关联笔记</button>{first?.link&&<><button type="button" onClick={openLink} title={first.link.file}>打开关联笔记</button><button type="button" disabled={!interactive} onClick={()=>linkNote()}>解除关联</button><small>{first.link.file}</small></>}</div>}
    <footer className="drawing-status"><span role="status">{notice || (tool === "eraser" ? eraserMode === "stroke" ? "橡皮局部擦除笔迹" : "擦除整个对象（包括笔迹）" : "")}</span><span>{data!.elements.length} 个元素 · 已选 {selected.length} · {Math.round(viewport.zoom*100)}%</span></footer>
    {picker&&<DrawingPopup label="关联白板笔记" onClose={()=>setPicker(false)}><header><strong>关联笔记</strong><button type="button" aria-label="关闭关联笔记" onClick={()=>setPicker(false)}>×</button></header><input autoFocus aria-label="筛选关联笔记" value={query} onChange={event=>setQuery(event.target.value)}/><div>{candidates.map(path=><button key={path} type="button" onClick={()=>linkNote(path)}>{path}</button>)}{!candidates.length&&<p>没有匹配笔记</p>}{notePaths.length>200&&<small>最多显示前 200 项，可输入路径缩小范围。</small>}</div></DrawingPopup>}
    {clearAsk&&<DrawingPopup label="清空白板确认" onClose={()=>setClearAsk(false)}><h3>清空白板？</h3><p>将移除所有绘图元素，不会删除关联笔记。可在本次会话撤销。</p><button type="button" onClick={()=>setClearAsk(false)}>取消</button><button type="button" onClick={()=>{if(commit({...current(),elements:[]})){choose([]);setEditing(null);}setClearAsk(false);}}>确认清空</button></DrawingPopup>}
  </div>;
});
