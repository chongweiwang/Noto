import {expect,it,vi} from "vitest";
import {CanvasHistory,canvasFilePath,canvasFreehand,canvasFreehandFallback,canvasWorld,createCanvasFreehand,createCanvasNode,deleteCanvasSelection,duplicateCanvasNodes,fitCanvas,maxCanvasBytes,maxCanvasStrokePoints,moveCanvasNodes,movingCanvasIds,parseCanvas,serializeCanvas,zoomCanvas} from "./canvas-document";
const text=(id="a",x=0,y=0)=>({id,type:"text" as const,x,y,width:200,height:100,text:"原文"});
const source=(nodes:unknown[],edges:unknown[]=[])=>JSON.stringify({nodes,edges});
it("解析与修改保留根、节点及连接未知字段，读取不生成 ID",()=>{
 const raw={nodes:[{...text(),future:{x:1}},{...text("b",300),color:"5"}],edges:[{id:"edge",fromNode:"a",toNode:"b",fromEnd:"arrow",toEnd:"none",future:[1,2]}],custom:{hello:"世界"}};
 const data=parseCanvas(JSON.stringify(raw));expect(data).toEqual(raw);
 expect(JSON.parse(serializeCanvas({...data,nodes:data.nodes.map(n=>({...n,text:"修改"}))}))).toMatchObject({custom:raw.custom,nodes:[{future:{x:1}},{}],edges:raw.edges});
 expect(parseCanvas("{}")).toEqual({nodes:[],edges:[]});
});
it.each(["", "null","[]",'{"nodes":null}','{"edges":{}}','{"nodes":[{"type":"sticky"}]}'])("非法或不支持的文档明确报错而非变空：%s",input=>{
 expect(()=>parseCanvas(input)).toThrow();
});
it("验证稳定 ID、整数尺寸、颜色、端点和 Noteriv 非标准文件字段",()=>{
 const a=text();
 expect(()=>parseCanvas(source([a,a]))).toThrow("ID");
 expect(()=>parseCanvas(source([{...a,width:0}]))).toThrow("尺寸");
 expect(()=>parseCanvas(source([{...a,x:1.2}]))).toThrow("整数");
 expect(()=>parseCanvas(source([{...a,color:"url(https://bad)"}]))).toThrow("颜色");
 expect(()=>parseCanvas(source([a],[{id:"edge",fromNode:"a",toNode:"missing"}]))).toThrow("不存在");
 expect(()=>parseCanvas(source([{...a,type:"file",filePath:"C:/a.md"}]))).toThrow("file");
 expect(()=>parseCanvas(source([{...a,type:"group",background:"a.png"}]))).toThrow("背景");
});
it("未知字段也不能被数值溢出或过深 JSON 静默改写",()=>{
 expect(()=>parseCanvas('{"nodes":[],"custom":1e999}')).toThrow("数值");
 expect(()=>parseCanvas('{"nodes":[],"custom":9007199254740993}')).toThrow("数值");
 let deep:unknown="end";for(let i=0;i<110;i++)deep={nested:deep};
 expect(()=>parseCanvas(JSON.stringify({nodes:[],custom:deep}))).toThrow("100");
});
it("文件路径以根相对原始文字保存，保留百分号和井号，拒绝隐藏及绝对路径",()=>{
 for(const p of ["目录/100%20 # (图).png","a.md"])expect(canvasFilePath(p)).toBe(true);
 for(const p of ["/a.md","C:/a.md","../a.md","a/../b.md",".noto-trash/a.md","a//b","https://x"])expect(canvasFilePath(p)).toBe(false);
});
it("按 UTF-8 字节和集合数量限制容量，不返回部分数据",()=>{
 expect(()=>parseCanvas('"'+ "中".repeat(Math.ceil(maxCanvasBytes/3))+'"')).toThrow("4 MiB");
 expect(()=>parseCanvas(source(Array.from({length:1001},(_,i)=>text(String(i)))))).toThrow("1000");
});
it("画布笔迹以文本节点和有界数据往返，移动/缩放不丢失点与未知字段",()=>{
 const node=createCanvasFreehand([{x:-50,y:20},{x:180,y:120}],"#123456",4),stroke=canvasFreehand(node)!;
 expect(node.type).toBe("text");expect(node.text).toBe(canvasFreehandFallback);expect(stroke.points).toHaveLength(2);
 const raw={nodes:[{...node,extra:{keep:true},notoDrawing:{...stroke,future:"保留"}}],edges:[]};
 const parsed=parseCanvas(serializeCanvas(raw));expect(parsed).toEqual(raw);
 const moved=moveCanvasNodes(parsed,new Set([node.id]),20,30).nodes[0];
 expect(moved.x).toBe(node.x+20);expect(canvasFreehand({...moved,width:moved.width*2})?.points).toEqual(stroke.points);
 expect(canvasFreehand(duplicateCanvasNodes(parsed,new Set([node.id])).data.nodes[1])).toEqual(raw.nodes[0].notoDrawing);
 const dot=createCanvasFreehand([{x:3,y:5}],"#123456",2);expect(canvasFreehand(dot)?.points).toHaveLength(1);
});
it("损坏或未知版本的画布笔迹拒绝编辑；无关的未知字段仍保留",()=>{
 const node=createCanvasFreehand([{x:0,y:0},{x:20,y:10}],"#123456",2),drawing=canvasFreehand(node)!;
 for(const bad of [{...drawing,version:2},{...drawing,strokeColor:"red"},{...drawing,strokeWidth:20},{...drawing,points:[[1.1,0]]},{...drawing,points:[]},{...drawing,points:Array.from({length:maxCanvasStrokePoints+1},()=>[0,0])}])expect(()=>parseCanvas(source([{...node,notoDrawing:bad}]))).toThrow(/笔迹|单笔/);
 const unknown={...text(),notoDrawing:{format:"other-extension",value:"保留"}};expect(parseCanvas(source([unknown])).nodes[0]).toEqual(unknown);
});
it("画布笔迹总点数达到上限可读取，超限拒绝而非截断",()=>{
 const node=createCanvasFreehand([{x:0,y:0}],"#123456",2),drawing=canvasFreehand(node)!;
 const nodes=Array.from({length:21},(_,i)=>({...node,id:"stroke-"+i,notoDrawing:{...drawing,points:Array.from({length:10000},()=>[.5,.5])}}));
 expect(parseCanvas(source(nodes.slice(0,20))).nodes).toHaveLength(20);
 expect(()=>parseCanvas(source(nodes))).toThrow(/200000/);
});
it("几何变换、缩放锚点与适应视图有确定结果",()=>{
 const view={x:25,y:50,zoom:2},p={x:200,y:300};
 expect(canvasWorld(p,view)).toEqual({x:87.5,y:125});
 const zoom=zoomCanvas(view,p,3);expect(canvasWorld(p,zoom)).toEqual(canvasWorld(p,view));
 expect(zoomCanvas(view,p,99).zoom).toBe(3);
 const fit=fitCanvas([text()],800,600);expect(fit.zoom).toBeGreaterThan(0);expect(fit.x).toBeGreaterThan(0);
});
it("分组带动完全包含的节点且去重；复制保留内部连接，删除不删除组内文件卡片",()=>{
 const group={id:"g",type:"group" as const,x:-10,y:-10,width:250,height:150,label:"分组"};
 const data={nodes:[group,text(),text("b",500)],edges:[{id:"e",fromNode:"a",toNode:"b"}]};
 const ids=movingCanvasIds(data,["g","a"]);expect([...ids]).toEqual(["g","a"]);
 expect(moveCanvasNodes(data,ids,20,30).nodes[1]).toMatchObject({x:20,y:30});
 const copy=duplicateCanvasNodes(data,new Set(["a","b"]));expect(copy.data.edges).toHaveLength(2);
 expect(new Set(copy.data.nodes.map(n=>n.id)).size).toBe(5);
 expect(deleteCanvasSelection(data,new Set(["g"])).nodes.map(n=>n.id)).toEqual(["a","b"]);
 expect(deleteCanvasSelection(data,new Set(["a"])).edges).toEqual([]);
});
it("历史合并连续文字、清除重做并限制步数；不在旧修订上撤销",()=>{
 const h=new CanvasHistory();h.record("a","b","text:1");h.record("b","c","text:1");
 expect(h.past).toHaveLength(1);expect(h.undo("外部版本")).toBeNull();
 expect(h.undo("c")).toBe("a");expect(h.redo("a")).toBe("c");
 h.undo("c");h.record("a","d");expect(h.future).toEqual([]);
 let from="d";for(let i=0;i<60;i++){const to="x"+i;h.record(from,to);from=to;}expect(h.past).toHaveLength(50);
 h.clear();expect(h.past).toEqual([]);
});
it.each([100,500])("%s 节点和复用图片/连接的模型不截断数据，序列化/解析往返稳定",count=>{
 const nodes=Array.from({length:count},(_,i)=>createCanvasNode(i%10===0?"file":"text",{x:(i%25)*300,y:Math.floor(i/25)*200},i%10===0?{file:"附件/图-"+(Math.floor(i/10)%5)+".png"}:{text:"知识卡片 "+i}));
 const data={nodes,edges:Array.from({length:count*2},(_,i)=>({id:"edge"+i,fromNode:nodes[i%count].id,toNode:nodes[(i+1)%count].id}))};
 const begin=performance.now(),json=serializeCanvas(data),parsed=parseCanvas(json);
 expect(parsed).toEqual(data);console.info("stage45-scale",JSON.stringify({nodes:count,edges:count*2,imageNodes:count/10,uniqueImages:5,bytes:new TextEncoder().encode(json).byteLength,elapsedMs:Math.round(performance.now()-begin),rendering:"model only"}));
});
