// Drawing model adapted from Noteriv drawing-utils.ts (MIT; third_party/noteriv).
// Geometry, storage and strict Noto format are independent of its desktop IO.
import {canvasFilePath,CanvasHistory,newCanvasId} from "./canvas-document";
import {isMarkdown} from "./document-kind";
export const maxDrawingBytes=8*1024*1024,maxDrawingElements=2000,maxStrokePoints=10000,maxDrawingPoints=200000;
export type DrawingType="pencil"|"rectangle"|"ellipse"|"line"|"arrow"|"text";
export type DrawingTool="select"|"hand"|"eraser"|DrawingType;
export const drawingTools:DrawingTool[]=["select","hand","pencil","rectangle","ellipse","line","arrow","text","eraser"];
export type DrawingLink={file:string;subpath?:string;[key:string]:unknown};
export type DrawingElement={id:string;type:DrawingType;x:number;y:number;width:number;height:number;strokeColor:string;strokeWidth?:number;fillColor?:string;fontSize?:number;text?:string;points?:[number,number][];link?:DrawingLink;[key:string]:unknown};
export type DrawingData={type:"noto-drawing";version:1;background:string;elements:DrawingElement[];[key:string]:unknown};
export type DrawingStyle={strokeColor:string;fillColor:string;strokeWidth:number;fontSize:number};
export const defaultDrawingStyle:DrawingStyle={strokeColor:"#1f2937",fillColor:"transparent",strokeWidth:2,fontSize:20};
export const emptyDrawing=():DrawingData=>({type:"noto-drawing",version:1,background:"#ffffff",elements:[]});
export const drawingColor=(v:unknown):v is string=>typeof v==="string"&&/^#[a-f\d]{6}$/i.test(v);
export const drawingBytes=(s:string)=>new TextEncoder().encode(s).byteLength;
export const drawingNumber=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v)&&Math.abs(v)<=1e7;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
export function parseDrawing(source:string):DrawingData {
  if(drawingBytes(source)>maxDrawingBytes)throw new Error("白板超过 8 MiB，不能截断编辑或保存");
  let root:unknown;try{root=JSON.parse(source);}catch{throw new Error("白板 JSON 无法解析，原文已保留");}
  if(!object(root)||root.type!=="noto-drawing"||root.version!==1)throw new Error("不支持的白板格式/版本；不是 Noteriv 或 Excalidraw 转换器，原文只读");
  if(!drawingColor(root.background)||!Array.isArray(root.elements))throw new Error("白板需要有效背景色和 elements 数组");
  if(root.elements.length>maxDrawingElements)throw new Error("白板超过 2000 元素上限");
  const pending:[unknown,number][]=[[root,0]];
  while(pending.length){
    const [v,depth]=pending.pop()!;
    if(depth>100)throw new Error("白板 JSON 嵌套超过 100 层");
    if(typeof v==="number"&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))throw new Error("白板包含无法安全保留的数值");
    if(v&&typeof v==="object")for(const child of Object.values(v))pending.push([child,depth+1]);
  }
  const ids=new Set<string>();let count=0;
  for(const e of root.elements){
    if(!object(e)||typeof e.id!=="string"||!e.id||e.id.length>256||/[\u0000-\u001f\u007f]/.test(e.id)||ids.has(e.id))throw new Error("白板元素 ID 无效或重复");
    ids.add(e.id);
    if(!["pencil","rectangle","ellipse","line","arrow","text"].includes(String(e.type)))throw new Error("暂不支持的白板元素："+String(e.type));
    if(!["x","y","width","height"].every(k=>drawingNumber(e[k])))throw new Error("白板几何超出有限坐标范围");
    if(e.type==="line"||e.type==="arrow"){
      if(e.width===0&&e.height===0||!drawingNumber(Number(e.x)+Number(e.width))||!drawingNumber(Number(e.y)+Number(e.height)))throw new Error("线段需要有效的两个端点");
    }else if(Number(e.width)<=0||Number(e.height)<=0)throw new Error("元素尺寸必须为正");
    if(!drawingColor(e.strokeColor)||e.fillColor!==undefined&&e.fillColor!=="transparent"&&!drawingColor(e.fillColor))throw new Error("白板颜色无效");
    if(e.strokeWidth!==undefined&&(typeof e.strokeWidth!=="number"||e.strokeWidth<1||e.strokeWidth>16))throw new Error("笔宽应为 1～16");
    if(e.fontSize!==undefined&&(typeof e.fontSize!=="number"||e.fontSize<12||e.fontSize>96))throw new Error("字号应为 12～96");
    if(e.type==="text"&&(typeof e.text!=="string"||typeof e.fontSize!=="number"))throw new Error("文字元素缺少正文或字号");
    if(e.type==="pencil"){
      if(!Array.isArray(e.points)||!e.points.length||e.points.length>maxStrokePoints)throw new Error("单笔需要 1～10000 个点");
      for(const point of e.points)if(!Array.isArray(point)||point.length!==2||!point.every(drawingNumber)||point[0]<0||point[1]<0||point[0]>Number(e.width)||point[1]>Number(e.height))throw new Error("笔迹需要位于包围框内的局部坐标");
      count+=e.points.length;if(count>maxDrawingPoints)throw new Error("白板总点数超过 200000");
    }else if(e.points!==undefined)throw new Error("只有笔迹可以包含 points");
    if(e.link!==undefined){
      if(!object(e.link)||!canvasFilePath(e.link.file)||!isMarkdown(e.link.file)||e.link.subpath!==undefined&&(typeof e.link.subpath!=="string"||!e.link.subpath.startsWith("#")))throw new Error("关联笔记需要知识库根相对 Markdown 路径和独立标题");
    }
  }
  return root as DrawingData;
}
export function serializeDrawing(data:DrawingData){const source=JSON.stringify(data,null,2);parseDrawing(source);return source;}
export {CanvasHistory as DrawingHistory};
export const newDrawingId=newCanvasId;
export const roundDrawing=(n:number)=>Math.round(n*100)/100;
export function moveDrawing(data:DrawingData,ids:Set<string>,dx:number,dy:number):DrawingData {
  return {...data,elements:data.elements.map(e=>ids.has(e.id)?{...e,x:roundDrawing(e.x+dx),y:roundDrawing(e.y+dy)}:e)};
}
export function duplicateDrawing(data:DrawingData,ids:Set<string>){
  const added=data.elements.filter(e=>ids.has(e.id)).map(e=>({...e,id:newDrawingId(),x:e.x+24,y:e.y+24}));
  return {data:{...data,elements:[...data.elements,...added]},ids:added.map(e=>e.id)};
}
export function drawingTextSize(text:string,fontSize:number,measure?:(text:string)=>number){
  const lines=text.replace(/\t/g,"    ").split("\n");
  // CLI/export fallback is deliberately conservative; live views use measureText.
  const width=Math.max(20,...lines.map(line=>measure?measure(line):[...line].length*fontSize));
  return {width:Math.ceil(width+8),height:Math.ceil(Math.max(1,lines.length)*fontSize*1.4)};
}
export function drawingTextBounds(e:DrawingElement,measure?:(line:string,fontSize:number)=>number):DrawingElement {
  if(e.type!=="text")return e;
  const size=drawingTextSize(e.text!,e.fontSize!,measure?(line)=>measure(line,e.fontSize!):undefined);
  return {...e,width:Math.max(e.width,size.width),height:Math.max(e.height,size.height)};
}
