// @vitest-environment jsdom
import "../test/codemirror-dom";
import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {EditorView} from "@codemirror/view";
import {undo} from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import {MemoryVault} from "../test/memory-vault";
import {WorkspaceRuntimeContext,type WorkspaceRuntime} from "../lib/workspace-runtime";
import {WorkspaceError} from "../lib/api-error";
import type {WorkspaceApi} from "../lib/vault-api";
import {emptyDrawing,parseDrawing,serializeDrawing,defaultDrawingStyle as style,type DrawingData} from "../lib/drawing-document";
import {createDrawingElement,pencilElement} from "../lib/drawing-geometry";
import {drawingToSvg} from "../lib/drawing-svg";
import {createCanvasNode,parseCanvas,serializeCanvas} from "../lib/canvas-document";
import {emptyWorkspace,workspaceStorageKey} from "../lib/workspace-state";
import {vaultDragType} from "../lib/document-kind";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
const path="绘图/a.drawing",note="笔记.md",canvasPath="画布/c.canvas";
let context:CanvasRenderingContext2D;
beforeEach(()=>{
 localStorage.clear();vi.clearAllMocks();
 vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal("PointerEvent",class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
 vi.stubGlobal("DragEvent",class extends MouseEvent{dataTransfer:DataTransfer|null;constructor(type:string,init:DragEventInit={}){super(type,init);this.dataTransfer=init.dataTransfer??null;}});
 context={save:vi.fn(),restore:vi.fn(),setTransform:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),strokeRect:vi.fn(),translate:vi.fn(),scale:vi.fn(),setLineDash:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),fill:vi.fn(),arc:vi.fn(),ellipse:vi.fn(),closePath:vi.fn(),fillText:vi.fn(),measureText:vi.fn((s:string)=>({width:[...s].length*18}))} as unknown as CanvasRenderingContext2D;
 vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(()=>context);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture(data:DrawingData|string={...emptyDrawing(),elements:[{...createDrawingElement("text",{x:30,y:40},{x:30,y:40},style,"text"),text:"初始文字",width:180,height:56}]},kind:"web"|"desktop"="web"){
 const vault=new MemoryVault();vault.put(path,typeof data==="string"?data:serializeDrawing(data));vault.put(note,"原笔记");vault.put("目标.md","# 目标");
 vault.put(canvasPath,serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{id:"canvas-text",text:"画布原文"})],edges:[]}));
 const api={...vault,status:async()=>({vault:"drawing-vault",id:"drawing-test",error:null}),read:vi.fn(vault.read),save:vi.fn(vault.save),writeDraft:vi.fn(vault.writeDraft),removeDraft:vi.fn(vault.removeDraft),chooseFile:vi.fn(),chooseDirectory:vi.fn(),selectVault:vi.fn(),createVault:vi.fn(),importAttachment:vi.fn(),importAttachmentData:vi.fn(async()=>"attachments/图.png"),image:vi.fn(async()=>"data:image/png;base64,AQID"),openItem:vi.fn(),openAttachment:vi.fn(),openExternal:vi.fn(),remove:vi.fn()} satisfies WorkspaceApi;
 const runtime:WorkspaceRuntime={kind,api};
 const mount=()=>render(<WorkspaceRuntimeContext.Provider value={runtime}><DesktopApp/></WorkspaceRuntimeContext.Provider>);
 return {vault,api,runtime,mount};
}
async function openDrawing(){
 fireEvent.click(await screen.findByRole("button",{name:"a.drawing"}));await screen.findByRole("tab",{name:/^a.drawing/,selected:true});
 return screen.findByRole("region",{name:"绘图白板"});
}
function bitmap(){return screen.getByLabelText("白板绘制区域");}
async function editDrawing(value:string){
 fireEvent.doubleClick(bitmap(),{clientX:70,clientY:55});const input=await screen.findByRole("textbox",{name:"白板文字"});
 fireEvent.change(input,{target:{value}});return input as HTMLTextAreaElement;
}
async function openMarkdown(){
 fireEvent.click(await screen.findByRole("button",{name:note}));await screen.findByRole("tab",{name:/^笔记.md/,selected:true});
 return waitFor(()=>EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!);
}
async function save(vault:MemoryVault,assertion:(data:DrawingData)=>void,target=path){
 fireEvent.click(screen.getByRole("button",{name:"保存"}));
 await waitFor(()=>assertion(parseDrawing(vault.notes.get(target)!.content)),{timeout:4000});
}
function pointer(type:"down"|"move"|"up"|"cancel",x:number,y:number,id=1){
 const init={clientX:x,clientY:y,pointerId:id,button:0};
 if(type==="down")fireEvent.pointerDown(bitmap(),init);else if(type==="move")fireEvent.pointerMove(screen.getByRole("region",{name:"绘图白板"}),init);else if(type==="up")fireEvent.pointerUp(screen.getByRole("region",{name:"绘图白板"}),init);else fireEvent.pointerCancel(screen.getByRole("region",{name:"绘图白板"}),init);
}
it.each(["web","desktop"] as const)("%s 笔记及画布预览保存态，打开复用草稿会话和撤销",async kind=>{
 const {mount,vault,api}=fixture(undefined,kind);vault.put(note,"标题\n\n![[绘图/a.drawing]]\n\n正文");
 mount();await openMarkdown();fireEvent.click(screen.getByRole("button",{name:"阅读"}));
 const notePreview=await screen.findByRole("button",{name:"打开白板 "+path});expect(notePreview.querySelector("img")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"c.canvas"}));const canvas=await screen.findByRole("region",{name:"知识画布"});
 fireEvent.click(screen.getByRole("button",{name:"白板"}));const dialog=screen.getByRole("dialog",{name:"选择白板"});fireEvent.click(within(dialog).getByRole("button",{name:/a.drawing/}));
 const canvasPreview=await within(canvas).findByRole("button",{name:"打开白板 "+path});expect(canvasPreview.textContent).toContain("已保存白板");
 await waitFor(()=>expect(parseCanvas(vault.notes.get(canvasPath)!.content).nodes.some(node=>node.file===path)).toBe(true),{timeout:4000});
 await openDrawing();const input=await editDrawing("尚未保存的草稿");let finish!:()=>void;
 api.save.mockImplementationOnce((file,content,version)=>new Promise(resolve=>{finish=()=>{void vault.save(file,content,version).then(resolve);};}));
 fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(finish).toBeTypeOf("function"));
 fireEvent.click(screen.getByRole("tab",{name:/^笔记.md/}));const image=(await screen.findByRole("button",{name:"打开白板 "+path})).querySelector("img")!;
 await waitFor(()=>expect(vault.stored.get(path)?.content).toContain("尚未保存的草稿"));
 const decoded=new TextDecoder().decode(Uint8Array.from(atob(image.src.split(",")[1]),c=>c.charCodeAt(0)));expect(decoded).toContain("初始文字");expect(decoded).not.toContain("尚未保存的草稿");
 fireEvent.click(image);await screen.findByRole("region",{name:"绘图白板"});expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);expect(input.value).toBe("尚未保存的草稿");
 fireEvent.click(screen.getByRole("tab",{name:/^c.canvas/}));const image2=(await screen.findByRole("button",{name:"打开白板 "+path})).querySelector("img")!;
 const decoded2=new TextDecoder().decode(Uint8Array.from(atob(image2.src.split(",")[1]),c=>c.charCodeAt(0)));expect(decoded2).toContain("初始文字");expect(decoded2).not.toContain("尚未保存的草稿");
 fireEvent.click(image2);await screen.findByRole("region",{name:"绘图白板"});expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);
 await act(async()=>finish());await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements[0].text).toBe("尚未保存的草稿"),{timeout:4000});
 fireEvent.click(screen.getByRole("tab",{name:/^笔记.md/}));
 await waitFor(()=>{const next=screen.getByRole("button",{name:"打开白板 "+path}).querySelector("img")!;expect(new TextDecoder().decode(Uint8Array.from(atob(next.src.split(",")[1]),c=>c.charCodeAt(0)))).toContain("尚未保存的草稿");},{timeout:4000});
 fireEvent.click(screen.getByRole("tab",{name:/^c.canvas/}));fireEvent.click(screen.getByRole("button",{name:"刷新引用"}));
 await waitFor(()=>{const next=screen.getByRole("button",{name:"打开白板 "+path}).querySelector("img")!;expect(new TextDecoder().decode(Uint8Array.from(atob(next.src.split(",")[1]),c=>c.charCodeAt(0)))).toContain("尚未保存的草稿");},{timeout:4000});
 fireEvent.click(screen.getByRole("tab",{name:/^a.drawing/}));
 fireEvent.keyDown(input,{key:"Escape"});fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements[0].text).toBe("初始文字"),{timeout:4000});
},15000);
it("画布添加白板卡片可撤销重做，不修改原白板",async()=>{
 const {mount,vault}=fixture(),before=vault.notes.get(path)!.content;mount();fireEvent.click(await screen.findByRole("button",{name:"c.canvas"}));await screen.findByRole("region",{name:"知识画布"});
 fireEvent.click(screen.getByRole("button",{name:"白板"}));fireEvent.click(within(screen.getByRole("dialog",{name:"选择白板"})).getByRole("button",{name:/a.drawing/}));
 await waitFor(()=>expect(parseCanvas(vault.notes.get(canvasPath)!.content).nodes.some(node=>node.file===path)).toBe(true),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布撤销"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(canvasPath)!.content).nodes.some(node=>node.file===path)).toBe(false),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"画布重做"}));await waitFor(()=>expect(parseCanvas(vault.notes.get(canvasPath)!.content).nodes.some(node=>node.file===path)).toBe(true),{timeout:4000});
 expect(vault.notes.get(path)!.content).toBe(before);
},12000);
it("文件树复制白板嵌入语法，分屏预览保持源码不变",async()=>{
 const {mount,vault,api}=fixture();vault.put(note,"标题\n\n![[绘图/a.drawing|示意]]\n\n正文");
 const clipboard={writeText:vi.fn(async()=>{})};vi.stubGlobal("navigator",Object.assign(Object.create(navigator),{clipboard}));
 mount();const editor=await openMarkdown();fireEvent.contextMenu(screen.getByRole("button",{name:"a.drawing"}));fireEvent.click(screen.getByRole("menuitem",{name:"复制白板嵌入语法"}));
 await waitFor(()=>expect(clipboard.writeText).toHaveBeenCalledWith("![[绘图/a.drawing]]"));
 fireEvent.click(screen.getByRole("button",{name:"分屏"}));const preview=await screen.findByRole("button",{name:"打开白板 "+path});expect(preview.querySelector("img")).toBeTruthy();
 expect(editor.state.doc.toString()).toBe("标题\n\n![[绘图/a.drawing|示意]]\n\n正文");expect(api.save).not.toHaveBeenCalled();
},10000);
it("知识画布文本卡片也能预览并打开已保存白板",async()=>{
 const {mount,vault,api}=fixture();const source=serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{id:"embed",text:"![[绘图/a.drawing]]"})],edges:[]});vault.put(canvasPath,source);
 mount();fireEvent.click(await screen.findByRole("button",{name:"c.canvas"}));const region=await screen.findByRole("region",{name:"知识画布"});
 const preview=await within(region).findByRole("button",{name:"打开白板 "+path});expect(preview.querySelector("img")).toBeTruthy();
 fireEvent.click(preview);await screen.findByRole("region",{name:"绘图白板"});expect(vault.notes.get(canvasPath)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();
},10000);
it("损坏的已保存白板预览提示错误，仍可打开原文件并保留源数据",async()=>{
 const {mount,vault,api}=fixture("{损坏的白板");vault.put(note,"![[绘图/a.drawing]]");mount();await openMarkdown();fireEvent.click(screen.getByRole("button",{name:"阅读"}));
 await screen.findByText(/白板 JSON 无法解析/);fireEvent.click(screen.getByRole("button",{name:/绘图\/a.drawing ↗/}));
 await screen.findByRole("tab",{name:/^a.drawing/,selected:true});expect(screen.getByText(/白板 JSON 无法解析/)).toBeTruthy();expect(vault.notes.get(path)!.content).toBe("{损坏的白板");expect(api.save).not.toHaveBeenCalled();
},10000);
it.each(["web","desktop"] as const)("%s 白板忽略其他指针，主指针完成或取消时才结束手势",async(kind)=>{
 const {mount,vault,api}=fixture(emptyDrawing(),kind);mount();const region=await openDrawing();
 fireEvent.click(screen.getByRole("button",{name:"画笔工具"}));pointer("down",10,10,1);pointer("move",50,10,1);
 pointer("down",400,400,2);pointer("move",450,450,2);pointer("cancel",450,450,2);
 fireEvent(region,new PointerEvent("lostpointercapture",{bubbles:true,pointerId:2}));pointer("up",450,450,2);
 expect(api.save).not.toHaveBeenCalled();pointer("up",110,10,1);
 await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements).toHaveLength(1),{timeout:4000});
 const first=vault.notes.get(path)!.content,stroke=parseDrawing(first).elements[0];expect(stroke.x).toBe(10);expect(stroke.points!.at(-1)).toEqual([100,0]);
 pointer("down",10,100,3);pointer("move",100,100,3);fireEvent(region,new PointerEvent("lostpointercapture",{bubbles:true,pointerId:3}));pointer("up",100,100,3);
 expect(vault.notes.get(path)!.content).toBe(first);
 fireEvent.click(screen.getByRole("button",{name:"橡皮工具"}));pointer("down",60,10,4);pointer("down",400,400,5);pointer("cancel",400,400,5);
 fireEvent(region,new PointerEvent("lostpointercapture",{bubbles:true,pointerId:5}));pointer("up",60,10,4);
 await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements).toHaveLength(2),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(first),{timeout:4000});
},15000);
it.each(["web","desktop"] as const)("%s 白板橡皮尺寸按屏幕缩放，两种模式分别擦笔迹或整件对象",async(kind)=>{
 const pen={...pencilElement([{x:20,y:20},{x:180,y:20}],style,"pen"),link:{file:note},extra:{keep:true}};
 const rect=createDrawingElement("rectangle",{x:0,y:20},{x:200,y:100},style,"rect"),doc={...emptyDrawing(),elements:[pen,rect]},source=serializeDrawing(doc);
 const {mount,vault,api}=fixture(doc,kind),key=workspaceStorageKey(kind,"drawing-test");
 localStorage.setItem(key,JSON.stringify({...emptyWorkspace(),tabs:[path],active:path,drawings:{[path]:{viewport:{x:0,y:0,zoom:2},selected:[],tool:"eraser",style,grid:false}}}));
 mount();const region=await screen.findByRole("region",{name:"绘图白板"});
 expect(screen.getByLabelText("白板橡皮模式")).toHaveProperty("value","stroke");fireEvent.change(screen.getByLabelText("白板橡皮尺寸"),{target:{value:"40"}});
 fireEvent.pointerMove(region,{pointerId:1,clientX:200,clientY:40});expect(region.querySelector<HTMLElement>(".drawing-eraser-cursor")!.style.width).toBe("40px");expect(api.save).not.toHaveBeenCalled();
 await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).drawings[path].eraserSize).toBe(40),{timeout:4000});
 pointer("down",200,40);pointer("up",200,40);
 await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements).toHaveLength(3),{timeout:4000});
 const cut=parseDrawing(vault.notes.get(path)!.content);expect(cut.elements[2]).toEqual(rect);expect(cut.elements[0].x+cut.elements[0].points!.at(-1)![0]).toBeCloseTo(89,1);expect(cut.elements[1].x).toBeCloseTo(111,1);
 expect(cut.elements.slice(0,2).every(e=>e.link?.file===note&&JSON.stringify(e.extra)==='{"keep":true}')).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
 fireEvent.change(screen.getByLabelText("白板橡皮模式"),{target:{value:"object"}});expect(screen.getByText(/擦除整个对象（包括笔迹）/)).toBeTruthy();
 pointer("down",200,40);pointer("up",200,40);await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements).toHaveLength(0),{timeout:4000});
 await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).drawings[path].eraserMode).toBe("object"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"重做白板"}));await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements).toHaveLength(0),{timeout:4000});
},18000);
it("白板两种橡皮慢保存及断网失败时保留最新草稿与撤销",async()=>{
 const pen=pencilElement([{x:20,y:20},{x:180,y:20}],style,"pen"),rect=createDrawingElement("rectangle",{x:0,y:80},{x:100,y:140},style,"rect"),doc={...emptyDrawing(),elements:[pen,rect]},source=serializeDrawing(doc);
 const {mount,vault,api}=fixture(doc);let finish!:()=>void;
 api.save.mockImplementationOnce((file,content,version)=>new Promise(resolve=>{finish=()=>{void vault.save(file,content,version).then(resolve);};}));
 mount();await openDrawing();fireEvent.click(screen.getByRole("button",{name:"橡皮工具"}));pointer("down",100,20);pointer("up",100,20);
 await waitFor(()=>expect(finish).toBeTypeOf("function"),{timeout:4000});fireEvent.change(screen.getByLabelText("白板橡皮模式"),{target:{value:"object"}});pointer("down",50,80,2);pointer("up",50,80,2);
 api.save.mockRejectedValueOnce(new WorkspaceError("network","白板擦除断网"));await act(async()=>finish());
 await screen.findAllByText(/白板擦除断网/,{}, {timeout:4000});await waitFor(()=>expect(parseDrawing(vault.stored.get(path)!.content).elements.map(e=>e.type)).toEqual(["pencil","pencil"]),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements.map(e=>e.type)).toEqual(["pencil","pencil"]),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements).toHaveLength(3),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(source),{timeout:4000});
},18000);
it("工作区恢复白板橡皮模式和尺寸时不修改白板正文",async()=>{
 const {mount,vault,api}=fixture(),source=vault.notes.get(path)!.content,key=workspaceStorageKey("web","drawing-test");
 localStorage.setItem(key,JSON.stringify({...emptyWorkspace(),tabs:[path],active:path,drawings:{[path]:{viewport:{x:0,y:0,zoom:1},selected:[],tool:"eraser",style,grid:true,eraserSize:60,eraserMode:"object"}}}));
 mount();await screen.findByRole("region",{name:"绘图白板"});expect(screen.getByLabelText("白板橡皮尺寸")).toHaveProperty("value","60");expect(screen.getByLabelText("白板橡皮模式")).toHaveProperty("value","object");
 expect(vault.notes.get(path)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();
});
it.each(["web","desktop"] as const)("%s 多选混合属性不会伪装成统一值，色板修改可撤销",async(kind)=>{
 const one=createDrawingElement("rectangle",{x:0,y:0},{x:100,y:80},{...style,strokeColor:"#ff0000",strokeWidth:2,fillColor:"#ffffff"},"one");
 const two=createDrawingElement("ellipse",{x:150,y:0},{x:250,y:80},{...style,strokeColor:"#00ff00",strokeWidth:4,fillColor:"transparent"},"two");
 const content={...emptyDrawing(),elements:[one,two]};const {mount,vault,api}=fixture(content,kind);mount();const region=await openDrawing();
 fireEvent.keyDown(region,{key:"a",ctrlKey:true});
 expect(screen.getByLabelText("白板笔宽")).toHaveProperty("value","mixed");
 expect((screen.getByLabelText("启用白板填充") as HTMLInputElement).indeterminate).toBe(true);
 expect(screen.getAllByText("混合").length).toBeGreaterThanOrEqual(2);
 expect(api.save).not.toHaveBeenCalled();expect(parseDrawing(vault.notes.get(path)!.content).elements.map(e=>e.strokeColor)).toEqual(["#ff0000","#00ff00"]);
 fireEvent.click(screen.getByRole("button",{name:"笔色 #2563eb"}));
 await save(vault,d=>expect(d.elements.map(e=>e.strokeColor)).toEqual(["#2563eb","#2563eb"]));
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));
 await save(vault,d=>expect(d.elements.map(e=>e.strokeColor)).toEqual(["#ff0000","#00ff00"]));
 fireEvent.click(screen.getByRole("button",{name:"笔宽 6 px"}));
 await save(vault,d=>expect(d.elements.map(e=>e.strokeWidth)).toEqual([6,6]));
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));
 await save(vault,d=>expect(d.elements.map(e=>e.strokeWidth)).toEqual([2,4]));
});
it("橡皮范围跟随指针并说明笔迹可局部擦除",async()=>{
 const {mount,api}=fixture();mount();const region=await openDrawing();
 fireEvent.click(screen.getByRole("button",{name:"橡皮工具"}));
 fireEvent.pointerMove(region,{clientX:80,clientY:60,pointerId:1});
 const cursor=region.querySelector<HTMLElement>(".drawing-eraser-cursor")!;
 expect(cursor.style.visibility).toBe("visible");expect(cursor.style.left).toBe("80px");expect(cursor.style.top).toBe("60px");
 expect(screen.getByText(/橡皮局部擦除笔迹/)).toBeTruthy();expect(api.save).not.toHaveBeenCalled();
 fireEvent.pointerLeave(region);expect(cursor.style.visibility).toBe("hidden");
});
it("专注模式不改写白板，退出后保留输入与撤销",async()=>{
 const {mount,vault,api}=fixture();mount();await openDrawing();
 const before=vault.notes.get(path)!.content,workspace=screen.getByLabelText("绘图白板工作区");
 fireEvent.click(screen.getByRole("button",{name:"进入白板专注模式"}));fireEvent.click(screen.getByRole("button",{name:"退出白板专注模式"}));
 expect(vault.notes.get(path)!.content).toBe(before);expect(api.save).not.toHaveBeenCalled();
 const input=await editDrawing("专注编辑");
 fireEvent.click(screen.getByRole("button",{name:"进入白板专注模式"}));expect(workspace.classList.contains("is-focused")).toBe(true);
 expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);
 fireEvent.click(screen.getByRole("button",{name:"退出白板专注模式"}));expect(workspace.classList.contains("is-focused")).toBe(false);
 expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);
 await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements[0].text).toBe("专注编辑"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await waitFor(()=>expect(vault.notes.get(path)!.content).toBe(before),{timeout:4000});
 expect(api.save).not.toHaveBeenCalledWith(path,expect.stringContaining("is-focused"),expect.anything());
},12000);
it.each(["web","desktop"] as const)("%s 切换主题不写白板文件或改变 SVG 颜色",async(kind)=>{
 const {mount,vault,api}=fixture(undefined,kind);mount();await openDrawing();const before=vault.notes.get(path)!.content,svg=drawingToSvg(before);
 fireEvent.click(screen.getByRole("button",{name:"软件设置"}));const dialog=screen.getByRole("dialog",{name:"软件设置"});
 fireEvent.click(within(dialog).getByRole("button",{name:"Nord"}));fireEvent.click(within(dialog).getByRole("button",{name:"完成"}));
 await new Promise(resolve=>setTimeout(resolve,100));expect(vault.notes.get(path)!.content).toBe(before);expect(drawingToSvg(vault.notes.get(path)!.content)).toBe(svg);expect(api.save).not.toHaveBeenCalled();
});
it.each(["web","desktop"] as const)("%s 切换主题保留白板文字输入、作品颜色和撤销历史",async(kind)=>{
 const {mount,vault,api}=fixture(undefined,kind);mount();await openDrawing();
 const before=vault.notes.get(path)!.content,input=await editDrawing("主题切换时继续编辑");input.setSelectionRange(2,5);
 fireEvent.click(screen.getByRole("button",{name:"软件设置"}));
 const dialog=screen.getByRole("dialog",{name:"软件设置"});fireEvent.click(within(dialog).getByRole("button",{name:"Nord"}));
 fireEvent.click(within(dialog).getByRole("button",{name:"完成"}));
 expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);expect(input.value).toBe("主题切换时继续编辑");expect(input.selectionStart).toBe(2);
 expect(parseDrawing(vault.notes.get(path)!.content).background).toBe(parseDrawing(before).background);
 await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements[0].text).toBe("主题切换时继续编辑"),{timeout:4000});
 expect(api.save).not.toHaveBeenCalledWith(path,expect.stringContaining("#2e3440"),expect.anything());
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements[0].text).toBe("初始文字"),{timeout:4000});
},10000);
it("真实CodeMirror、画布和白板混合标签保留各自内容、选择/滚动、历史和自动保存",async()=>{
 const {mount,vault}=fixture();mount();const editor=await openMarkdown();
 act(()=>editor.dispatch({changes:{from:0,insert:"未保存"},selection:{anchor:2},userEvent:"input.type"}));
 fireEvent.click(screen.getByRole("button",{name:"c.canvas"}));await screen.findByRole("region",{name:"知识画布"});
 fireEvent.doubleClick(document.querySelector('[data-canvas-node="canvas-text"] .canvas-node-body')!);
 const canvasInput=await screen.findByRole("textbox",{name:"画布文本"});fireEvent.change(canvasInput,{target:{value:"画布分支"}});(canvasInput as HTMLTextAreaElement).setSelectionRange(1,3);
 await openDrawing();expect(screen.queryByLabelText("笔记统计")).toBeNull();expect(screen.queryByRole("group",{name:"编辑视图"})).toBeNull();
 const input=await editDrawing("白板多行\n中文编辑");input.setSelectionRange(2,4);input.scrollTop=30;
 fireEvent.click(screen.getByRole("button",{name:"放大白板"}));const zoom=screen.getByRole("button",{name:"白板恢复100%"}).textContent;
 fireEvent.click(screen.getByRole("tab",{name:/^笔记.md/}));expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector(".cm-editor")!)).toBe(editor);expect(editor.state.doc.toString()).toBe("未保存原笔记");expect(editor.state.selection.main.head).toBe(2);
 act(()=>undo(editor));expect(editor.state.doc.toString()).toBe("原笔记");
 fireEvent.click(screen.getByRole("tab",{name:/^c.canvas/}));expect(screen.getByRole("textbox",{name:"画布文本"})).toBe(canvasInput);expect((canvasInput as HTMLTextAreaElement).selectionStart).toBe(1);
 fireEvent.click(screen.getByRole("tab",{name:/^a.drawing/}));expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);expect(input.selectionStart).toBe(2);expect(input.scrollTop).toBe(30);expect(screen.getByRole("button",{name:"白板恢复100%"}).textContent).toBe(zoom);
 fireEvent.keyDown(input,{key:"Escape"});fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));expect(screen.getByRole("button",{name:"重做白板"})).not.toHaveProperty("disabled",true);
 fireEvent.click(screen.getByRole("button",{name:"重做白板"}));await save(vault,d=>expect(d.elements[0].text).toBe("白板多行\n中文编辑"));
},15000);
it("慢保存只确认提交快照，继续输入不重挂并最终保存最新内容",async()=>{
 const {mount,api,vault}=fixture();let release!:(value:Awaited<ReturnType<typeof vault.save>>)=>void;
 api.save.mockImplementationOnce(async(p,c,v)=>new Promise(resolve=>{release=()=>void vault.save(p,c,v).then(resolve);}));
 mount();await openDrawing();const input=await editDrawing("第一轮");
 await waitFor(()=>expect(release).toBeTypeOf("function"),{timeout:3000});
 fireEvent.change(input,{target:{value:"第一轮以后继续编辑"}});input.setSelectionRange(4,6);
 await act(async()=>release(undefined as never));
 await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements[0].text).toBe("第一轮以后继续编辑"),{timeout:4000});
 expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);expect(input.selectionStart).toBe(4);
},12000);
it("绘制/移动落下单步提交，取消、隐藏及旧指针不写入临时位置",async()=>{
 const doc={...emptyDrawing(),elements:[createDrawingElement("rectangle",{x:0,y:0},{x:100,y:80},style,"rect")]};
 const {mount,vault}=fixture(doc);mount();await openDrawing();
 pointer("down",0,40);pointer("move",30,70);pointer("up",30,70);await save(vault,d=>expect(d.elements[0].x).toBe(30));
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await save(vault,d=>expect(d.elements[0].x).toBe(0));
 pointer("down",0,40);pointer("move",80,80);pointer("cancel",80,80);
 expect(screen.getByRole("button",{name:"保存"})).toHaveProperty("disabled",true);
 pointer("down",0,40);pointer("move",100,80);const region=screen.getByRole("region",{name:"绘图白板"});await openMarkdown();
 fireEvent.pointerUp(region,{clientX:100,clientY:80,pointerId:1});expect(parseDrawing(vault.notes.get(path)!.content).elements[0].x).toBe(0);
},12000);
it.each(["web","desktop"] as const)("%s 画笔单笔、反向箭头、局部橡皮与重做保留真实几何和历史",async(kind)=>{
 const {mount,vault}=fixture(emptyDrawing(),kind);mount();await openDrawing();
 fireEvent.click(screen.getByRole("button",{name:"画笔工具"}));pointer("down",20,20);pointer("move",180,20);pointer("up",180,20);
 await save(vault,d=>{expect(d.elements).toHaveLength(1);expect(d.elements[0].points!.at(-1)).toEqual([160,0]);});
 fireEvent.click(screen.getByRole("button",{name:"箭头工具"}));pointer("down",300,200);pointer("move",220,100);pointer("up",220,100);
 await save(vault,d=>{expect(d.elements[1].width).toBe(-80);expect(d.elements[1].height).toBe(-100);});
 fireEvent.click(screen.getByRole("button",{name:"橡皮工具"}));pointer("down",100,0);pointer("move",100,40);pointer("up",100,40);
 await save(vault,d=>{expect(d.elements.map(e=>e.type)).toEqual(["pencil","pencil","arrow"]);expect(d.elements[0].points!.at(-1)![0]).toBeLessThan(80);});
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await save(vault,d=>expect(d.elements).toHaveLength(2));
 fireEvent.click(screen.getByRole("button",{name:"重做白板"}));await save(vault,d=>expect(d.elements.map(e=>e.type)).toEqual(["pencil","pencil","arrow"]));
},15000);
it("取消局部擦除不会写入画布或丢失原笔迹",async()=>{
 const stroke={id:"pen",type:"pencil" as const,x:0,y:30,width:200,height:1,points:[[0,0],[200,0]] as [number,number][],strokeColor:"#123456",strokeWidth:2,link:{file:note},extra:{keep:true}};
 const doc={...emptyDrawing(),elements:[stroke]},source=serializeDrawing(doc),{mount,vault,api}=fixture(doc);mount();await openDrawing();
 fireEvent.click(screen.getByRole("button",{name:"橡皮工具"}));pointer("down",100,0);pointer("move",100,60);pointer("cancel",100,60);
 expect(vault.notes.get(path)!.content).toBe(source);expect(api.save).not.toHaveBeenCalled();
 pointer("down",100,0);pointer("move",100,60);pointer("up",100,60);
 await save(vault,d=>{expect(d.elements).toHaveLength(2);expect(d.elements.every(e=>e.link?.file===note&&JSON.stringify(e.extra)==='{"keep":true}')).toBe(true);});
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await save(vault,d=>expect(d.elements).toEqual([stroke]));
},12000);
it("文字输入的删除/IME不操作元素；全选、样式、字号、清空确认和历史可用",async()=>{
 const {mount,vault}=fixture();mount();await openDrawing();const input=await editDrawing("中文\n第二行");
 fireEvent.keyDown(input,{key:"Delete"});fireEvent.keyDown(input,{key:"z",ctrlKey:true,isComposing:true});
 expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);
 fireEvent.keyDown(input,{key:"Escape"});const region=screen.getByRole("region",{name:"绘图白板"});fireEvent.keyDown(region,{key:"a",ctrlKey:true});
 fireEvent.change(screen.getByLabelText("白板笔色"),{target:{value:"#123456"}});fireEvent.change(screen.getByLabelText("白板字号"),{target:{value:"32"}});
 await save(vault,d=>{expect(d.elements[0].strokeColor).toBe("#123456");expect(d.elements[0].fontSize).toBe(32);expect(d.elements[0].height).toBeGreaterThan(80);});
 fireEvent.click(screen.getByLabelText("白板更多操作"));fireEvent.click(screen.getByRole("button",{name:"清空白板"}));fireEvent.click(screen.getByRole("button",{name:"取消"}));
 expect(parseDrawing(vault.notes.get(path)!.content).elements).toHaveLength(1);
 fireEvent.click(screen.getByRole("button",{name:"清空白板"}));fireEvent.click(screen.getByRole("button",{name:"确认清空"}));await save(vault,d=>expect(d.elements).toHaveLength(0));
 fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await save(vault,d=>expect(d.elements[0].fontSize).toBe(32));
},12000);
it("工作区恢复白板视口/工具/选择，装载及缩放不写正文",async()=>{
 const {mount,api}=fixture(),key=workspaceStorageKey("web","drawing-test");
 localStorage.setItem(key,JSON.stringify({...emptyWorkspace(),tabs:[path],active:path,drawings:{[path]:{viewport:{x:40,y:80,zoom:.8},selected:["text"],tool:"pencil",style,grid:false}}}));
 mount();await screen.findByRole("region",{name:"绘图白板"});expect(screen.getByRole("button",{name:"白板恢复100%"}).textContent).toBe("80%");expect(screen.getByRole("button",{name:"画笔工具"}).getAttribute("aria-pressed")).toBe("true");
 fireEvent.click(screen.getByRole("button",{name:"放大白板"}));await act(async()=>new Promise(resolve=>setTimeout(resolve,350)));expect(api.save).not.toHaveBeenCalled();
 const saved=JSON.parse(localStorage.getItem(key)!);expect(saved.drawings[path].selected).toEqual(["text"]);expect(saved.drawings[path].viewport.zoom).toBeCloseTo(.96);
});
it("损坏白板/未知版本只读；损坏恢复草稿即使基准一致也不能自动覆盖磁盘",async()=>{
 const {mount,api,vault}=fixture();const original=vault.notes.get(path)!;vault.stored.set(path,{path,content:"{broken",baseVersion:original.version});
 mount();await openDrawing();fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));await screen.findByText(/白板 JSON 无法解析/);
 await act(async()=>new Promise(resolve=>setTimeout(resolve,1600)));expect(api.save).not.toHaveBeenCalled();expect(vault.notes.get(path)!.content).toBe(original.content);
 expect(screen.getByText("只读草稿")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"关闭标签 a.drawing"}));await screen.findByText(/无法关闭标签/);expect(vault.stored.get(path)!.content).toBe("{broken");
},10000);
it("网络失败仍可输入并重试，冲突关闭保留草稿和文件标签",async()=>{
 const {mount,api,vault}=fixture();api.save.mockRejectedValueOnce(new WorkspaceError("network","网络暂不可用"));
 mount();await openDrawing();const input=await editDrawing("失败期间的编辑");
 await screen.findAllByText(/网络暂不可用/,{}, {timeout:4000});fireEvent.change(input,{target:{value:"失败以后继续输入"}});await save(vault,d=>expect(d.elements[0].text).toBe("失败以后继续输入"));
 api.save.mockRejectedValue(new WorkspaceError("conflict","外部版本冲突"));fireEvent.change(input,{target:{value:"冲突分支"}});
 fireEvent.click(screen.getByRole("button",{name:"关闭标签 a.drawing"}));await screen.findByText(/无法关闭标签/);
 expect(vault.stored.get(path)?.content).toContain("冲突分支");expect(screen.getByRole("tab",{name:/^a.drawing/})).toBeTruthy();expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);
},12000);
it("关联笔记、树内拖入复用真实编辑器与未保存分支，不移动源文件",async()=>{
 const {mount,vault}=fixture(emptyDrawing());mount();const editor=await openMarkdown();act(()=>editor.dispatch({changes:{from:0,insert:"分支"}}));
 const region=await openDrawing(),tree=screen.getByRole("complementary",{name:"工作区侧栏"}),button=within(tree.querySelector<HTMLElement>(".file-tree-root")!).getByRole("button",{name:note});
 const transfer={setData:vi.fn(),effectAllowed:"",types:[vaultDragType],files:[] as File[],getData:vi.fn()};
 fireEvent.dragStart(button,{dataTransfer:transfer});transfer.getData.mockReturnValue(transfer.setData.mock.calls.find(([type])=>type===vaultDragType)![1]);
 fireEvent.drop(region,{dataTransfer:transfer,clientX:200,clientY:100});
 fireEvent.click(screen.getByRole("button",{name:"打开关联笔记"}));await screen.findByRole("tab",{name:/^笔记.md/,selected:true});
 expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector(".cm-editor")!)).toBe(editor);expect(editor.state.doc.toString()).toBe("分支原笔记");expect(vault.notes.has(note)).toBe(true);
 fireEvent.click(screen.getByRole("tab",{name:/^a.drawing/}));fireEvent.click(screen.getByRole("button",{name:"关联笔记"}));
 fireEvent.click(within(screen.getByRole("dialog",{name:"关联白板笔记"})).getByRole("button",{name:"目标.md"}));
 await save(vault,d=>expect(d.elements[0].link?.file).toBe("目标.md"));
},12000);
it("改名维护白板/Markdown/画布入链，白板另存保留原文件和关联",async()=>{
 const doc={...emptyDrawing(),elements:[{...createDrawingElement("text",{x:30,y:40},{x:30,y:40},style,"text"),text:"标题",link:{file:"目标.md"}}]};
 const {mount,vault}=fixture(doc);vault.put("入链.md","[白板](绘图/a.drawing)");vault.put(canvasPath,serializeCanvas({nodes:[createCanvasNode("file",{x:0,y:0},{file:path})],edges:[]}));
 mount();await openDrawing();fireEvent.keyDown(screen.getByRole("button",{name:"目标.md"}),{key:"F2"});
 let input=await screen.findByRole("textbox",{name:"重命名 目标.md"});fireEvent.change(input,{target:{value:"新目标.md"}});fireEvent.keyDown(input,{key:"Enter"});
 await waitFor(()=>expect(parseDrawing(vault.notes.get(path)!.content).elements[0].link?.file).toBe("新目标.md"));
 fireEvent.keyDown(screen.getByRole("button",{name:"a.drawing"}),{key:"F2"});input=await screen.findByRole("textbox",{name:"重命名 a.drawing"});fireEvent.change(input,{target:{value:"b.drawing"}});fireEvent.keyDown(input,{key:"Enter"});
 await screen.findByRole("tab",{name:"b.drawing",selected:true});expect(vault.notes.get("入链.md")!.content).toContain("b.drawing");expect(vault.notes.get(canvasPath)!.content).toContain("绘图/b.drawing");
 fireEvent.click(screen.getByRole("button",{name:"另存为"}));input=await screen.findByDisplayValue("绘图/恢复的白板.drawing");fireEvent.change(input,{target:{value:"副本.drawing"}});fireEvent.submit(input.closest("form")!);
 await screen.findByRole("tab",{name:"副本.drawing",selected:true});expect(vault.notes.has("绘图/b.drawing")).toBe(true);expect(parseDrawing(vault.notes.get("副本.drawing")!.content).elements[0].link?.file).toBe("新目标.md");
},15000);
it("SVG原生失败可重试，捕获快照不保存或删除新输入，输入框保持",async()=>{
 const {mount,runtime,api}=fixture(undefined,"desktop");const output=vi.fn<NonNullable<WorkspaceRuntime["saveDrawingSvg"]>>();runtime.saveDrawingSvg=output;
 let reject!:(cause:Error)=>void;output.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;})).mockResolvedValueOnce("D:/输出.svg");
 mount();await openDrawing();const input=await editDrawing("导出快照");
 fireEvent.click(screen.getByLabelText("白板更多操作"));fireEvent.click(screen.getByRole("button",{name:"导出 SVG 快照"}));await waitFor(()=>expect(reject).toBeTypeOf("function"));
 expect(output.mock.calls[0][0]).toContain("导出快照");fireEvent.change(input,{target:{value:"导出期间继续输入"}});
 await act(async()=>reject(new Error("目标被占用")));await screen.findAllByText(/目标被占用/);
 expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);expect(input.value).toBe("导出期间继续输入");
 fireEvent.click(screen.getByRole("button",{name:"导出 SVG 快照"}));await waitFor(()=>expect(output).toHaveBeenCalledTimes(2));expect(output.mock.calls[1][0]).toContain("导出期间继续输入");
 expect(api.removeDraft).not.toHaveBeenCalled();
},10000);
it("网页SVG失败重试并释放临时URL，隐藏白板不空转重绘",async()=>{
 const {mount,api}=fixture();const create=vi.fn((_blob:Blob)=>"blob:drawing"),revoke=vi.fn();
 vi.stubGlobal("URL",class extends URL{static createObjectURL=create;static revokeObjectURL=revoke;});
 const click=vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementationOnce(()=>{throw new Error("下载被阻止");}).mockImplementation(()=>{});
 mount();await openDrawing();await waitFor(()=>expect(context.fillRect).toHaveBeenCalled());
 const draws=vi.mocked(context.clearRect).mock.calls.length;await act(async()=>new Promise(resolve=>setTimeout(resolve,100)));expect(vi.mocked(context.clearRect).mock.calls.length).toBe(draws);
 fireEvent.click(screen.getByLabelText("白板更多操作"));fireEvent.click(screen.getByRole("button",{name:"导出 SVG 快照"}));await waitFor(()=>expect(create).toHaveBeenCalledTimes(1));
 await screen.findAllByText(/下载被阻止/);expect(revoke).toHaveBeenCalledWith("blob:drawing");
 fireEvent.click(screen.getByRole("button",{name:"导出 SVG 快照"}));await waitFor(()=>expect(create).toHaveBeenCalledTimes(2));
 expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);expect(click).toHaveBeenCalledTimes(2);expect(api.save).not.toHaveBeenCalled();
 fireEvent(window,new Event("pagehide"));expect(revoke).toHaveBeenCalledWith("blob:drawing");
 await openMarkdown();const hiddenDraws=vi.mocked(context.clearRect).mock.calls.length;await act(async()=>new Promise(resolve=>setTimeout(resolve,100)));expect(vi.mocked(context.clearRect).mock.calls.length).toBe(hiddenDraws);
},10000);

it("新建白板避让同名并使用受控模型，旧文件不覆盖",async()=>{
 const {mount,vault}=fixture();mount();await openDrawing();
 fireEvent.contextMenu(screen.getByRole("button",{name:"a.drawing"}));fireEvent.click(screen.getByRole("menuitem",{name:"新建绘图白板"}));
 let input=await screen.findByDisplayValue("未命名白板.drawing");fireEvent.submit(input.closest("form")!);
 await screen.findByRole("tab",{name:"未命名白板.drawing",selected:true});
 expect(parseDrawing(vault.notes.get("绘图/未命名白板.drawing")!.content)).toEqual(emptyDrawing());
 fireEvent.contextMenu(screen.getByRole("button",{name:"a.drawing"}));fireEvent.click(screen.getByRole("menuitem",{name:"新建绘图白板"}));
 input=await screen.findByDisplayValue("未命名白板 2.drawing");fireEvent.submit(input.closest("form")!);
 await screen.findByRole("tab",{name:"未命名白板 2.drawing",selected:true});expect(vault.notes.has("绘图/未命名白板.drawing")).toBe(true);
});
it.each(["{bad",JSON.stringify({...emptyDrawing(),version:2})])("坏磁盘白板或未知版本只读，不伪装为空白：%s",async raw=>{
 const {mount,api,vault}=fixture(raw);mount();fireEvent.click(await screen.findByRole("button",{name:"a.drawing"}));
 await screen.findByText("白板暂时只读");expect(screen.queryByLabelText("白板绘制区域")).toBeNull();
 fireEvent.click(screen.getByText("查看原始 JSON"));expect(screen.getByText(raw,{selector:"pre"})).toBeTruthy();expect(api.save).not.toHaveBeenCalled();expect(vault.notes.get(path)!.content).toBe(raw);
});
it("有效冲突草稿明确恢复后保留原盘，另存为白板恢复分支",async()=>{
 const {mount,api,vault}=fixture(),original=vault.notes.get(path)!,draft=parseDrawing(original.content);draft.elements[0].text="恢复的本地分支";
 vault.stored.set(path,{path,content:serializeDrawing(draft),baseVersion:original.version});vault.put(path,original.content.replace("初始文字","外部更新"));
 mount();await openDrawing();expect(screen.getByRole("button",{name:"文字工具"})).toHaveProperty("disabled",true);fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));
 await waitFor(()=>expect(screen.getByRole("button",{name:"文字工具"})).toHaveProperty("disabled",false));
 const input=await editDrawing("恢复后继续写");expect(input.value).toBe("恢复后继续写");
 expect(vault.notes.get(path)!.content).toContain("外部更新");expect(api.save).not.toHaveBeenCalled();
 fireEvent.click(screen.getAllByRole("button",{name:"另存为"})[0]);const target=await screen.findByDisplayValue("绘图/恢复的白板.drawing");
 fireEvent.change(target,{target:{value:"恢复副本.drawing"}});fireEvent.submit(target.closest("form")!);
 await screen.findByRole("tab",{name:"恢复副本.drawing",selected:true});expect(parseDrawing(vault.notes.get("恢复副本.drawing")!.content).elements[0].text).toBe("恢复后继续写");expect(vault.notes.get(path)!.content).toContain("外部更新");
},12000);
it("标准Markdown链接打开白板，命令面板关闭后可导出SVG",async()=>{
 const {mount,api,runtime,vault}=fixture(undefined,"desktop");vault.put(note,"[打开草图](绘图/a.drawing)");runtime.saveDrawingSvg=vi.fn(async()=>null);
 mount();await openMarkdown();fireEvent.click(screen.getByRole("button",{name:"阅读"}));fireEvent.click(await screen.findByRole("link",{name:"打开草图"}));
 await screen.findByRole("region",{name:"绘图白板"});expect(api.openAttachment).not.toHaveBeenCalled();
 fireEvent.keyDown(window,{key:"P",ctrlKey:true,shiftKey:true});const palette=await screen.findByRole("dialog",{name:"命令面板"});
 fireEvent.change(within(palette).getByRole("textbox",{name:"命令面板"}),{target:{value:"导出白板 SVG"}});
 fireEvent.click(within(palette).getByRole("option",{name:/导出白板 SVG 快照/}));await waitFor(()=>expect(runtime.saveDrawingSvg).toHaveBeenCalledTimes(1));expect(screen.queryByRole("dialog",{name:"命令面板"})).toBeNull();
},10000);
it("切库等待旧画布附件和白板草稿，新知识库不接收旧输入",async()=>{
 const {mount,api,vault}=fixture(undefined,"desktop");mount();fireEvent.click(await screen.findByRole("button",{name:"c.canvas"}));
 const canvasRegion=await screen.findByRole("region",{name:"知识画布"});let complete!:(value:string)=>void;
 api.importAttachmentData.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
 fireEvent.paste(canvasRegion,{clipboardData:{files:[new File(["image"],"图.png",{type:"image/png"})]}});await waitFor(()=>expect(complete).toBeTypeOf("function"));
 await openDrawing();await editDrawing("切库前最新白板输入");
 const next=new MemoryVault();next.put("next.md","新知识库");api.chooseDirectory.mockResolvedValue("next-vault");
 api.selectVault.mockImplementation(async()=>{api.entries=next.entries;api.read.mockImplementation(next.read);api.save.mockImplementation(next.save);api.drafts=next.drafts;api.writeDraft.mockImplementation(next.writeDraft);return {vault:"next-vault",id:"next-test",error:null};});
 fireEvent.click(screen.getByRole("button", { name: /知识库选项/ }));
 fireEvent.click(screen.getByRole("button", { name: "打开其他知识库" }));
 await act(async()=>Promise.resolve());expect(api.selectVault).not.toHaveBeenCalled();
 await act(async()=>complete("attachments/图.png"));await waitFor(()=>expect(api.selectVault).toHaveBeenCalledWith("next-vault"));
 expect(parseDrawing(vault.stored.get(path)!.content).elements[0].text).toBe("切库前最新白板输入");
 fireEvent.click(await screen.findByRole("button",{name:"next.md"}));await screen.findByRole("tab",{name:"next.md",selected:true});expect(screen.queryByRole("region",{name:"绘图白板"})).toBeNull();expect(next.stored.has(path)).toBe(false);expect(next.notes.get("next.md")!.content).toBe("新知识库");
},15000);
