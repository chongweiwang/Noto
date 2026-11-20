// Geometry/creation adapted from Noteriv canvas-utils.ts (MIT; see third_party/noteriv).
export const maxCanvasBytes=4*1024*1024, maxCanvasNodes=1000, maxCanvasEdges=3000;
export const maxCanvasStrokePoints=10000, maxCanvasDrawingPoints=200000;
export const maxCanvasHistorySteps=50, maxCanvasHistoryBytes=20*1024*1024;
export type Side="top"|"right"|"bottom"|"left";
export type Point={x:number;y:number};
export type CanvasFreehand={format:"noto-canvas-freehand";version:1;points:[number,number][];strokeColor:string;strokeWidth:number;[key:string]:unknown};
export const canvasFreehandFallback="[Noto 画布笔迹]";
export type CanvasNode={id:string;type:"text"|"file"|"group";x:number;y:number;width:number;height:number;text?:string;file?:string;subpath?:string;label?:string;color?:string;[key:string]:unknown};
export type CanvasEdge={id:string;fromNode:string;toNode:string;fromSide?:Side;toSide?:Side;fromEnd?:"none"|"arrow";toEnd?:"none"|"arrow";color?:string;label?:string;[key:string]:unknown};
export type CanvasData={nodes:CanvasNode[];edges:CanvasEdge[];[key:string]:unknown};
export type CanvasViewport={x:number;y:number;zoom:number};
export const emptyCanvas=()=>({nodes:[],edges:[]} as CanvasData);
export const canvasBytes=(s:string)=>new TextEncoder().encode(s).byteLength;
const sides=["top","right","bottom","left"];
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
export function canvasFreehand(node:CanvasNode):CanvasFreehand|undefined {
  const value=node.notoDrawing;
  return object(value)&&value.format==="noto-canvas-freehand"?value as CanvasFreehand:undefined;
}
const id=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
export const validCanvasColor=(value:unknown)=>value===undefined||typeof value==="string"&&/^(?:[1-6]|#[a-f\d]{6})$/i.test(value);
export function canvasFilePath(value:unknown):value is string {
  return typeof value==="string"&&value.length>0&&value.length<4096&&!/[\\:\u0000-\u001f\u007f]/.test(value)&&value.split("/").every(p=>!!p&&!p.startsWith("."));
}
export function parseCanvas(source:string):CanvasData {
  if(canvasBytes(source)>maxCanvasBytes)throw new Error("画布超过 4 MiB 上限，不能编辑或截断保存");
  let root:unknown;
  try{root=JSON.parse(source);}catch{throw new Error("画布 JSON 无法解析，原文已保留；请修复文件后重新载入");}
  if(!object(root))throw new Error("画布必须是 JSON 对象");
  if(root.nodes!==undefined&&!Array.isArray(root.nodes)||root.edges!==undefined&&!Array.isArray(root.edges))throw new Error("画布 nodes/edges 必须是数组");
  const nodes=root.nodes??[],edges=root.edges??[];
  if((nodes as unknown[]).length>maxCanvasNodes||(edges as unknown[]).length>maxCanvasEdges)throw new Error("画布超过 1000 节点或 3000 连接上限，不能截断保存");
  // Refuse values that JSON.stringify would silently corrupt, or cannot safely traverse.
  const pending:[unknown,number][]=[[root,0]];
  while(pending.length){
    const [value,depth]=pending.pop()!;
    if(depth>100)throw new Error("画布 JSON 嵌套超过 100 层，原文只读");
    if(typeof value==="number"&&(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value)))throw new Error("画布包含无法安全保留的数值，原文只读");
    if(value&&typeof value==="object")for(const child of Object.values(value))pending.push([child,depth+1]);
  }
  const nodeIds=new Set<string>(),edgeIds=new Set<string>();let drawingPoints=0;
  for(const raw of nodes as unknown[]) {
    if(!object(raw)||!id(raw.id)||nodeIds.has(raw.id))throw new Error("画布节点 ID 无效或重复");
    nodeIds.add(raw.id);
    if(!["text","file","group"].includes(String(raw.type)))throw new Error("暂不支持的节点类型："+String(raw.type)+"；不是完整的 Noteriv/JSON Canvas 导入器");
    if(!["x","y","width","height"].every(k=>Number.isSafeInteger(raw[k]))||Number(raw.width)<=0||Number(raw.height)<=0)throw new Error("节点位置和尺寸必须是有限整数，尺寸必须为正");
    if(!validCanvasColor(raw.color))throw new Error("不支持的节点颜色");
    if(raw.type==="text"&&typeof raw.text!=="string")throw new Error("文本节点缺少 text");
    const drawing=raw.notoDrawing;
    if(object(drawing)&&drawing.format==="noto-canvas-freehand"){
      if(raw.type!=="text"||drawing.version!==1)throw new Error("不支持的画布笔迹类型或版本，原文已保留");
      if(typeof drawing.strokeColor!=="string"||!/^#[a-f\d]{6}$/i.test(drawing.strokeColor)||typeof drawing.strokeWidth!=="number"||drawing.strokeWidth<1||drawing.strokeWidth>16)throw new Error("画布笔迹颜色或宽度无效，原文已保留");
      if(!Array.isArray(drawing.points)||!drawing.points.length||drawing.points.length>maxCanvasStrokePoints)throw new Error("画布单笔需要 1～10000 个点，原文已保留");
      for(const point of drawing.points)if(!Array.isArray(point)||point.length!==2||!point.every(n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1))throw new Error("画布笔迹坐标无效，原文已保留");
      drawingPoints+=drawing.points.length;if(drawingPoints>maxCanvasDrawingPoints)throw new Error("画布笔迹总点数超过 200000，原文已保留");
    }
    if(raw.type==="file"&&!canvasFilePath(raw.file))throw new Error("文件节点必须使用知识库根相对 file 路径；不支持绝对路径或 Noteriv filePath");
    if(raw.subpath!==undefined&&(typeof raw.subpath!=="string"||!raw.subpath.startsWith("#")))throw new Error("文件节点 subpath 必须以 # 开头");
    if(raw.label!==undefined&&typeof raw.label!=="string")throw new Error("分组 label 必须是文字");
    if(raw.type==="group"&&raw.background!==undefined)throw new Error("首版不支持分组背景，原文已保留");
  }
  for(const raw of edges as unknown[]) {
    if(!object(raw)||!id(raw.id)||edgeIds.has(raw.id))throw new Error("画布连接 ID 无效或重复");
    edgeIds.add(raw.id);
    if(!nodeIds.has(String(raw.fromNode))||!nodeIds.has(String(raw.toNode))||typeof raw.fromNode!=="string"||typeof raw.toNode!=="string")throw new Error("连接引用了不存在的节点");
    if(["fromSide","toSide"].some(k=>raw[k]!==undefined&&!sides.includes(String(raw[k]))))throw new Error("连接端点方向无效");
    if(["fromEnd","toEnd"].some(k=>raw[k]!==undefined&&!["none","arrow"].includes(String(raw[k]))))throw new Error("连接箭头类型无效");
    if(!validCanvasColor(raw.color)||raw.label!==undefined&&typeof raw.label!=="string")throw new Error("连接颜色或标签无效");
  }
  return {...root,nodes,edges} as CanvasData;
}
export function serializeCanvas(data:CanvasData):string {
  const source=JSON.stringify(data,null,2);parseCanvas(source);return source;
}
export const newCanvasId=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),n=>n.toString(16).padStart(2,"0")).join("");
export function createCanvasNode(type:CanvasNode["type"],p:Point,fields:Partial<CanvasNode>={}):CanvasNode {
  return {id:newCanvasId(),type,x:Math.round(p.x),y:Math.round(p.y),width:type==="group"?480:280,height:type==="group"?300:180,...(type==="text"?{text:""}:type==="group"?{label:"分组"}:{}),...fields};
}
export function createCanvasFreehand(points:Point[],strokeColor:string,strokeWidth:number,id=newCanvasId()):CanvasNode {
  if(!points.length||points.length>maxCanvasStrokePoints)throw new Error("单笔超过 10000 点，本次笔迹已取消");
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const p of points){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
  const padding=Math.max(2,strokeWidth/2+1),x=Math.floor(minX-padding),y=Math.floor(minY-padding);
  const width=Math.max(1,Math.ceil(maxX+padding)-x),height=Math.max(1,Math.ceil(maxY+padding)-y);
  const normalized=points.map(p=>[Math.round((p.x-x)/width*100000)/100000,Math.round((p.y-y)/height*100000)/100000] as [number,number]);
  return {id,type:"text",x,y,width,height,text:canvasFreehandFallback,color:strokeColor,notoDrawing:{format:"noto-canvas-freehand",version:1,points:normalized,strokeColor,strokeWidth} satisfies CanvasFreehand};
}
export const canvasColor=(color?:string)=>color&&validCanvasColor(color)?({"1":"#e86b76","2":"#d69152","3":"#c2a948","4":"#65a77c","5":"#60a8bf","6":"#aa80c4"}[color]??color):"var(--border)";
export const contains=(outer:CanvasNode,inner:CanvasNode)=>inner.x>=outer.x&&inner.y>=outer.y&&inner.x+inner.width<=outer.x+outer.width&&inner.y+inner.height<=outer.y+outer.height;
export function movingCanvasIds(data:CanvasData,selected:string[]):Set<string> {
  const ids=new Set(selected);
  for(const group of data.nodes.filter(n=>n.type==="group"&&ids.has(n.id)))for(const n of data.nodes)if(n.type!=="group"&&contains(group,n))ids.add(n.id);
  return ids;
}
export function moveCanvasNodes(data:CanvasData,ids:Set<string>,dx:number,dy:number):CanvasData {
  return {...data,nodes:data.nodes.map(n=>ids.has(n.id)?{...n,x:Math.round(n.x+dx),y:Math.round(n.y+dy)}:n)};
}
export function deleteCanvasSelection(data:CanvasData,ids:Set<string>,edge?:string|null):CanvasData {
  return {...data,nodes:data.nodes.filter(n=>!ids.has(n.id)),edges:data.edges.filter(e=>e.id!==edge&&!ids.has(e.fromNode)&&!ids.has(e.toNode))};
}
export function duplicateCanvasNodes(data:CanvasData,selected:Set<string>) {
  const map=new Map(data.nodes.filter(n=>selected.has(n.id)).map(n=>[n.id,newCanvasId()]));
  const nodes=data.nodes.filter(n=>map.has(n.id)).map(n=>({...n,id:map.get(n.id)!,x:n.x+24,y:n.y+24}));
  const edges=data.edges.filter(e=>map.has(e.fromNode)&&map.has(e.toNode)).map(e=>({...e,id:newCanvasId(),fromNode:map.get(e.fromNode)!,toNode:map.get(e.toNode)!}));
  return {data:{...data,nodes:[...data.nodes,...nodes],edges:[...data.edges,...edges]},ids:[...map.values()]};
}
export function canvasSide(from:CanvasNode,to:CanvasNode):Side {
  const dx=to.x+to.width/2-from.x-from.width/2,dy=to.y+to.height/2-from.y-from.height/2;
  return Math.abs(dx)>Math.abs(dy)?dx>0?"right":"left":dy>0?"bottom":"top";
}
export function canvasAnchor(n:CanvasNode,side:Side):Point {
  return side==="top"?{x:n.x+n.width/2,y:n.y}:side==="bottom"?{x:n.x+n.width/2,y:n.y+n.height}:side==="left"?{x:n.x,y:n.y+n.height/2}:{x:n.x+n.width,y:n.y+n.height/2};
}
export function canvasEdgeGeometry(e:CanvasEdge,from:CanvasNode,to:CanvasNode) {
  const fromSide=e.fromSide??canvasSide(from,to),toSide=e.toSide??canvasSide(to,from);
  const a=canvasAnchor(from,fromSide),b=canvasAnchor(to,toSide),ca={...a},cb={...b};
  const offset=(p:Point,s:Side)=>{if(s==="left")p.x-=60;else if(s==="right")p.x+=60;else if(s==="top")p.y-=60;else p.y+=60;};
  offset(ca,fromSide);offset(cb,toSide);
  return {d:`M${a.x},${a.y} C${ca.x},${ca.y} ${cb.x},${cb.y} ${b.x},${b.y}`,x:(a.x+b.x)/2,y:(a.y+b.y)/2,a,b,ca,cb};
}
export function canvasWorld(p:Point,v:CanvasViewport):Point {return {x:(p.x-v.x)/v.zoom,y:(p.y-v.y)/v.zoom};}
export function zoomCanvas(v:CanvasViewport,p:Point,zoom:number):CanvasViewport {
  const z=Math.min(3,Math.max(.15,zoom)),world=canvasWorld(p,v);return {x:p.x-world.x*z,y:p.y-world.y*z,zoom:z};
}
export function fitCanvas(nodes:CanvasNode[],width:number,height:number):CanvasViewport {
  if(!nodes.length)return {x:width/2,y:height/2,zoom:1};
  const x=Math.min(...nodes.map(n=>n.x)),y=Math.min(...nodes.map(n=>n.y)),w=Math.max(...nodes.map(n=>n.x+n.width))-x,h=Math.max(...nodes.map(n=>n.y+n.height))-y;
  const zoom=Math.min(1.5,Math.max(.15,Math.min(Math.max(width-100,1)/Math.max(w,1),Math.max(height-100,1)/Math.max(h,1))));
  return {zoom,x:(width-w*zoom)/2-x*zoom,y:(height-h*zoom)/2-y*zoom};
}
export function canvasVisible(n:CanvasNode,v:CanvasViewport,w:number,h:number,pad=160) {
  return (n.x+n.width)*v.zoom+v.x>=-pad&&n.x*v.zoom+v.x<=w+pad&&(n.y+n.height)*v.zoom+v.y>=-pad&&n.y*v.zoom+v.y<=h+pad;
}
type HistoryStep={before:string;after:string;group?:string;time:number;bytes:number};
export class CanvasHistory {
  past:HistoryStep[]=[];future:HistoryStep[]=[];
  clear(){this.past=[];this.future=[];}
  record(before:string,after:string,group?:string) {
    if(before===after)return 0;
    const last=this.past.at(-1),now=Date.now();this.future=[];
    if(group&&last?.group===group&&last.after===before&&now-last.time<1200) {last.after=after;last.time=now;last.bytes=canvasBytes(last.before)+canvasBytes(after);}
    else this.past.push({before,after,group,time:now,bytes:canvasBytes(before)+canvasBytes(after)});
    let size=this.past.reduce((total,s)=>total+s.bytes,0),removed=0;
    while(this.past.length>maxCanvasHistorySteps||size>maxCanvasHistoryBytes){size-=this.past.shift()!.bytes;removed++;}
    return removed;
  }
  undo(current:string){const s=this.past.at(-1);if(!s||s.after!==current)return null;this.past.pop();this.future.push(s);return s.before;}
  redo(current:string){const s=this.future.at(-1);if(!s||s.before!==current)return null;this.future.pop();this.past.push(s);return s.after;}
}
