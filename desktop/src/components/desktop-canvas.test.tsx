// @vitest-environment jsdom
import "../test/codemirror-dom";
import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {EditorView} from "@codemirror/view";
import {undo} from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import {MemoryVault} from "../test/memory-vault";
import {WorkspaceRuntimeContext} from "../lib/workspace-runtime";
import {WorkspaceError} from "../lib/api-error";
import type {WorkspaceApi} from "../lib/vault-api";
import {canvasFreehand,createCanvasFreehand,createCanvasNode,parseCanvas,serializeCanvas} from "../lib/canvas-document";
import {emptyWorkspace,workspaceStorageKey} from "../lib/workspace-state";
import {vaultDragType} from "../lib/document-kind";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
beforeEach(()=>{
 localStorage.clear();vi.clearAllMocks();
 vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal("DragEvent",class extends MouseEvent{dataTransfer:DataTransfer|null;constructor(type:string,init:DragEventInit={}){super(type,init);this.dataTransfer=init.dataTransfer??null;}});
 vi.stubGlobal("PointerEvent",class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const path="画布/a.canvas",note="笔记.md";
function fixture(content=serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{id:"text",text:"初始文字"})],edges:[],custom:{keep:1}}),kind:"web"|"desktop"="web"){
 const vault=new MemoryVault();vault.put(path,content);vault.put(note,"原笔记");vault.put("目标.md","# 目标");
 const api={...vault,status:async()=>({vault:"canvas-vault",id:"canvas-test",error:null}),read:vi.fn(vault.read),save:vi.fn(vault.save),writeDraft:vi.fn(vault.writeDraft),removeDraft:vi.fn(vault.removeDraft),chooseFile:vi.fn(),chooseDirectory:vi.fn(),selectVault:vi.fn(),createVault:vi.fn(),importAttachment:vi.fn(),importAttachmentData:vi.fn(async()=>"attachments/图.png"),image:vi.fn(async()=>"data:image/png;base64,AQID"),openItem:vi.fn(),openAttachment:vi.fn(),openExternal:vi.fn(),remove:vi.fn()} satisfies WorkspaceApi;
 const mount=()=>render(<WorkspaceRuntimeContext.Provider value={{kind,api}}><DesktopApp/></WorkspaceRuntimeContext.Provider>);
 return {vault,api,mount};
}
async function openCanvas(){
 fireEvent.click(await screen.findByRole("button",{name:"a.canvas"}));
 await screen.findByRole("tab",{name:/^a.canvas/,selected:true});
 return screen.findByRole("region",{name:"知识画布"});
}
async function editCanvas(text:string){
 const region=screen.getByRole("region",{name:"知识画布"});
 const body=region.querySelector<HTMLElement>('[data-canvas-node="text"] .canvas-node-body')!;
 fireEvent.doubleClick(body);const input=await screen.findByRole("textbox",{name:"画布文本"});
 fireEvent.change(input,{target:{value:text}});return input as HTMLTextAreaElement;
}
function drawStroke(region:HTMLElement,start:{x:number;y:number},end:{x:number;y:number},id=1){
 fireEvent.pointerDown(region,{pointerId:id,clientX:start.x,clientY:start.y,button:0});
 fireEvent.pointerMove(region,{pointerId:id,clientX:end.x,clientY:end.y,button:0});
 fireEvent.pointerUp(region,{pointerId:id,clientX:end.x,clientY:end.y,button:0});
}
it.each(["web","desktop"] as const)("%s 多选对齐与等间距分布分别作为一步保存和撤销",async(kind)=>{
 const nodes=[createCanvasNode("text",{x:0,y:0},{id:"a",width:100,height:80,text:"甲"}),createCanvasNode("text",{x:200,y:150},{id:"b",width:80,height:100,text:"乙"}),createCanvasNode("text",{x:500,y:300},{id:"c",width:60,height:60,text:"丙"})];
 const source=serializeCanvas({nodes,edges:[{id:"e",fromNode:"a",toNode:"b",extra:"保留"}],extra:{keep:true}}),{mount,vault,api}=fixture(source,kind);mount();const region=await openCanvas();
 fireEvent.keyDown(region,{key:"a",ctrlKey:true});expect(api.save).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText("画布对齐与分布"),{target:{value:"top"}});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes.map(n=>n.y)).toEqual([0,0,0]),{timeout:4000});
 expect(parseCanvas(vault.notes.get(path)!.content).edges[0].extra).toBe("保留");
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
 fireEvent.change(screen.getByLabelText("画布对齐与分布"),{target:{value:"distribute-x"}});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes.map(n=>n.x)).toEqual([0,260,500]),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布重做"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[1].x).toBe(260),{timeout:4000});
},20000);
it("拖动参考线只作临时预览，吸附与 Alt 暂停吸附均可撤销",async()=>{
 const nodes=[createCanvasNode("text",{x:0,y:0},{id:"a",width:100,height:100,text:"甲"}),createCanvasNode("text",{x:200,y:100},{id:"b",width:100,height:100,text:"乙"})];
 const source=serializeCanvas({nodes,edges:[]}),{mount,vault,api}=fixture(source);mount();const region=await openCanvas(),node=region.querySelector<HTMLElement>('[data-canvas-node="a"]')!,header=node.querySelector(".canvas-node-header")!;
 fireEvent.pointerDown(header,{pointerId:1,clientX:10,clientY:10,button:0});fireEvent.pointerMove(region,{pointerId:1,clientX:106,clientY:107});
 await waitFor(()=>expect(region.querySelectorAll(".canvas-guide")).toHaveLength(2));expect(node.style.left).toBe("100px");expect(node.style.top).toBe("100px");expect(api.save).not.toHaveBeenCalled();
 const other=region.querySelector<HTMLElement>('[data-canvas-node="b"]')!;fireEvent.pointerDown(other.querySelector(".canvas-node-header")!,{pointerId:9,clientX:210,clientY:110,button:0,shiftKey:true});fireEvent.pointerCancel(region,{pointerId:9});expect(other.classList.contains("selected")).toBe(false);
 fireEvent.pointerUp(region,{pointerId:1,clientX:106,clientY:107});await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[0]).toMatchObject({x:100,y:100}),{timeout:4000});expect(region.querySelectorAll(".canvas-guide")).toHaveLength(0);
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
 fireEvent.pointerDown(header,{pointerId:2,clientX:10,clientY:10,button:0});fireEvent.pointerMove(region,{pointerId:2,clientX:106,clientY:107,altKey:true});
 await waitFor(()=>expect(node.style.left).toBe("96px"));expect(node.style.top).toBe("97px");expect(region.querySelectorAll(".canvas-guide")).toHaveLength(0);
 fireEvent.pointerUp(region,{pointerId:2,clientX:106,clientY:107,altKey:true});await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[0]).toMatchObject({x:96,y:97}),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
 fireEvent.pointerDown(header,{pointerId:3,clientX:10,clientY:10,button:0});fireEvent.pointerMove(region,{pointerId:3,clientX:106,clientY:107});await waitFor(()=>expect(region.querySelectorAll(".canvas-guide")).toHaveLength(2));
 fireEvent.pointerCancel(region,{pointerId:3});expect(node.style.left).toBe("0px");expect(region.querySelectorAll(".canvas-guide")).toHaveLength(0);expect(vault.notes.get(path)!.content).toBe(source);
},18000);
it.each(["web","desktop"] as const)("%s 连接侧边和箭头方向调整保留边属性，支持撤销重做",async(kind)=>{
 const nodes=[createCanvasNode("text",{x:0,y:0},{id:"a",width:100,height:80,text:"甲"}),createCanvasNode("text",{x:300,y:0},{id:"b",width:100,height:80,text:"乙"})];
 const source=serializeCanvas({nodes,edges:[{id:"e",fromNode:"a",toNode:"b",fromSide:"right",toSide:"left",label:"关系",extra:{keep:true}}]}),{mount,vault}=fixture(source,kind);mount();const region=await openCanvas();
 fireEvent.click(region.querySelector(".canvas-edge-hit")!);expect(screen.getByLabelText("连接箭头方向")).toHaveProperty("value","end");
 fireEvent.change(screen.getByLabelText("连接箭头方向"),{target:{value:"both"}});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0]).toMatchObject({fromEnd:"arrow",toEnd:"arrow",label:"关系",extra:{keep:true}}),{timeout:4000});
 fireEvent.change(screen.getByLabelText("连接起点位置"),{target:{value:"top"}});await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0].fromSide).toBe("top"),{timeout:4000});
 fireEvent.keyDown(screen.getByRole("button",{name:"调整连接终点"}),{key:"ArrowDown"});await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0].toSide).toBe("bottom"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0].toSide).toBe("left"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0].fromSide).toBe("right"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布重做"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0].fromEnd).toBe("arrow"),{timeout:4000});
},20000);
it("拖动连接端点可重接其他节点，取消或放到空白不写入",async()=>{
 const nodes=[createCanvasNode("text",{x:0,y:0},{id:"a",width:100,height:80,text:"甲"}),createCanvasNode("text",{x:300,y:0},{id:"b",width:100,height:80,text:"乙"}),createCanvasNode("text",{x:600,y:120},{id:"c",width:100,height:80,text:"丙"})];
 const source=serializeCanvas({nodes,edges:[{id:"e",fromNode:"a",toNode:"b",fromSide:"right",toSide:"left",label:"保留",extra:1}]}),{mount,vault,api}=fixture(source);mount();const region=await openCanvas();fireEvent.click(region.querySelector(".canvas-edge-hit")!);
 const endpoint=screen.getByRole("button",{name:"调整连接终点"});fireEvent.pointerDown(endpoint,{pointerId:1,clientX:300,clientY:40,button:0});fireEvent.pointerMove(region,{pointerId:1,clientX:650,clientY:120});
 await waitFor(()=>expect(region.querySelector("line[stroke-dasharray]")).toBeTruthy());expect(api.save).not.toHaveBeenCalled();fireEvent.pointerCancel(region,{pointerId:1});expect(vault.notes.get(path)!.content).toBe(source);
 fireEvent.pointerDown(endpoint,{pointerId:2,clientX:300,clientY:40,button:0});fireEvent.pointerMove(region,{pointerId:2,clientX:650,clientY:120});await openMarkdown();fireEvent.pointerUp(region,{pointerId:2,clientX:650,clientY:120});
 fireEvent.click(screen.getByRole("tab",{name:/^a.canvas/}));expect(vault.notes.get(path)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();
 const originalHitTest=Object.getOwnPropertyDescriptor(document,"elementFromPoint");
 try{
  Object.defineProperty(document,"elementFromPoint",{configurable:true,value:()=>screen.getByRole("button",{name:"图片"})});
  fireEvent.pointerDown(screen.getByRole("button",{name:"调整连接终点"}),{pointerId:3,clientX:300,clientY:40,button:0});fireEvent.pointerUp(region,{pointerId:3,clientX:650,clientY:120});
  expect(vault.notes.get(path)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();
 }finally{if(originalHitTest)Object.defineProperty(document,"elementFromPoint",originalHitTest);else Reflect.deleteProperty(document,"elementFromPoint");}
 fireEvent.pointerDown(screen.getByRole("button",{name:"调整连接终点"}),{pointerId:4,clientX:300,clientY:40,button:0});fireEvent.pointerUp(region,{pointerId:4,clientX:750,clientY:500});expect(vault.notes.get(path)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();expect(screen.getByText(/请将连接端点拖到其他节点边缘/)).toBeTruthy();
 fireEvent.pointerDown(screen.getByRole("button",{name:"调整连接终点"}),{pointerId:5,clientX:300,clientY:40,button:0});fireEvent.pointerUp(region,{pointerId:5,clientX:650,clientY:120});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0]).toMatchObject({toNode:"c",toSide:"top",label:"保留",extra:1}),{timeout:4000});expect(screen.queryByText(/请将连接端点拖到其他节点边缘/)).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布重做"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0].toNode).toBe("c"),{timeout:4000});
},15000);
it("排版和连线调整在慢保存及断网失败后保留最新草稿与撤销",async()=>{
 const nodes=[createCanvasNode("text",{x:0,y:0},{id:"a",width:100,height:80,text:"甲"}),createCanvasNode("text",{x:300,y:150},{id:"b",width:100,height:80,text:"乙"})];
 const source=serializeCanvas({nodes,edges:[{id:"e",fromNode:"a",toNode:"b"}]}),{mount,vault,api}=fixture(source);let finish!:()=>void;
 api.save.mockImplementationOnce((file,content,version)=>new Promise(resolve=>{finish=()=>{void vault.save(file,content,version).then(resolve);};}));
 mount();const region=await openCanvas();fireEvent.keyDown(region,{key:"a",ctrlKey:true});fireEvent.change(screen.getByLabelText("画布对齐与分布"),{target:{value:"top"}});
 await waitFor(()=>expect(finish).toBeTypeOf("function"),{timeout:4000});fireEvent.click(region.querySelector(".canvas-edge-hit")!);fireEvent.change(screen.getByLabelText("连接箭头方向"),{target:{value:"both"}});
 api.save.mockRejectedValueOnce(new WorkspaceError("network","排版断网"));await act(async()=>finish());await screen.findAllByText(/排版断网/,{}, {timeout:4000});
 await waitFor(()=>{const draft=parseCanvas(vault.stored.get(path)!.content);expect(draft.nodes[1].y).toBe(0);expect(draft.edges[0].fromEnd).toBe("arrow");},{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0].fromEnd).toBe("arrow"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).edges[0].fromEnd).toBeUndefined(),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
},20000);
it("画布节点预警随编辑和撤销更新，断网时不掩盖错误或草稿",async()=>{
 const nodes=Array.from({length:799},(_,i)=>createCanvasNode("text",{x:10000+(i%25)*300,y:10000+Math.floor(i/25)*200},{id:"node-"+i,text:"保留"}));
 const source=serializeCanvas({nodes,edges:[]}),{mount,vault,api}=fixture(source);mount();await openCanvas();
 expect(screen.queryByText(/画布节点接近上限/)).toBeNull();expect(api.save).not.toHaveBeenCalled();
 api.save.mockRejectedValueOnce(new WorkspaceError("network","容量测试断网"));fireEvent.click(screen.getByRole("button",{name:"便签"}));
 expect(screen.getByText(/画布节点接近上限：800\/1000/)).toBeTruthy();await screen.findAllByText(/容量测试断网/,{}, {timeout:4000});
 await waitFor(()=>expect(parseCanvas(vault.stored.get(path)!.content).nodes).toHaveLength(800),{timeout:4000});expect(vault.notes.get(path)!.content).toBe(source);
 fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(800),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});expect(screen.queryByText(/画布节点接近上限/)).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"画布重做"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(800),{timeout:4000});expect(screen.getByText(/画布节点接近上限：800\/1000/)).toBeTruthy();
},20000);
it("大画布文件提前提示 UTF-8 大小，提醒不会触发保存或影响撤销",async()=>{
 const node=createCanvasNode("text",{x:0,y:0},{id:"text",text:"初始文字"}),source=serializeCanvas({nodes:[node],edges:[],extra:"中".repeat(1_120_000)});
 const {mount,vault,api}=fixture(source);mount();await openCanvas();
 expect(screen.getByText(/画布文件接近大小上限/).textContent).toContain("4 MiB");expect(api.save).not.toHaveBeenCalled();expect(api.writeDraft).not.toHaveBeenCalled();
 await editCanvas("提醒下继续输入");await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[0].text).toBe("提醒下继续输入"),{timeout:8000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:8000});expect(screen.getByText(/画布文件接近大小上限/)).toBeTruthy();
},25000);
it("画布撤销历史预警随撤销重做变化，并提示已经移除的较早记录",async()=>{
 const {mount}=fixture(undefined,"desktop");mount();await openCanvas();const add=screen.getByRole("button",{name:"便签"});
 act(()=>{for(let i=0;i<39;i++)fireEvent.click(add);});expect(screen.queryByText(/撤销历史：/)).toBeNull();
 fireEvent.click(add);expect(screen.getByText(/撤销历史：40\/50 步/).textContent).toContain("继续编辑可能移除较早记录");
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));expect(screen.queryByText(/撤销历史：/)).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"画布重做"}));expect(screen.getByText(/撤销历史：40\/50 步/)).toBeTruthy();
 act(()=>{for(let i=0;i<11;i++)fireEvent.click(add);});expect(screen.getByText(/撤销历史：50\/50 步/).textContent).toContain("较早的撤销记录已因上限移除");
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));expect(screen.getByText(/撤销历史：49\/50 步/).textContent).toContain("较早的撤销记录已因上限移除");
},20000);
it("画布橡皮尺寸只写本机视图，缩放后命中范围仍与光标一致",async()=>{
 const stroke=createCanvasFreehand([{x:20,y:20},{x:180,y:20}],"#123456",2,"pen"),source=serializeCanvas({nodes:[stroke],edges:[]});
 const {mount,vault,api}=fixture(source),key=workspaceStorageKey("web","canvas-test");
 localStorage.setItem(key,JSON.stringify({...emptyWorkspace(),tabs:[path],active:path,canvases:{[path]:{viewport:{x:0,y:0,zoom:2},selected:[],eraserSize:10}}}));
 mount();const region=await screen.findByRole("region",{name:"知识画布"});fireEvent.keyDown(region,{key:"e"});
 expect(screen.getByLabelText("画布橡皮尺寸")).toHaveProperty("value","10");fireEvent.change(screen.getByLabelText("画布橡皮尺寸"),{target:{value:"40"}});fireEvent.pointerMove(region,{pointerId:1,clientX:200,clientY:40});
 expect(region.querySelector<HTMLElement>(".canvas-eraser-cursor")!.style.width).toBe("40px");expect(api.save).not.toHaveBeenCalled();
 await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).canvases[path].eraserSize).toBe(40),{timeout:4000});
 drawStroke(region,{x:200,y:40},{x:200,y:40});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(2),{timeout:4000});
 const [left,right]=parseCanvas(vault.notes.get(path)!.content).nodes,a=canvasFreehand(left)!,b=canvasFreehand(right)!;
 expect(left.x+a.points.at(-1)![0]*left.width).toBeCloseTo(89,1);expect(right.x+b.points[0][0]*right.width).toBeCloseTo(111,1);
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
},12000);
it.each(["web","desktop"] as const)("%s 画布橡皮局部擦除笔迹并可撤销重做，卡片和连接保留",async(kind)=>{
 const stroke=createCanvasFreehand([{x:20,y:20},{x:180,y:20}],"#123456",2,"pen"),card=createCanvasNode("text",{x:0,y:0},{id:"card",text:"保留的卡片"});
 const source=serializeCanvas({nodes:[stroke,card],edges:[{id:"edge",fromNode:"pen",toNode:"card"}]});
 const {mount,vault,api}=fixture(source,kind);mount();const region=await openCanvas();
 fireEvent.keyDown(region,{key:"e"});expect(screen.getByRole("button",{name:"画布橡皮工具"}).getAttribute("aria-pressed")).toBe("true");
 fireEvent.pointerMove(region,{pointerId:1,clientX:100,clientY:0});const cursor=region.querySelector<HTMLElement>(".canvas-eraser-cursor")!;
 expect(cursor.style.visibility).toBe("visible");expect(cursor.style.left).toBe("100px");expect(screen.getByText(/橡皮局部擦除笔迹/)).toBeTruthy();
 fireEvent.pointerDown(region,{pointerId:1,clientX:100,clientY:0,button:0});fireEvent.pointerMove(region,{pointerId:1,clientX:100,clientY:40});
 expect(api.save).not.toHaveBeenCalled();fireEvent.pointerUp(region,{pointerId:1,clientX:100,clientY:40});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(3),{timeout:4000});
 const result=parseCanvas(vault.notes.get(path)!.content);expect(result.nodes[0].id).toBe("pen");expect(result.nodes[2]).toEqual(card);expect(result.edges).toEqual([{id:"edge",fromNode:"pen",toNode:"card"}]);
 expect(result.nodes.slice(0,2).every(n=>canvasFreehand(n)?.strokeColor==="#123456")).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布重做"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(3),{timeout:4000});
 fireEvent.pointerLeave(region);expect(cursor.style.visibility).toBe("hidden");
},15000);
it("画布橡皮取消或切换标签不提交预览，其他指针不打断擦除",async()=>{
 const stroke=createCanvasFreehand([{x:20,y:20},{x:180,y:20}],"#123456",2,"pen"),source=serializeCanvas({nodes:[stroke],edges:[]});
 const {mount,vault,api}=fixture(source);mount();const region=await openCanvas();fireEvent.click(screen.getByRole("button",{name:"画布橡皮工具"}));
 fireEvent.pointerDown(region,{pointerId:1,clientX:100,clientY:20,button:0});expect(region.querySelectorAll(".canvas-freehand-svg")).toHaveLength(2);
 fireEvent.pointerCancel(region,{pointerId:1});expect(region.querySelectorAll(".canvas-freehand-svg")).toHaveLength(1);expect(api.save).not.toHaveBeenCalled();
 fireEvent.pointerDown(region,{pointerId:2,clientX:100,clientY:20,button:0});await openMarkdown();fireEvent.pointerUp(region,{pointerId:2,clientX:100,clientY:20});
 expect(vault.notes.get(path)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("tab",{name:/^a.canvas/}));fireEvent.pointerDown(region,{pointerId:3,clientX:100,clientY:0,button:0});
 fireEvent.pointerDown(region,{pointerId:4,clientX:400,clientY:400,button:0});fireEvent.pointerCancel(region,{pointerId:4});
 fireEvent.pointerMove(region,{pointerId:3,clientX:100,clientY:40});fireEvent.pointerUp(region,{pointerId:3,clientX:100,clientY:40});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(2),{timeout:4000});
},12000);
it("画布橡皮慢保存与断网失败时保留最新笔迹和草稿",async()=>{
 const stroke=createCanvasFreehand([{x:20,y:20},{x:180,y:20}],"#123456",2,"pen"),source=serializeCanvas({nodes:[stroke],edges:[]});
 const {mount,vault,api}=fixture(source);let finish!:()=>void;
 api.save.mockImplementationOnce((file,content,version)=>new Promise(resolve=>{finish=()=>{void vault.save(file,content,version).then(resolve);};}));
 mount();const region=await openCanvas();fireEvent.click(screen.getByRole("button",{name:"画布橡皮工具"}));drawStroke(region,{x:100,y:0},{x:100,y:40});
 await waitFor(()=>expect(finish).toBeTypeOf("function"),{timeout:4000});fireEvent.click(screen.getByRole("button",{name:"画布画笔工具"}));drawStroke(region,{x:10,y:100},{x:70,y:100},2);
 api.save.mockRejectedValueOnce(new WorkspaceError("network","擦除断网"));await act(async()=>finish());
 await screen.findByText(/保存失败：擦除断网/,{}, {timeout:4000});
 await waitFor(()=>expect(parseCanvas(vault.stored.get(path)!.content).nodes).toHaveLength(3));
 fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(3),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(2),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
},18000);
it("快速折线擦除保留中间轨迹，不遗漏转折处的笔迹",async()=>{
 const a=createCanvasFreehand([{x:0,y:30},{x:20,y:30}],"#123456",2,"a"),b=createCanvasFreehand([{x:120,y:90},{x:160,y:90}],"#123456",2,"b");
 const {mount,vault}=fixture(serializeCanvas({nodes:[a,b],edges:[]}));mount();const region=await openCanvas();fireEvent.click(screen.getByRole("button",{name:"画布橡皮工具"}));
 fireEvent.pointerDown(region,{pointerId:1,clientX:20,clientY:0,button:0});fireEvent.pointerMove(region,{pointerId:1,clientX:20,clientY:60});
 fireEvent.pointerMove(region,{pointerId:1,clientX:120,clientY:60});fireEvent.pointerUp(region,{pointerId:1,clientX:120,clientY:120});
 await waitFor(()=>{const nodes=parseCanvas(vault.notes.get(path)!.content).nodes;expect(nodes).toHaveLength(2);expect(nodes[0].width).toBeLessThan(a.width);expect(nodes[1].width).toBeLessThan(b.width);},{timeout:4000});
},10000);
it("画布接近节点上限时，橡皮拆分超限会保留原文件",async()=>{
 const stroke=createCanvasFreehand([{x:20,y:20},{x:180,y:20}],"#123456",2,"pen");
 const cards=Array.from({length:999},(_,i)=>createCanvasNode("text",{x:10000+(i%25)*300,y:10000+Math.floor(i/25)*200},{id:"card-"+i,text:"保留"}));
 const source=serializeCanvas({nodes:[stroke,...cards],edges:[]}),{mount,vault,api}=fixture(source);mount();const region=await openCanvas();
 fireEvent.click(screen.getByRole("button",{name:"画布橡皮工具"}));drawStroke(region,{x:100,y:0},{x:100,y:40});
 await waitFor(()=>expect(screen.getAllByText(/画布超过 1000 节点/).length).toBeGreaterThan(0),{timeout:4000});
 expect(vault.notes.get(path)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();expect(region.querySelectorAll(".canvas-freehand-svg")).toHaveLength(1);
},12000);
it.each(["web","desktop"] as const)("%s 画布自由绘图可保存、选择、改色、撤销与重做",async(kind)=>{
 const {mount,vault,api}=fixture(undefined,kind);mount();const region=await openCanvas();
 fireEvent.click(screen.getByRole("button",{name:"画布画笔工具"}));
 fireEvent.click(screen.getByRole("button",{name:"画布笔色 #65a77c"}));expect(screen.getByLabelText("画布画笔颜色")).toHaveProperty("value","#65a77c");
 fireEvent.change(screen.getByLabelText("画布画笔颜色"),{target:{value:"#123456"}});fireEvent.change(screen.getByLabelText("画布画笔宽度"),{target:{value:"6"}});
 fireEvent.pointerDown(region,{pointerId:1,clientX:50,clientY:250,button:0});
 fireEvent.pointerMove(region,{pointerId:1,clientX:250,clientY:300,button:0});
 expect(api.save).not.toHaveBeenCalled();expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(1);
 fireEvent.pointerUp(region,{pointerId:1,clientX:250,clientY:300,button:0});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(2),{timeout:4000});
 let doc=parseCanvas(vault.notes.get(path)!.content),stroke=canvasFreehand(doc.nodes[1])!;
 expect(stroke.points.length).toBeGreaterThanOrEqual(2);expect(stroke.strokeColor).toBe("#123456");expect(stroke.strokeWidth).toBe(6);
 expect(region.querySelector(".canvas-freehand-svg polyline")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"画布选择工具"}));
 fireEvent.keyDown(screen.getByRole("button",{name:"选择画布笔迹"}),{key:" "});
 fireEvent.change(screen.getByLabelText("画布颜色"),{target:{value:"1"}});
 await waitFor(()=>expect(canvasFreehand(parseCanvas(vault.notes.get(path)!.content).nodes[1])?.strokeColor).toBe("#e86b76"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(canvasFreehand(parseCanvas(vault.notes.get(path)!.content).nodes[1])?.strokeColor).toBe("#123456"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(1),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布重做"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(2),{timeout:4000});
 doc=parseCanvas(vault.notes.get(path)!.content);stroke=canvasFreehand(doc.nodes[1])!;expect(stroke.strokeColor).toBe("#123456");
},18000);
it("画布笔迹取消、切换标签或失效指针都不会提交临时数据",async()=>{
 const {mount,vault,api}=fixture();mount();const region=await openCanvas(),source=vault.notes.get(path)!.content;
 fireEvent.click(screen.getByRole("button",{name:"画布画笔工具"}));
 fireEvent.pointerDown(region,{pointerId:1,clientX:20,clientY:240,button:0});fireEvent.pointerMove(region,{pointerId:1,clientX:180,clientY:280});fireEvent.pointerCancel(region,{pointerId:1});
 expect(vault.notes.get(path)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();
 fireEvent.pointerDown(region,{pointerId:2,clientX:20,clientY:240,button:0});fireEvent.pointerMove(region,{pointerId:2,clientX:180,clientY:280});await openMarkdown();
 fireEvent.pointerUp(region,{pointerId:2,clientX:180,clientY:280});expect(vault.notes.get(path)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();
},10000);
it("画布画笔支持快捷键和单点笔迹",async()=>{
 const {mount,vault}=fixture();mount();const region=await openCanvas();
 fireEvent.keyDown(region,{key:"d"});expect(screen.getByRole("button",{name:"画布画笔工具"}).getAttribute("aria-pressed")).toBe("true");
 drawStroke(region,{x:400,y:400},{x:400,y:400});
 await waitFor(()=>expect(canvasFreehand(parseCanvas(vault.notes.get(path)!.content).nodes[1])?.points).toHaveLength(1),{timeout:4000});
 expect(region.querySelector(".canvas-freehand-svg circle")).toBeTruthy();
 fireEvent.keyDown(region,{key:"v"});expect(screen.getByRole("button",{name:"画布选择工具"}).getAttribute("aria-pressed")).toBe("true");
},10000);
it("其他指针的按下和取消不会覆盖正在绘制的笔迹",async()=>{
 const {mount,vault}=fixture();mount();const region=await openCanvas();fireEvent.click(screen.getByRole("button",{name:"画布画笔工具"}));
 fireEvent.pointerDown(region,{pointerId:1,clientX:20,clientY:230,button:0});fireEvent.pointerMove(region,{pointerId:1,clientX:80,clientY:240});
 fireEvent.pointerDown(region,{pointerId:2,clientX:400,clientY:400,button:0});fireEvent.pointerCancel(region,{pointerId:2});
 fireEvent.pointerUp(region,{pointerId:1,clientX:120,clientY:250});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes.filter(n=>canvasFreehand(n))).toHaveLength(1),{timeout:4000});
 const node=parseCanvas(vault.notes.get(path)!.content).nodes[1];expect(node.x).toBeLessThan(20);expect(node.x+node.width).toBeLessThan(200);
},10000);
it("画布笔迹慢保存期间继续绘制，确认旧快照后保存最新两笔",async()=>{
 const {mount,vault,api}=fixture();let finish!:()=>void;
 api.save.mockImplementationOnce((file,content,version)=>new Promise(resolve=>{finish=()=>{void vault.save(file,content,version).then(resolve);};}));
 mount();const region=await openCanvas();fireEvent.click(screen.getByRole("button",{name:"画布画笔工具"}));
 drawStroke(region,{x:20,y:230},{x:120,y:250});await waitFor(()=>expect(finish).toBeTypeOf("function"),{timeout:4000});
 drawStroke(region,{x:30,y:300},{x:130,y:330},2);await act(async()=>finish());
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes.filter(n=>canvasFreehand(n))).toHaveLength(2),{timeout:5000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes.filter(n=>canvasFreehand(n))).toHaveLength(1),{timeout:4000});
},15000);
it("画布笔迹保存失败时保留草稿并允许重试",async()=>{
 const {mount,vault,api}=fixture();api.save.mockRejectedValueOnce(new WorkspaceError("network","笔迹断网"));mount();const region=await openCanvas();
 fireEvent.click(screen.getByRole("button",{name:"画布画笔工具"}));drawStroke(region,{x:10,y:230},{x:80,y:250});
 await screen.findByText(/保存失败：笔迹断网/,{}, {timeout:4000});
 await waitFor(()=>expect(parseCanvas(vault.stored.get(path)!.content).nodes.filter(n=>canvasFreehand(n))).toHaveLength(1));
 fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes.filter(n=>canvasFreehand(n))).toHaveLength(1),{timeout:4000});
},10000);
it("已保存的画布笔迹可直接拖动，点状笔迹可显示；空格平移不写文件",async()=>{
 const pen=createCanvasFreehand([{x:20,y:220},{x:120,y:240}],"#123456",3),dot=createCanvasFreehand([{x:160,y:220}],"#123456",3);
 const content=serializeCanvas({nodes:[pen,dot],edges:[]}),{mount,vault,api}=fixture(content);mount();const region=await openCanvas();
 expect(region.querySelector('[data-canvas-node="'+dot.id+'"] .canvas-freehand-svg circle')).toBeTruthy();
 const hit=region.querySelector('[data-canvas-node="'+pen.id+'"] .canvas-freehand-hit')!;
 fireEvent.pointerDown(hit,{pointerId:1,clientX:50,clientY:226,button:0});fireEvent.pointerMove(region,{pointerId:1,clientX:90,clientY:256});fireEvent.pointerUp(region,{pointerId:1,clientX:90,clientY:256});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[0].x).toBe(pen.x+40),{timeout:4000});
 expect(canvasFreehand(parseCanvas(vault.notes.get(path)!.content).nodes[0])?.points).toEqual(canvasFreehand(pen)?.points);
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[0].x).toBe(pen.x),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布画笔工具"}));const saves=api.save.mock.calls.length,transform=region.querySelector<HTMLElement>(".canvas-transform")!.style.transform;
 fireEvent.keyDown(region,{key:" ",code:"Space"});drawStroke(region,{x:400,y:300},{x:440,y:330});fireEvent.keyUp(region,{key:" ",code:"Space"});
 expect(region.querySelector<HTMLElement>(".canvas-transform")!.style.transform).not.toBe(transform);expect(api.save).toHaveBeenCalledTimes(saves);
},12000);
it("未知画布笔迹版本只读并保留原文",async()=>{
 const node=createCanvasFreehand([{x:0,y:0}],"#123456",2),raw=JSON.stringify({nodes:[{...node,notoDrawing:{...canvasFreehand(node),version:2}}],edges:[]});
 const {mount,vault,api}=fixture(raw);mount();fireEvent.click(await screen.findByRole("button",{name:"a.canvas"}));
 expect(await screen.findByText(/不支持的画布笔迹类型或版本/)).toBeTruthy();expect(vault.notes.get(path)!.content).toBe(raw);expect(api.save).not.toHaveBeenCalled();
},10000);
it.each(["web","desktop"] as const)("%s 多选不同颜色显示混合，明确修改后才写入",async(kind)=>{
 const content=serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{id:"one",text:"一",color:"1"}),createCanvasNode("text",{x:300,y:0},{id:"two",text:"二",color:"2"})],edges:[]});
 const {mount,vault,api}=fixture(content,kind);mount();const region=await openCanvas();
 fireEvent.keyDown(region,{key:"a",ctrlKey:true});
 const color=screen.getByRole("combobox",{name:"画布颜色"}) as HTMLSelectElement;
 expect(color.value).toBe("__mixed__");expect(within(color).getByText("混合颜色")).toBeTruthy();
 expect(vault.notes.get(path)!.content).toBe(content);expect(api.save).not.toHaveBeenCalled();
 fireEvent.change(color,{target:{value:"4"}});
 fireEvent.click(screen.getByRole("button",{name:"保存"}));
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes.map(n=>n.color)).toEqual(["4","4"]),{timeout:4000});
});
async function openMarkdown(){
 fireEvent.click(await screen.findByRole("button",{name:note}));await screen.findByRole("tab",{name:/^笔记.md/,selected:true});
 return waitFor(()=>EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!);
}
it.each(["web","desktop"] as const)("%s 切主题保留画布编辑、视口、颜色和撤销",async(kind)=>{
 const {mount,vault}=fixture(undefined,kind);mount();await openCanvas();
 const input=await editCanvas("切换主题后的画布文字");input.setSelectionRange(2,4);
 fireEvent.click(screen.getByRole("button",{name:"放大画布"}));const zoom=screen.getByRole("button",{name:"画布恢复100%"}).textContent;
 fireEvent.click(screen.getByRole("button",{name:"软件设置"}));const dialog=screen.getByRole("dialog",{name:"软件设置"});
 fireEvent.click(within(dialog).getByRole("button",{name:"GitHub Dark"}));fireEvent.click(within(dialog).getByRole("button",{name:"完成"}));
 expect(screen.getByRole("textbox",{name:"画布文本"})).toBe(input);expect(input.value).toBe("切换主题后的画布文字");expect(input.selectionStart).toBe(2);
 expect(screen.getByRole("button",{name:"画布恢复100%"}).textContent).toBe(zoom);
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[0].text).toBe("切换主题后的画布文字"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));expect((screen.getByRole("textbox",{name:"画布文本"}) as HTMLTextAreaElement).value).toBe("初始文字");
},10000);
it("画布和真实 Markdown 混合多标签保留输入、光标/滚动、撤销与各自自动保存",async()=>{
 const {mount,api,vault}=fixture();mount();const editor=await openMarkdown();
 act(()=>editor.dispatch({changes:{from:0,insert:"待保存"},selection:{anchor:3},userEvent:"input.type"}));
 await openCanvas();
 expect(screen.queryByRole("group",{name:"编辑视图"})).toBeNull();
 expect(screen.queryByLabelText("笔记统计")).toBeNull();
 const input=await editCanvas("画布本地编辑");input.setSelectionRange(2,4);input.scrollTop=45;
 fireEvent.click(screen.getByRole("button",{name:"放大画布"}));
 const zoom=screen.getByRole("button",{name:"画布恢复100%"}).textContent;
 fireEvent.click(screen.getByRole("tab",{name:/^笔记.md/}));
 expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector(".cm-editor")!)).toBe(editor);
 expect(editor.state.doc.toString()).toBe("待保存原笔记");expect(editor.state.selection.main.head).toBe(3);
 fireEvent.click(screen.getByRole("tab",{name:/^a.canvas/}));
 expect(screen.getByRole("textbox",{name:"画布文本"})).toBe(input);expect(input.selectionStart).toBe(2);expect(input.scrollTop).toBe(45);
 expect(screen.getByRole("button",{name:"画布恢复100%"}).textContent).toBe(zoom);
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));
 expect((screen.getByRole("textbox",{name:"画布文本"}) as HTMLTextAreaElement).value).toBe("初始文字");
 fireEvent.click(screen.getByRole("button",{name:"画布重做"}));
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[0].text).toBe("画布本地编辑"),{timeout:4000});
 expect(vault.notes.get(note)?.content).toBe("待保存原笔记");
 expect(api.writeDraft).not.toHaveBeenCalledWith(expect.objectContaining({path:"@tasks"}));
 act(()=>{undo(editor);});expect(editor.state.doc.toString()).not.toBe("待保存原笔记");
},15000);
it("慢保存只确认旧快照，不重挂画布输入或覆盖后续内容",async()=>{
 const {mount,api,vault}=fixture();mount();await openCanvas();
 let finish!:()=>void;
 api.save.mockImplementationOnce((file,content,version)=>new Promise(resolve=>{finish=()=>{void vault.save(file,content,version).then(resolve);};}));
 const input=await editCanvas("第一版");
 await waitFor(()=>expect(finish).toBeTypeOf("function"),{timeout:4000});
 fireEvent.change(input,{target:{value:"第二版未保存"}});input.setSelectionRange(2,2);
 await act(async()=>finish());
 expect(screen.getByRole("textbox",{name:"画布文本"})).toBe(input);expect(input.value).toBe("第二版未保存");expect(input.selectionStart).toBe(2);
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[0].text).toBe("第二版未保存"),{timeout:4000});
 expect(parseCanvas(vault.notes.get(path)!.content).custom).toEqual({keep:1});
},15000);
it("拖动结束才提交一步，PointerCancel 与切标签不提交临时位置",async()=>{
 const {mount,api,vault}=fixture();mount();const region=await openCanvas();
 const node=region.querySelector<HTMLElement>('[data-canvas-node="text"]')!,header=node.querySelector(".canvas-node-header")!;
 fireEvent.pointerDown(header,{pointerId:1,clientX:10,clientY:10,button:0});
 fireEvent.pointerMove(region,{pointerId:1,clientX:90,clientY:60});
 fireEvent.pointerCancel(region,{pointerId:1});
 expect(node.style.left).toBe("0px");expect(parseCanvas(vault.notes.get(path)!.content).nodes[0].x).toBe(0);expect(api.save).not.toHaveBeenCalled();
 fireEvent.pointerDown(header,{pointerId:2,clientX:10,clientY:10,button:0});
 fireEvent.pointerMove(region,{pointerId:2,clientX:70,clientY:40});
 fireEvent.pointerUp(region,{pointerId:2,clientX:70,clientY:40});
 expect(node.style.left).toBe("60px");expect(node.style.top).toBe("30px");
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));expect(node.style.left).toBe("0px");
 fireEvent.pointerDown(header,{pointerId:3,clientX:10,clientY:10,button:0});
 fireEvent.pointerMove(region,{pointerId:3,clientX:200,clientY:200});
 await openMarkdown();
 fireEvent.click(screen.getByRole("tab",{name:/^a.canvas/}));expect(node.style.left).toBe("0px");
});
it.each(["web","desktop"] as const)("%s 卡片正文可拖动，便签保存为可撤销的文本节点",async(kind)=>{
 const {mount,vault}=fixture(undefined,kind);mount();const region=await openCanvas();
 const node=region.querySelector<HTMLElement>('[data-canvas-node="text"]')!,body=node.querySelector(".canvas-node-body")!;
 fireEvent.pointerDown(body,{pointerId:1,clientX:30,clientY:30,button:0});
 fireEvent.pointerMove(region,{pointerId:1,clientX:90,clientY:60});fireEvent.pointerUp(region,{pointerId:1,clientX:90,clientY:60});
 expect(node.style.left).toBe("60px");fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));expect(node.style.left).toBe("0px");
 fireEvent.click(screen.getByRole("button",{name:"便签"}));const input=await screen.findByRole("textbox",{name:"画布文本"});
 fireEvent.change(input,{target:{value:"便签内容"}});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(2),{timeout:4000});
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[1].text).toBe("便签内容"),{timeout:4000});
 const sticky=parseCanvas(vault.notes.get(path)!.content).nodes[1];expect(sticky.type).toBe("text");expect(sticky.notoCardStyle).toBe("sticky");expect(sticky.color).toBe("#f9e2af");
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));expect((screen.getByRole("textbox",{name:"画布文本"}) as HTMLTextAreaElement).value).toBe("");
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));expect(region.querySelectorAll(".canvas-node")).toHaveLength(1);
},12000);
it("卡片指针捕获后仍可双击编辑，链接不会触发卡片拖动",async()=>{
 const content=serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{id:"text",text:"[笔记](../笔记.md)"})],edges:[]});
 const {mount}=fixture(content);mount();const region=await openCanvas(),node=region.querySelector<HTMLElement>('[data-canvas-node="text"]')!;
 const capture=vi.fn();Object.defineProperty(node,"setPointerCapture",{value:capture,configurable:true});
 const body=node.querySelector(".canvas-node-body")!;
 fireEvent.pointerDown(body.querySelector("a")!,{pointerId:1,clientX:20,clientY:20,button:0});expect(capture).not.toHaveBeenCalled();
 fireEvent.pointerDown(body,{pointerId:1,clientX:20,clientY:20,button:0});fireEvent.pointerUp(node,{pointerId:1,clientX:20,clientY:20});
 fireEvent.pointerDown(body,{pointerId:1,clientX:20,clientY:20,button:0});fireEvent.pointerUp(node,{pointerId:1,clientX:20,clientY:20});
 expect(capture).toHaveBeenCalledTimes(2);fireEvent.doubleClick(node);expect(await screen.findByRole("textbox",{name:"画布文本"})).toBeTruthy();
},10000);
it("右键在点击位置新建，缩略图导航不写入画布",async()=>{
 const {mount,vault,api}=fixture();mount();const region=await openCanvas();
 fireEvent.contextMenu(region,{clientX:450,clientY:300});fireEvent.click(screen.getByRole("menuitem",{name:"新增文本"}));
 const input=await screen.findByRole("textbox",{name:"画布文本"});expect(input).toBeTruthy();
 const newNode=[...region.querySelectorAll<HTMLElement>(".canvas-node")].find(n=>n.dataset.canvasNode!=="text")!;
 expect(newNode.style.left).toBe("310px");expect(newNode.style.top).toBe("210px");
 fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(2),{timeout:4000});
 const saves=api.save.mock.calls.length,minimap=screen.getByRole("button",{name:"画布缩略图，点击定位"});
 vi.spyOn(minimap,"getBoundingClientRect").mockReturnValue({left:0,top:0,width:160,height:100,right:160,bottom:100,x:0,y:0,toJSON:()=>({})});
 const transform=region.querySelector<HTMLElement>(".canvas-transform")!.style.transform;
 fireEvent.click(minimap,{clientX:140,clientY:75});expect(region.querySelector<HTMLElement>(".canvas-transform")!.style.transform).not.toBe(transform);
 const afterClick=region.querySelector<HTMLElement>(".canvas-transform")!.style.transform;
 fireEvent.keyDown(minimap,{key:"ArrowLeft"});expect(region.querySelector<HTMLElement>(".canvas-transform")!.style.transform).not.toBe(afterClick);
 expect(api.save).toHaveBeenCalledTimes(saves);
},10000);
it("创建与恢复画布标签和视口；坏 JSON 只读且不进入 Markdown 或导出",async()=>{
 const {mount,api,vault}=fixture("{bad JSON");const key=workspaceStorageKey("web","canvas-test");
 localStorage.setItem(key,JSON.stringify({...emptyWorkspace(),tabs:[path],active:path,canvases:{[path]:{viewport:{x:35,y:40,zoom:1.8},selected:[]}}}));
 mount();await screen.findByRole("tab",{name:/^a.canvas/,selected:true});
 expect(await screen.findByText(/画布 JSON 无法解析/)).toBeTruthy();
 expect(screen.queryByRole("region",{name:"知识画布"})).toBeNull();
 expect(screen.queryByLabelText("编辑视图")).toBeNull();
 fireEvent.click(screen.getByLabelText("文档更多操作"));
 expect(screen.queryByRole("button",{name:"导出（HTML / PDF）"})).toBeNull();
 expect(api.save).not.toHaveBeenCalled();expect(vault.notes.get(path)?.content).toBe("{bad JSON");
});
it("未确认草稿不启用画布，确认后本地冲突分支保留，失败关闭不会删内容",async()=>{
 const {mount,api,vault}=fixture();const base=vault.notes.get(path)!;
 const draft=parseCanvas(base.content);draft.nodes[0].text="本地草稿";
 vault.stored.set(path,{path,content:serializeCanvas(draft),baseVersion:base.version});
 vault.put(path,serializeCanvas({...draft,custom:"外部版本"}));
 mount();fireEvent.click(await screen.findByRole("button",{name:"a.canvas"}));
 await screen.findByRole("button",{name:"恢复草稿"});
 expect((screen.getByRole("button",{name:"＋ 文本"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));await editCanvas("继续编辑冲突草稿");
 fireEvent.click(screen.getByRole("button",{name:"关闭标签 a.canvas"}));
 await screen.findByText(/无法关闭标签/);
 expect(screen.getByRole("tab",{name:/^a.canvas/})).toBeTruthy();
 expect(parseCanvas(vault.notes.get(path)!.content).custom).toBe("外部版本");
 expect(parseCanvas(vault.stored.get(path)!.content).nodes[0].text).toBe("继续编辑冲突草稿");
 expect(api.removeDraft).not.toHaveBeenCalledWith(path);
});
it("在途图片回到原画布并合并最新正文，不插入另一篇笔记",async()=>{
 const {mount,api,vault}=fixture();mount();const region=await openCanvas();
 let complete!:(path:string)=>void;
 api.importAttachmentData.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
 fireEvent.paste(region,{clipboardData:{files:[new File(["image"],"图.png",{type:"image/png"})]}});
 await waitFor(()=>expect(complete).toBeTypeOf("function"));
 await editCanvas("等待导入期间继续输入");const editor=await openMarkdown();
 await act(async()=>complete("attachments/图.png"));
 expect(editor.state.doc.toString()).toBe("原笔记");
 fireEvent.click(screen.getByRole("tab",{name:/^a.canvas/}));
 await waitFor(()=>expect(screen.getByRole("button",{name:"打开 画布/attachments/图.png"})).toBeTruthy());
 await waitFor(()=>expect(parseCanvas(vault.stored.get(path)!.content).nodes).toHaveLength(2));
 expect(parseCanvas(vault.stored.get(path)!.content).nodes[0].text).toBe("等待导入期间继续输入");
 expect(api.importAttachmentData).toHaveBeenCalledWith(path,"图.png",expect.any(Uint8Array));
});
it("文件树拖入复制引用并复用笔记标签，不移动源文件",async()=>{
 const {mount,vault}=fixture();mount();const editor=await openMarkdown();const region=await openCanvas();
 const tree=screen.getByRole("complementary",{name:"工作区侧栏"}),button=within(tree).getByRole("button",{name:note});
 const transfer={setData:vi.fn(),effectAllowed:"",types:[vaultDragType],files:[] as File[],getData:vi.fn()};
 fireEvent.dragStart(button,{dataTransfer:transfer});
 const payload=transfer.setData.mock.calls.find(([type])=>type===vaultDragType)![1];transfer.getData.mockReturnValue(payload);
 fireEvent.drop(region,{dataTransfer:transfer,clientX:500,clientY:250});
 fireEvent.click(screen.getByRole("button",{name:"打开 笔记.md"}));
 await screen.findByRole("tab",{name:/^笔记.md/,selected:true});
 expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector(".cm-editor")!)).toBe(editor);
 expect(vault.notes.has(note)).toBe(true);expect(vault.notes.has("画布/笔记.md")).toBe(false);
},12000);

it("笔记卡片渲染标题、公式和只读任务，并以源笔记路径打开链接", async () => {
 const file = "笔记/公式.md";
 const source = serializeCanvas({ nodes: [createCanvasNode("file", { x: 0, y: 0 }, { id: "math-note", file })], edges: [] });
 const { mount, vault, api } = fixture(source);
 vault.put(file, ["<!-- noto:task-category -->", "# 卡片标题", "$$\\frac{1}{2}$$", "- [x] 已完成", "[查看相关笔记](相关.md)"].join("\n\n"));
 vault.put("笔记/相关.md", "# 相关笔记");
 mount();

 const region = await openCanvas();
 const card = region.querySelector<HTMLElement>('[data-canvas-node="math-note"]')!;
 const preview = within(card);
 await preview.findByRole("heading", { name: "卡片标题" });
 expect(card.querySelector(".katex-html .mfrac")).toBeTruthy();
 expect(card.textContent).not.toMatch(/noto:task-category|摘要基于已保存文件/);
 const checkbox = preview.getByRole<HTMLInputElement>("checkbox");
 expect(checkbox.checked).toBe(true);
 expect(checkbox.disabled).toBe(true);

 fireEvent.click(preview.getByRole("link", { name: "查看相关笔记" }));
 await screen.findByRole("tab", { name: /^相关.md/, selected: true });
 expect(api.save).not.toHaveBeenCalled();
});

it("合法画布恢复视口/选择，装载和缩放不写文件",async()=>{
 const {mount,api}=fixture(),key=workspaceStorageKey("web","canvas-test");
 localStorage.setItem(key,JSON.stringify({...emptyWorkspace(),tabs:[path],active:path,canvases:{[path]:{viewport:{x:35,y:40,zoom:1.8},selected:["text"]}}}));
 mount();await screen.findByRole("tab",{name:/^a.canvas/,selected:true});
 const region=await screen.findByRole("region",{name:"知识画布"});
 expect((region.querySelector(".canvas-transform") as HTMLElement).style.transform).toBe("translate(35px,40px) scale(1.8)");
 expect(region.querySelector('[data-canvas-node="text"]')?.classList.contains("selected")).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"放大画布"}));
 expect(api.save).not.toHaveBeenCalled();expect(api.writeDraft).not.toHaveBeenCalled();
});

it("网格开关按画布记忆，重开后恢复且不写入画布文件", async () => {
 const { mount, api, vault } = fixture();
 vault.put("b.canvas", serializeCanvas({ nodes: [], edges: [] }));
 const first = mount(), region = await openCanvas();
 const grid = () => screen.getByRole("button", { name: "画布网格" });
 expect(grid().getAttribute("aria-pressed")).toBe("true");
 fireEvent.click(grid());
 expect(region.dataset.grid).toBe("false");
 expect(grid().getAttribute("aria-pressed")).toBe("false");

 const key = workspaceStorageKey("web", "canvas-test");
 await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).canvases[path].grid).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "b.canvas" }));
 await screen.findByRole("tab", { name: "b.canvas", selected: true });
 expect((await screen.findByRole("button", { name: "画布网格" })).getAttribute("aria-pressed")).toBe("true");
 first.unmount();
 mount();
 await openCanvas();
 expect(grid().getAttribute("aria-pressed")).toBe("false");
 expect(api.save).not.toHaveBeenCalled();
 expect(api.writeDraft).not.toHaveBeenCalled();
});

it("连接、标签、颜色及删除有独立撤销，删除连接不删除节点",async()=>{
 const content=serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{id:"text",text:"起点"}),createCanvasNode("text",{x:400,y:0},{id:"target",text:"终点"})],edges:[]});
 const {mount,vault}=fixture(content);mount();const region=await openCanvas();
 const header=region.querySelector('[data-canvas-node="text"] .canvas-node-header')!;
 fireEvent.pointerDown(header,{pointerId:1,clientX:10,clientY:10,button:0});fireEvent.pointerUp(region,{pointerId:1,clientX:10,clientY:10});
 fireEvent.pointerDown(screen.getByRole("button",{name:"连接 right"}),{pointerId:2,clientX:280,clientY:90,button:0});
 fireEvent.pointerUp(region,{pointerId:2,clientX:500,clientY:90});
 expect(region.querySelectorAll(".canvas-edge")).toHaveLength(1);
 fireEvent.change(screen.getByRole("textbox",{name:"连接标签"}),{target:{value:"说明"}});
 fireEvent.change(screen.getByRole("combobox",{name:"画布颜色"}),{target:{value:"4"}});
 fireEvent.click(screen.getByRole("button",{name:"删除"}));expect(region.querySelectorAll(".canvas-edge")).toHaveLength(0);
 expect(region.querySelectorAll(".canvas-node")).toHaveLength(2);
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));expect(region.querySelectorAll(".canvas-edge")).toHaveLength(1);
 await waitFor(()=>expect(parseCanvas(vault.stored.get(path)!.content).edges[0]).toMatchObject({label:"说明",color:"4"}));
});
it("通过文件菜单新建画布默认避开同名，不修改已有画布",async()=>{
 const {mount,vault}=fixture();const original=vault.notes.get(path)!.content;mount();await openCanvas();
 fireEvent.contextMenu(screen.getByRole("button",{name:"a.canvas"}));
 fireEvent.click(screen.getByRole("menuitem",{name:"新建知识画布"}));
 let input=await screen.findByDisplayValue("未命名画布.canvas");
 fireEvent.submit(input.closest("form")!);
 await screen.findByRole("tab",{name:"未命名画布.canvas",selected:true});
 expect(vault.notes.get(path)?.content).toBe(original);
 expect(parseCanvas(vault.notes.get("画布/未命名画布.canvas")!.content)).toEqual({nodes:[],edges:[]});
 fireEvent.contextMenu(screen.getByRole("button",{name:"a.canvas"}));
 fireEvent.click(screen.getByRole("menuitem",{name:"新建知识画布"}));
 input=await screen.findByDisplayValue("未命名画布 2.canvas");
 fireEvent.submit(input.closest("form")!);
 await screen.findByRole("tab",{name:"未命名画布 2.canvas",selected:true});
 expect(vault.notes.has("画布/未命名画布.canvas")).toBe(true);
});
it("笔记改名维护画布字段与文本链接，画布改名与另存保留原文件和目标关系",async()=>{
 const content=serializeCanvas({nodes:[createCanvasNode("file",{x:0,y:0},{file:"目标.md"}),createCanvasNode("text",{x:0,y:250},{id:"text",text:"[目标](../目标.md)"})],edges:[]});
 const {mount,vault}=fixture(content);mount();await openCanvas();
 fireEvent.keyDown(screen.getByRole("button",{name:"目标.md"}),{key:"F2"});
 let input=await screen.findByRole("textbox",{name:"重命名 目标.md"});
 fireEvent.change(input,{target:{value:"新目标.md"}});fireEvent.keyDown(input,{key:"Enter"});
 await screen.findByRole("button",{name:"打开 新目标.md"});
 expect(parseCanvas(vault.notes.get(path)!.content).nodes[1].text).toContain("../"+encodeURIComponent("新目标")+".md");
 fireEvent.keyDown(screen.getByRole("button",{name:"a.canvas"}),{key:"F2"});
 input=await screen.findByRole("textbox",{name:"重命名 a.canvas"});
 fireEvent.change(input,{target:{value:"b.canvas"}});fireEvent.keyDown(input,{key:"Enter"});
 await screen.findByRole("tab",{name:"b.canvas",selected:true});
 fireEvent.click(screen.getByRole("button",{name:"另存为"}));
 input=await screen.findByDisplayValue("画布/恢复的画布.canvas");fireEvent.change(input,{target:{value:"副本.canvas"}});fireEvent.submit(input.closest("form")!);
 await screen.findByRole("tab",{name:"副本.canvas",selected:true});
 expect(vault.notes.has("画布/b.canvas")).toBe(true);expect(vault.notes.has(path)).toBe(false);
 const copy=parseCanvas(vault.notes.get("副本.canvas")!.content);
 expect(copy.nodes[0].file).toBe("新目标.md");expect(copy.nodes[1].text).toContain("]("+encodeURIComponent("新目标")+".md)");
},15000);

it("不支持/损坏的恢复草稿即使基准一致也不能被自动保存覆盖原画布",async()=>{
 const {mount,api,vault}=fixture();const original=vault.notes.get(path)!;
 vault.stored.set(path,{path,content:"{broken draft",baseVersion:original.version});
 mount();await openCanvas();fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));
 await screen.findByText(/画布 JSON 无法解析/);
 await act(async()=>new Promise(resolve=>setTimeout(resolve,1800)));
 expect(api.save).not.toHaveBeenCalled();expect(vault.notes.get(path)?.content).toBe(original.content);
 expect(vault.stored.get(path)?.content).toBe("{broken draft");
 expect(screen.getByText("只读草稿")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"关闭标签 a.canvas"}));
 await screen.findByText(/无法关闭标签/);expect(screen.getByRole("tab",{name:/^a.canvas/})).toBeTruthy();
},10000);
it("滚轮只缩放背景，卡片键盘可移动和编辑，输入中的删除/IME 不删除节点",async()=>{
 const {mount}=fixture();mount();const region=await openCanvas();
 const header=screen.getByRole("button",{name:"选择卡片 初始文字"});
 fireEvent.keyDown(header,{key:"ArrowRight"});
 const node=region.querySelector<HTMLElement>('[data-canvas-node="text"]')!;expect(node.style.left).toBe("10px");
 const before=screen.getByRole("button",{name:"画布恢复100%"}).textContent;
 const scroll=new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:100,clientX:100,clientY:100});
 fireEvent(node.querySelector(".canvas-node-body")!,scroll);expect(scroll.defaultPrevented).toBe(false);
 expect(screen.getByRole("button",{name:"画布恢复100%"}).textContent).toBe(before);
 const zoom=new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:100,clientX:100,clientY:100});
 fireEvent(region,zoom);expect(zoom.defaultPrevented).toBe(true);
 expect(screen.getByRole("button",{name:"画布恢复100%"}).textContent).not.toBe(before);
 fireEvent.keyDown(header,{key:"Enter"});const input=await screen.findByRole("textbox",{name:"画布文本"});
 fireEvent.keyDown(input,{key:"Backspace"});fireEvent.compositionStart(input);fireEvent.keyDown(input,{key:"Escape",isComposing:true});
 expect(screen.getByRole("textbox",{name:"画布文本"})).toBe(input);expect(region.querySelectorAll(".canvas-node")).toHaveLength(1);
 fireEvent.compositionEnd(input);
});

it("路径调整重置已打开画布的旧撤销分支，不能恢复已失效的旧文件引用",async()=>{
 const content=serializeCanvas({nodes:[createCanvasNode("file",{x:0,y:0},{id:"file",file:"目标.md"})],edges:[]});
 const {mount,vault}=fixture(content);mount();await openCanvas();
 fireEvent.keyDown(screen.getByRole("button",{name:"选择卡片 目标.md"}),{key:" "});
 fireEvent.click(screen.getByRole("button",{name:"删除"}));
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(0),{timeout:4000});
 expect((screen.getByRole("button",{name:"画布撤销"}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.keyDown(screen.getByRole("button",{name:"目标.md"}),{key:"F2"});
 const rename=await screen.findByRole("textbox",{name:"重命名 目标.md"});
 fireEvent.change(rename,{target:{value:"新目标.md"}});fireEvent.keyDown(rename,{key:"Enter"});
 await waitFor(()=>expect(vault.notes.has("新目标.md")).toBe(true));
 await waitFor(()=>expect((screen.getByRole("button",{name:"画布撤销"}) as HTMLButtonElement).disabled).toBe(true));
 expect(parseCanvas(vault.notes.get(path)!.content).nodes).toHaveLength(0);
},10000);

it("附件双击只打开一次，不触发重复下载",async()=>{
 const content=serializeCanvas({nodes:[createCanvasNode("file",{x:0,y:0},{file:"附件/a.pdf"})],edges:[]});
 const {mount,api}=fixture(content);api.openAttachment.mockResolvedValue(undefined);mount();const region=await openCanvas();
 fireEvent.doubleClick(region.querySelector(".canvas-file-body")!);
 expect(api.openAttachment).toHaveBeenCalledTimes(1);expect(api.openAttachment).toHaveBeenCalledWith(path,"../附件/a.pdf");
});
it("网络保存失败可继续输入并手动重试，原输入框、最新内容和草稿保留",async()=>{
 const {mount,api,vault}=fixture();mount();await openCanvas();
 api.save.mockRejectedValueOnce(new WorkspaceError("network","测试断网"));
 const input=await editCanvas("断网前的编辑");
 await screen.findByText(/保存失败：测试断网/,{}, {timeout:4000});
 expect(screen.getByRole("textbox",{name:"画布文本"})).toBe(input);
 fireEvent.change(input,{target:{value:"失败后继续输入"}});
 await waitFor(()=>expect(parseCanvas(vault.stored.get(path)!.content).nodes[0].text).toBe("失败后继续输入"));
 fireEvent.click(screen.getByRole("button",{name:"保存"}));
 await waitFor(()=>expect(parseCanvas(vault.notes.get(path)!.content).nodes[0].text).toBe("失败后继续输入"));
 expect(screen.getByRole("textbox",{name:"画布文本"})).toBe(input);
 expect((screen.getByRole("button",{name:"画布撤销"}) as HTMLButtonElement).disabled).toBe(false);
},10000);
it("切库等待原画布附件与草稿落盘，新库不接收旧内容或资源结果",async()=>{
 const original=serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{id:"text",text:"初始文字"})],edges:[]});
 const {mount,api,vault}=fixture(original,"desktop");mount();const region=await openCanvas();
 let complete!:(value:string)=>void;
 api.importAttachmentData.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
 fireEvent.paste(region,{clipboardData:{files:[new File(["image"],"图.png",{type:"image/png"})]}});
 await waitFor(()=>expect(complete).toBeTypeOf("function"));
 await editCanvas("切库前保留的编辑");
 const next=new MemoryVault();next.put("next.md","新知识库");
 api.chooseDirectory.mockResolvedValue("next-vault");
 api.selectVault.mockImplementation(async()=>{
  api.entries=next.entries;api.read.mockImplementation(next.read);api.save.mockImplementation(next.save);api.drafts=next.drafts;api.writeDraft.mockImplementation(next.writeDraft);
  return {vault:"next-vault",id:"next-test",error:null};
 });
 fireEvent.click(screen.getByRole("button", { name: /知识库选项/ }));
 fireEvent.click(screen.getByRole("button", { name: "打开其他知识库" }));
 await act(async()=>Promise.resolve());expect(api.selectVault).not.toHaveBeenCalled();
 await act(async()=>complete("attachments/图.png"));
 await waitFor(()=>expect(api.selectVault).toHaveBeenCalledWith("next-vault"));
 const draft=parseCanvas(vault.stored.get(path)!.content);
 expect(draft.nodes[0].text).toBe("切库前保留的编辑");expect(draft.nodes[1].file).toBe("画布/attachments/图.png");
 fireEvent.click(await screen.findByRole("button",{name:"next.md"}));await screen.findByRole("tab",{name:"next.md",selected:true});
 expect(screen.queryByRole("region",{name:"知识画布"})).toBeNull();expect(next.stored.has(path)).toBe(false);
 expect(next.notes.get("next.md")?.content).toBe("新知识库");
},12000);
