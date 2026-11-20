import {expect,it} from "vitest";
import {canvasFreehand,createCanvasFreehand,createCanvasNode,parseCanvas,serializeCanvas,type CanvasData} from "./canvas-document";
import {eraseCanvasFreehand} from "./canvas-eraser";

it("局部擦除稀疏笔迹并保留卡片、连接、样式与未知字段",()=>{
 const base=createCanvasFreehand([{x:0,y:20},{x:100,y:20}],"#123456",4,"pen"),stroke=canvasFreehand(base)!;
 const node={...base,extra:{keep:true},notoDrawing:{...stroke,future:"保留"}},card=createCanvasNode("text",{x:0,y:0},{id:"card",text:"不应删除"});
 const data:CanvasData={nodes:[node,card],edges:[{id:"edge",fromNode:"pen",toNode:"card"}],custom:{keep:true}};
 expect(eraseCanvasFreehand(data,{x:50,y:100},{x:50,y:120},10)).toBe(data);
 const cut=eraseCanvasFreehand(data,{x:50,y:-20},{x:50,y:60},10);
 expect(cut.nodes).toHaveLength(3);expect(cut.nodes[0].id).toBe("pen");expect(cut.nodes[1].id).not.toBe("pen");
 expect(cut.nodes[2]).toEqual(card);expect(cut.edges).toEqual(data.edges);expect(cut.custom).toEqual(data.custom);
 expect(cut.nodes.slice(0,2).every(n=>canvasFreehand(n)?.strokeColor==="#123456"&&canvasFreehand(n)?.strokeWidth===4&&canvasFreehand(n)?.future==="保留"&&JSON.stringify(n.extra)==='{"keep":true}')).toBe(true);
 const left=canvasFreehand(cut.nodes[0])!,right=canvasFreehand(cut.nodes[1])!;
 expect(cut.nodes[0].x+left.points.at(-1)![0]*cut.nodes[0].width).toBeCloseTo(38,1);
 expect(cut.nodes[1].x+right.points[0][0]*cut.nodes[1].width).toBeCloseTo(62,1);
 expect(parseCanvas(serializeCanvas(cut))).toEqual(cut);
});

it("擦完整笔时仅移除该笔及其连接，单点和未知节点保持正确",()=>{
 const dot=createCanvasFreehand([{x:20,y:20}],"#abcdef",2,"dot"),card=createCanvasNode("text",{x:0,y:0},{id:"card",text:"保留",notoDrawing:{format:"other-extension",value:1}});
 const data:CanvasData={nodes:[dot,card],edges:[{id:"edge",fromNode:"dot",toNode:"card"}]};
 const erased=eraseCanvasFreehand(data,{x:20,y:20},{x:20,y:20},10);
 expect(erased.nodes).toEqual([card]);expect(erased.edges).toEqual([]);expect(parseCanvas(serializeCanvas(erased))).toEqual(erased);
});

it("重复擦同一位置不会产生无界碎片，也不改变未命中的笔迹",()=>{
 const pen=createCanvasFreehand([{x:0,y:0},{x:200,y:0}],"#123456",2,"pen"),other=createCanvasFreehand([{x:0,y:100},{x:200,y:100}],"#abcdef",3,"other");
 let data:CanvasData={nodes:[pen,other],edges:[]};
 for(let i=0;i<30;i++)data=eraseCanvasFreehand(data,{x:100,y:0},{x:100,y:0},10);
 expect(data.nodes).toHaveLength(3);expect(data.nodes[2]).toBe(other);expect(parseCanvas(serializeCanvas(data))).toEqual(data);
});
