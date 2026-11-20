import {expect,it} from "vitest";
import {emptyDrawing,parseDrawing,serializeDrawing,DrawingHistory,moveDrawing,duplicateDrawing,maxDrawingBytes,maxDrawingPoints} from "./drawing-document";
import {createDrawingElement,pencilElement,hitDrawing,hitDrawingSegment,eraseDrawingSegment,resizeDrawingElement,drawingBounds,drawingExtent,drawingSurfaceSize,fitDrawing} from "./drawing-geometry";
import {drawingToSvg} from "./drawing-svg";
import {defaultDrawingStyle as style} from "./drawing-document";
const shape=()=>createDrawingElement("rectangle",{x:0,y:0},{x:100,y:80},style,"shape");
it("白板严格往返保留未知字段、ID和数组层级；读取不变更正文",()=>{
 const data={...emptyDrawing(),custom:{retained:[1,"x"]},elements:[{...shape(),custom:{keep:true},link:{file:"资料/100% #.md",custom:1}}]};
 const raw=JSON.stringify(data,null,3);expect(parseDrawing(raw)).toEqual(data);expect(parseDrawing(serializeDrawing(data))).toEqual(data);
});
it("未知格式、版本、元素、重复ID和非法已知字段不能变空编辑",()=>{
 const valid={...emptyDrawing(),elements:[shape()]};
 for(const data of [{},[],{...valid,type:"drawing"},{...valid,version:2},{...valid,elements:[shape(),shape()]},{...valid,background:"url(x)"},{...valid,elements:[{...shape(),type:"image"}]},{...valid,elements:[{...shape(),width:0}]},{...valid,elements:[{...shape(),strokeColor:"red"}]},{...valid,elements:[{...shape(),link:{file:"../a.md"}}]},{...valid,elements:[{...shape(),link:{file:"a.canvas"}}]}])expect(()=>parseDrawing(JSON.stringify(data))).toThrow();
 expect(()=>parseDrawing("{broken")).toThrow(/原文/);
 expect(()=>parseDrawing(JSON.stringify({...valid,extra:1e30}))).toThrow(/数值/);
 expect(()=>parseDrawing('{"type":"noto-drawing","version":1,"background":"#ffffff","elements":[],"x":1e999}')).toThrow();
});
it("空心形状内部不误命中，填充内部可选，反向/水平/垂直线按线段命中",()=>{
 expect(hitDrawing(shape(),{x:50,y:40},2)).toBe(false);expect(hitDrawing(shape(),{x:0,y:40},2)).toBe(true);
 expect(hitDrawing({...shape(),fillColor:"#123456"},{x:50,y:40},2)).toBe(true);
 for(const end of [{x:-100,y:-80},{x:100,y:0},{x:0,y:100}]){const e=createDrawingElement("arrow",{x:0,y:0},end,style);expect(()=>parseDrawing(serializeDrawing({...emptyDrawing(),elements:[e]}))).not.toThrow();expect(hitDrawing(e,{x:end.x/2,y:end.y/2},2)).toBe(true);expect(drawingBounds(e).width).toBeGreaterThan(0);}
});
it("稀疏笔迹命中线段而非采样点，快速橡皮经过线段也命中",()=>{
 const e=pencilElement([{x:10,y:20},{x:1010,y:20}],style,"p");
 expect(e.points).toEqual([[0,0],[1000,0]]);expect(hitDrawing(e,{x:500,y:20},1)).toBe(true);
 expect(hitDrawingSegment(e,{x:500,y:-50},{x:500,y:90},2)).toBe(true);expect(hitDrawing(e,{x:500,y:90},1)).toBe(false);
});
it("局部橡皮沿扫过的线段切开稀疏笔迹，保留样式、关联和未知字段",()=>{
 const stroke={...pencilElement([{x:0,y:20},{x:100,y:20}],style,"pen"),link:{file:"笔记.md"},extra:{keep:true}};
 const original={...emptyDrawing(),elements:[stroke]};
 expect(eraseDrawingSegment(original,{x:50,y:80},{x:50,y:90},10)).toBe(original);
 const cut=eraseDrawingSegment(original,{x:50,y:-20},{x:50,y:60},10);
 expect(cut.elements).toHaveLength(2);expect(cut.elements[0].id).toBe("pen");expect(cut.elements[1].id).not.toBe("pen");
 expect(cut.elements.map(e=>e.points)).toEqual([[[0,0],[39,0]],[[0,0],[39,0]]]);
 expect(cut.elements.map(e=>e.x)).toEqual([0,61]);
 expect(cut.elements.every(e=>e.strokeColor===stroke.strokeColor&&e.strokeWidth===stroke.strokeWidth&&e.link?.file==="笔记.md"&&JSON.stringify(e.extra)==='{"keep":true}')).toBe(true);
 expect(parseDrawing(serializeDrawing(cut))).toEqual(cut);
 const second=eraseDrawingSegment(cut,{x:20,y:20},{x:20,y:20},5);expect(second.elements).toHaveLength(3);
 expect(parseDrawing(serializeDrawing(second))).toEqual(second);
 const dot=pencilElement([{x:5,y:5}],style,"dot");expect(eraseDrawingSegment({...emptyDrawing(),elements:[dot]},{x:5,y:5},{x:5,y:5},2).elements).toEqual([]);
});
it("橡皮的笔迹模式保留形状，对象模式整件移除命中的笔迹和形状",()=>{
 const pen=pencilElement([{x:0,y:0},{x:100,y:0}],style,"pen"),rect=shape(),doc={...emptyDrawing(),elements:[pen,rect]};
 const strokes=eraseDrawingSegment(doc,{x:50,y:0},{x:50,y:0},10,undefined,"stroke");
 expect(strokes.elements).toHaveLength(3);expect(strokes.elements[2]).toBe(rect);
 const objects=eraseDrawingSegment(doc,{x:50,y:0},{x:50,y:0},10,undefined,"object");
 expect(objects.elements).toEqual([]);expect(eraseDrawingSegment(doc,{x:400,y:400},{x:400,y:400},10,undefined,"object")).toBe(doc);
});
it("笔迹移动/尺寸/复制统一局部坐标，单点和退化轴不产生NaN",()=>{
 const e=pencilElement([{x:-10,y:-20},{x:10,y:30}],style,"p"),doc={...emptyDrawing(),elements:[e]};
 const moved=moveDrawing(doc,new Set(["p"]),100,30).elements[0];expect(moved.points).toEqual(e.points);expect(hitDrawing(moved,{x:90,y:10},1)).toBe(true);
 const sized=resizeDrawingElement(e,"se",20,50);expect(sized.points).toEqual([[0,0],[40,100]]);
 const copy=duplicateDrawing(doc,new Set(["p"]));expect(copy.ids[0]).not.toBe("p");expect(copy.data.elements[1].points).toEqual(e.points);
 const dot=pencilElement([{x:10,y:10}],style);expect(dot.width).toBe(1);expect(drawingToSvg(serializeDrawing({...emptyDrawing(),elements:[dot]}))).toContain("<circle");
});
it("完整历史撤销移动/删除/样式，重做与分支、合并和预算有界",()=>{
 const h=new DrawingHistory();h.record("a","b","text");h.record("b","c","text");expect(h.undo("c")).toBe("a");expect(h.redo("a")).toBe("c");
 h.record("c","moved");h.record("moved","deleted");expect(h.undo("deleted")).toBe("moved");expect(h.undo("moved")).toBe("c");
 h.record("c","colored");expect(h.redo("colored")).toBeNull();
 for(let i=0;i<100;i++)h.record(String(i),String(i+1));expect(h.past.length).toBeLessThanOrEqual(50);
 expect(h.undo("unrelated")).toBeNull();h.clear();expect(h.past).toEqual([]);
});
it("容量边界不截断；几何/颜色/局部点和未知数值深度保护",()=>{
 expect(()=>parseDrawing(" ".repeat(maxDrawingBytes+1))).toThrow(/8 MiB/);
 expect(()=>serializeDrawing({...emptyDrawing(),elements:Array.from({length:2001},(_,i)=>({...shape(),id:String(i)}))})).toThrow(/2000/);
 const e=pencilElement([{x:0,y:0}],style);
 expect(()=>serializeDrawing({...emptyDrawing(),elements:[{...e,points:Array.from({length:10001},()=>[0,0])}]})).toThrow(/10000/);
 expect(()=>parseDrawing(JSON.stringify({...emptyDrawing(),elements:Array.from({length:21},(_,i)=>({...e,id:String(i),points:Array.from({length:10000},()=>[0,0] as [number,number])}))}))).toThrow(/200000/);
 expect(maxDrawingPoints).toBe(200000);
 let nested:unknown={};for(let i=0;i<105;i++)nested={nested};
 expect(()=>parseDrawing(JSON.stringify({...emptyDrawing(),nested}))).toThrow(/100/);
 for(const change of [{x:1e8},{strokeWidth:100},{points:[[2,2] as [number,number]]}])expect(()=>serializeDrawing({...emptyDrawing(),elements:[{...e,...change}]})).toThrow();
});
it("SVG完整保留箭头方向/样式/多行文字且转义，不注入链接或未知字段",()=>{
 const arrow=createDrawingElement("arrow",{x:100,y:100},{x:-20,y:-40},{...style,strokeColor:"#123456",strokeWidth:6},"a");
 const text={...createDrawingElement("text",{x:0,y:0},{x:1,y:1},style,"t"),text:'中文 <script> & "引号"\n第二行',link:{file:"秘密.md"},extra:{url:"https://not-in-svg.invalid"}};
 const raw=serializeDrawing({...emptyDrawing(),elements:[arrow,text]});const svg=drawingToSvg(raw);
 expect(svg).toContain('x2="-20"');expect(svg).toContain('stroke-width="6"');expect(svg).toContain("&lt;script&gt;");expect(svg.match(/<tspan /g)).toHaveLength(2);
 expect(svg).not.toMatch(/<script|href=|秘密|not-in-svg/);expect(svg).toContain("<polygon");
 expect(drawingToSvg(serializeDrawing(emptyDrawing()))).toContain('width="240"');
 expect(()=>drawingToSvg(serializeDrawing({...emptyDrawing(),elements:[{...shape(),width:1e6}]}))).toThrow(/100000/);
});
it("DPR位图预算、负坐标边界和首次适应有界",()=>{
 const size=drawingSurfaceSize(20000,10000,3);expect(size.width).toBeLessThanOrEqual(8192);expect(size.height).toBeLessThanOrEqual(8192);expect(size.width*size.height).toBeLessThanOrEqual(16000000);
 expect(drawingSurfaceSize(100,50,2)).toEqual({width:200,height:100,ratio:2});
 const e=createDrawingElement("arrow",{x:-200,y:-100},{x:100,y:200},style);
 expect(drawingExtent([e]).x).toBeLessThan(-200);const v=fitDrawing([e],800,600);expect(v.zoom).toBeGreaterThanOrEqual(.15);expect(Number.isFinite(v.x)).toBe(true);
});
it("外部文字修改未更新包围框时，SVG和适应视图仍容纳完整内容而不改写源文件",()=>{
 const e={...createDrawingElement("text",{x:0,y:0},{x:0,y:0},style,"text"),text:"W".repeat(50)+"\n中文",width:1,height:1};
 const raw=serializeDrawing({...emptyDrawing(),elements:[e]}),svg=drawingToSvg(raw);
 expect(drawingExtent([e]).width).toBeGreaterThanOrEqual(1000);expect(drawingExtent([e]).height).toBeGreaterThanOrEqual(56);
 expect(Number(/width="([\d.]+)"/.exec(svg)![1])).toBeGreaterThan(1000);
 const measured=drawingToSvg(raw,line=>line.length*18);expect(Number(/width="([\d.]+)"/.exec(measured)![1])).toBeGreaterThan(900);
 expect(parseDrawing(raw).elements[0].width).toBe(1);
});
it.each([200,1000])("%i 元素与长笔迹模型、SVG往返保持完整",count=>{
 const start=performance.now(),points=count===200?10000:100000;
 const elements=Array.from({length:count},(_,i)=>({...shape(),id:"e"+i,x:i%50*120,y:Math.floor(i/50)*100}));
 for(let i=0;i<points/1000;i++)elements[i]={...pencilElement(Array.from({length:1000},(_,p)=>({x:p,y:Math.sin(p/30)*20})),style,"e"+i),x:i%50*120,y:Math.floor(i/50)*100};
 const source=serializeDrawing({...emptyDrawing(),elements}),parsed=parseDrawing(source),svg=drawingToSvg(source);
 expect(parsed.elements).toHaveLength(count);expect(parsed.elements.reduce((n,e)=>n+(e.points?.length??0),0)).toBe(points);expect(parseDrawing(source)).toEqual(parsed);
 console.log("stage46-scale",JSON.stringify({elements:count,points,jsonBytes:new TextEncoder().encode(source).byteLength,svgBytes:new TextEncoder().encode(svg).byteLength,elapsedMs:Math.round(performance.now()-start),scope:"model only"}));
});
