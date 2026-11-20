import {expect,it} from "vitest";
import {arrangeCanvasNodes,canvasLayoutUnits,snapCanvasMove} from "./canvas-layout";
import {createCanvasNode,parseCanvas,serializeCanvas,type CanvasData} from "./canvas-document";

const card=(id:string,x:number,y:number,width=100,height=80)=>createCanvasNode("text",{x,y},{id,width,height,text:id});

it("六种对齐按所选对象的包围范围定位，保留顺序、连接和未知字段",()=>{
 const a=card("a",0,20,100,60),b=card("b",210,140,60,100),c=card("c",400,260,120,80);
 const data:CanvasData={nodes:[a,b,c],edges:[{id:"edge",fromNode:"a",toNode:"b",extra:1}],extra:{keep:true}},ids=new Set(["a","b","c"]);
 const positions=(kind:Parameters<typeof arrangeCanvasNodes>[2])=>arrangeCanvasNodes(data,ids,kind).nodes.map(n=>[n.x,n.y]);
 expect(positions("left")).toEqual([[0,20],[0,140],[0,260]]);expect(positions("right")).toEqual([[420,20],[460,140],[400,260]]);
 expect(positions("center-x")).toEqual([[210,20],[230,140],[200,260]]);expect(positions("top")).toEqual([[0,20],[210,20],[400,20]]);
 expect(positions("bottom")).toEqual([[0,280],[210,240],[400,260]]);expect(positions("center-y")).toEqual([[0,150],[210,130],[400,140]]);
 const aligned=arrangeCanvasNodes(data,ids,"left");expect(aligned.edges).toBe(data.edges);expect(aligned.extra).toEqual(data.extra);expect(parseCanvas(serializeCanvas(aligned))).toEqual(aligned);
 expect(arrangeCanvasNodes(aligned,ids,"left")).toBe(aligned);
});

it("水平及垂直分布固定两端，对不同尺寸的对象均分间距",()=>{
 const data:CanvasData={nodes:[card("b",110,130,80,40),card("a",0,0,50,50),card("c",300,300,40,70)],edges:[]},ids=new Set(["a","b","c"]);
 const horizontal=arrangeCanvasNodes(data,ids,"distribute-x"),vertical=arrangeCanvasNodes(data,ids,"distribute-y");
 expect(horizontal.nodes.map(n=>n.x)).toEqual([135,0,300]);expect(vertical.nodes.map(n=>n.y)).toEqual([155,0,300]);
 expect(arrangeCanvasNodes(data,new Set(["a","b"]),"distribute-x")).toBe(data);
});

it("分组与组内选中节点作为整体移动，重叠分组存在冲突时拒绝提交",()=>{
 const group=createCanvasNode("group",{x:0,y:100},{id:"group",width:300,height:200}),child=card("child",10,120),other=card("other",500,0);
 const data:CanvasData={nodes:[group,child,other],edges:[]},ids=new Set(["group","child","other"]);
 expect(canvasLayoutUnits(data,ids).map(n=>n.id)).toEqual(["group","other"]);
 const result=arrangeCanvasNodes(data,ids,"top");expect(result.nodes.map(n=>n.y)).toEqual([0,20,0]);
 const a=createCanvasNode("group",{x:0,y:0},{id:"g1",width:300,height:300}),b=createCanvasNode("group",{x:50,y:50},{id:"g2",width:300,height:300}),shared=card("shared",100,100);
 const overlap:CanvasData={nodes:[a,b,shared],edges:[]};expect(()=>arrangeCanvasNodes(overlap,new Set(["g1","g2"]),"left")).toThrow(/共同节点/);expect(overlap.nodes[2]).toBe(shared);
});

it("拖动参考线按屏幕容差吸附可见节点，不受离屏对象或半像素中心误导",()=>{
 const moving=card("a",0,0,100,100),target=card("b",200,100,100,100),far=card("far",2000,0,100,100),data:CanvasData={nodes:[moving,target,far],edges:[]};
 const one=snapCanvasMove(data,new Set(["a"]),96,97,{x:0,y:0,zoom:1},800,600);
 expect([one.dx,one.dy]).toEqual([100,100]);expect(one.guides.map(g=>[g.axis,g.at])).toEqual([["x",200],["y",100]]);
 const two=snapCanvasMove(data,new Set(["a"]),96,97,{x:0,y:0,zoom:2},800,600);expect(two.dx).toBe(96);expect(two.dy).toBe(100);expect(two.guides.map(g=>g.axis)).toEqual(["y"]);
 expect(snapCanvasMove({nodes:[moving,far],edges:[]},new Set(["a"]),2,2,{x:0,y:0,zoom:1},800,600).guides).toEqual([]);
 const odd:CanvasData={nodes:[card("a",0,0,99,80),card("b",200,200,100,80)],edges:[]};
 const result=snapCanvasMove(odd,new Set(["a"]),151,100,{x:0,y:0,zoom:1},800,600);
 expect(result.guides.filter(g=>g.axis==="x").every(g=>Number.isInteger(g.at))).toBe(true);
});
