// @vitest-environment jsdom
import "../test/codemirror-dom";
import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {EditorView} from "@codemirror/view";
import DesktopApp from "./desktop-app";
import {MemoryVault} from "../test/memory-vault";
import {WorkspaceRuntimeContext,type WorkspaceRuntime} from "../lib/workspace-runtime";
import {WorkspaceError} from "../lib/api-error";
import type {WorkspaceApi} from "../lib/vault-api";
import {createCanvasNode,serializeCanvas} from "../lib/canvas-document";
import {emptyDrawing,serializeDrawing} from "../lib/drawing-document";
import {prependTask,taskCategoryMarker} from "../lib/tasks";

vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
const cases=[
 {name:"笔记",path:"文档.md",source:(text:string)=>text},
 {name:"画布",path:"空间.canvas",source:(text:string)=>serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{id:"text",text})],edges:[]})},
 {name:"白板",path:"绘图.drawing",source:(text:string)=>serializeDrawing({...emptyDrawing(),elements:[{id:"text",type:"text",x:30,y:40,width:200,height:60,strokeColor:"#111111",fontSize:20,text}]})},
];
beforeEach(()=>{
 localStorage.clear();
 vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal("PointerEvent",class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
 const ctx={save:vi.fn(),restore:vi.fn(),setTransform:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),strokeRect:vi.fn(),translate:vi.fn(),scale:vi.fn(),setLineDash:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),fill:vi.fn(),arc:vi.fn(),ellipse:vi.fn(),closePath:vi.fn(),fillText:vi.fn(),measureText:vi.fn((s:string)=>({width:[...s].length*18}))};
 vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(()=>ctx as unknown as CanvasRenderingContext2D);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function fixture(kind:"desktop"|"web"){
 const vault=new MemoryVault();
 for(const item of cases)vault.put(item.path,item.source("原文"));
 vault.put("其他.md","另一篇原文");vault.put("第三篇.md","第三篇原文");
 vault.put("任务/工作/开发.md",prependTask(taskCategoryMarker+"\n\n# 开发\n","流程核对").content);
 const api={...vault,status:async()=>({vault:"stage4-finish",id:"stage4-finish",error:null}),
  read:vi.fn(async(path:string)=>{if(!vault.notes.has(path))throw new WorkspaceError("not_found","文件不存在");return vault.read(path);}),
  save:vi.fn(vault.save),writeDraft:vi.fn(vault.writeDraft),removeDraft:vi.fn(vault.removeDraft),
  chooseDirectory:vi.fn(),selectVault:vi.fn(),createVault:vi.fn(),chooseFile:vi.fn(),importAttachment:vi.fn(),importAttachmentData:vi.fn(async()=>"attachments/image.png"),image:vi.fn(async()=>"data:image/png;base64,AQID"),openItem:vi.fn(),openAttachment:vi.fn(),openExternal:vi.fn(),remove:vi.fn()} satisfies WorkspaceApi;
 let closeHandler:((event:{preventDefault:()=>void})=>Promise<void>)|undefined;
 const native={destroy:vi.fn(async()=>{}),onCloseRequested:vi.fn(async(handler:NonNullable<typeof closeHandler>)=>{closeHandler=handler;return ()=>{closeHandler=undefined;};})};
 const runtime:WorkspaceRuntime={kind,api,...(kind==="desktop"?{nativeWindow:native}:{})};
 const mount=()=>render(<WorkspaceRuntimeContext.Provider value={runtime}><DesktopApp/></WorkspaceRuntimeContext.Provider>);
 return {vault,api,runtime,mount,native,closeWindow:()=>closeHandler!({preventDefault:vi.fn()})};
}
function tab(path:string){return screen.getAllByRole("tab").find(button=>button.getAttribute("title")===path) as HTMLButtonElement;}
async function open(path:string){
 const buttons=await screen.findAllByRole("button",{name:path});
 fireEvent.click(buttons.find(button=>button.closest(".file-tree-root"))!);
 await waitFor(()=>{expect(tab(path)?.getAttribute("aria-selected")).toBe("true");expect(tab(path).disabled).toBe(false);});
 if(path.endsWith(".md"))await waitFor(()=>expect(screen.getByRole("tabpanel").querySelector(".cm-editor")).toBeTruthy());
}
function view(){return EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!;}
function replace(view:EditorView,value:string){act(()=>view.dispatch({changes:{from:0,to:view.state.doc.length,insert:value},selection:{anchor:value.length},userEvent:"input.type"}));}
async function edit(path:string,value:string){
 if(path.endsWith(".md")){const field=view();replace(field,value);return field;}
 if(path.endsWith(".canvas"))fireEvent.doubleClick(screen.getByRole("region",{name:"知识画布"}).querySelector<HTMLElement>('[data-canvas-node="text"] .canvas-node-body')!);
 else fireEvent.doubleClick(screen.getByLabelText("白板绘制区域"),{clientX:70,clientY:55});
 const field=await screen.findByRole("textbox",{name:path.endsWith(".canvas")?"画布文本":"白板文字"}) as HTMLTextAreaElement;
 fireEvent.change(field,{target:{value}});return field;
}
describe.each(["desktop","web"] as const)("阶段4编辑与恢复 %s",(kind)=>{
 it.each(cases)("$name 的草稿清理迟到不会切回文件或删除另一标签的恢复状态",async(item)=>{
  const {vault,api,mount}=fixture(kind),done=deferred();
  for(const path of [item.path,"其他.md"]){const base=vault.notes.get(path)!;vault.stored.set(path,{path,content:path===item.path?item.source("旧草稿"):"其他草稿",baseVersion:base.version});}
  api.removeDraft.mockImplementation(async(path)=>{if(path===item.path)await done.promise;await vault.removeDraft(path);});
  mount();await open("其他.md");await open(item.path);
  fireEvent.click(screen.getByRole("button",{name:"丢弃草稿"}));
  fireEvent.click(within(await screen.findByRole("dialog",{name:"丢弃恢复草稿？"})).getByRole("button",{name:"确定"}));
  await waitFor(()=>expect(api.removeDraft).toHaveBeenCalledWith(item.path));
  fireEvent.click(tab("其他.md"));
  await act(async()=>{done.resolve();await done.promise;});
  await waitFor(()=>expect(vault.stored.has(item.path)).toBe(false));
  expect(screen.getByRole("tab",{selected:true}).textContent).toContain("其他.md");
  expect(screen.getByText("发现恢复草稿：其他.md")).toBeTruthy();
  expect(screen.getByRole("button",{name:"恢复草稿"})).toBeTruthy();
  expect(vault.stored.get("其他.md")?.content).toBe("其他草稿");
  expect(screen.getByRole("tabpanel").querySelector(".cm-content")?.textContent).toBe("另一篇原文");
 });
 it.each(cases)("$name 丢弃草稿前重读最新磁盘，读取失败时保留草稿",async(item)=>{
  const {vault,api,mount}=fixture(kind),base=vault.notes.get(item.path)!;
  vault.stored.set(item.path,{path:item.path,content:item.source("待确认草稿"),baseVersion:base.version});
  mount();await open(item.path);
  vault.put(item.path,item.source("外部最新内容"));
  api.read.mockRejectedValueOnce(new WorkspaceError("permission","暂时无法读取"));
  fireEvent.click(screen.getByRole("button",{name:"丢弃草稿"}));
  fireEvent.click(within(await screen.findByRole("dialog",{name:"丢弃恢复草稿？"})).getByRole("button",{name:"确定"}));
  await screen.findByText(/暂时无法读取/);
  expect(vault.stored.has(item.path)).toBe(true);
  expect(screen.getByRole("button",{name:"恢复草稿"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"丢弃草稿"}));
  fireEvent.click(within(await screen.findByRole("dialog",{name:"丢弃恢复草稿？"})).getByRole("button",{name:"确定"}));
  await waitFor(()=>expect(screen.queryByRole("button",{name:"恢复草稿"})).toBeNull());
  fireEvent.click(screen.getByRole("button",{name:"另存为"}));
  const dialog=await screen.findByRole("dialog",{name:/另存为新/});
  const copy="副本"+item.path.slice(item.path.lastIndexOf("."));
  fireEvent.change(within(dialog).getByRole("textbox"),{target:{value:copy}});
  fireEvent.click(within(dialog).getByRole("button",{name:"确定"}));
  await waitFor(()=>expect(vault.notes.get(copy)?.content).toBe(item.source("外部最新内容")));
 });
 it.each(cases)("$name 保存失败状态跨标签保留，重试中连续输入不丢",async(item)=>{
  const {vault,api,mount}=fixture(kind);let fail=true;const delayed=deferred();
  api.save.mockImplementation(async(path,content,version)=>{if(fail)throw new WorkspaceError("network","暂时断开");await delayed.promise;return vault.save(path,content,version);});
  mount();await open(item.path);const control=await edit(item.path,"第一段输入");
  fireEvent.click(screen.getByRole("button",{name:"保存"}));
  await screen.findByText("保存失败，待重试");
  await open("其他.md");fireEvent.click(tab(item.path));
  expect(screen.getByText("保存失败，待重试")).toBeTruthy();
  expect((await edit(item.path,"第二段输入"))).toBe(control);
  fail=false;fireEvent.click(screen.getByRole("button",{name:"保存"}));
  await screen.findByText("正在保存…");
  await edit(item.path,"保存中继续输入");
  await act(async()=>{delayed.resolve();await delayed.promise;});
  await waitFor(()=>expect(vault.notes.get(item.path)?.content).toContain("第二段输入"));
  expect(await edit(item.path,"保存中继续输入")).toBe(control);
  fireEvent.click(screen.getByRole("button",{name:"保存"}));
  await waitFor(()=>expect(vault.notes.get(item.path)?.content).toContain("保存中继续输入"));
  await waitFor(()=>expect(screen.getByText("已保存")).toBeTruthy());
  expect(screen.queryByText("保存失败，待重试")).toBeNull();
 });
 it("任务备注中文组字中的 Escape 不关闭详情，图谱往返仍保留输入",async()=>{
  const {mount,vault}=fixture(kind);mount();await screen.findByRole("button",{name:"文档.md"});
  fireEvent.click(screen.getByRole("button",{name:"任务管理"}));
  fireEvent.click(await screen.findByRole("button",{name:"开发"}));
  await screen.findByRole("heading",{name:"开发"});
  fireEvent.click(await screen.findByRole("button",{name:"流程核对"}));
  const input=await screen.findByLabelText("Markdown 备注") as HTMLTextAreaElement;
  input.focus();fireEvent.change(input,{target:{value:"- [ ] 组字中的备注"}});
  input.setSelectionRange(5,5);input.scrollTop=30;
  fireEvent.keyDown(input,{key:"Escape",isComposing:true});
  expect(screen.getByLabelText("Markdown 备注")).toBe(input);
  fireEvent.click(screen.getByRole("button",{name:"知识图谱"}));
  await screen.findByRole("img",{name:"知识图谱画布"});
  fireEvent.click(screen.getByRole("tab",{name:/^任务管理/}));
  expect(screen.getByLabelText("Markdown 备注")).toBe(input);
  expect(input.value).toBe("- [ ] 组字中的备注");expect(input.selectionStart).toBe(5);
  fireEvent.click(screen.getByRole("button",{name:"保存"}));
  await waitFor(()=>expect(vault.notes.get("任务/工作/开发.md")?.content).toContain("组字中的备注"));
 });
 it.each(cases)("$name 冲突和待确认草稿明确暂停保存，命令面板不提供无效保存",async(item)=>{
  const {api,mount,vault}=fixture(kind);mount();await open(item.path);await edit(item.path,"冲突中的输入");
  vault.put(item.path,item.source("磁盘外部版本"));
  fireEvent.click(screen.getByRole("button",{name:"保存"}));
  await screen.findByText("保存需处理");
  expect((screen.getByRole("button",{name:"保存"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(window,{key:"P",ctrlKey:true,shiftKey:true});
  const command=within(await screen.findByRole("dialog",{name:"命令面板"})).getByRole("option",{name:/保存当前文档/}) as HTMLButtonElement;
  expect(command.disabled).toBe(true);expect(command.textContent).toContain("保存需处理");
  fireEvent.keyDown(command,{key:"Escape"});
  fireEvent.click(screen.getByRole("button",{name:"关闭标签 "+item.path}));
  await screen.findByText(/无法关闭标签/);
  expect(tab(item.path)).toBeTruthy();expect(vault.notes.get(item.path)?.content).toBe(item.source("磁盘外部版本"));
  await waitFor(()=>expect(vault.stored.get(item.path)?.content).toContain("冲突中的输入"));
 });
 it("新建入口、更多菜单和快速打开一致，组字中的 Escape 不丢新文件名",async()=>{
  const {mount,vault}=fixture(kind);mount();
  const empty=await screen.findByRole("group",{name:"新建文档"});
  fireEvent.click(within(empty).getByRole("button",{name:"创建知识画布"}));
  const create=await screen.findByRole("dialog",{name:"新建知识画布"});
  const input=within(create).getByRole("textbox");
  fireEvent.change(input,{target:{value:"入口画布.canvas"}});fireEvent.keyDown(input,{key:"Escape",isComposing:true});
  expect(screen.getByRole("dialog",{name:"新建知识画布"})).toBe(create);
  fireEvent.click(within(create).getByRole("button",{name:"确定"}));
  await waitFor(()=>expect(vault.notes.has("入口画布.canvas")).toBe(true));
  await waitFor(()=>expect(tab("入口画布.canvas").disabled).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"所选文件的操作"}));
  fireEvent.click(screen.getByRole("menuitem",{name:"新建绘图白板"}));
  const drawing=await screen.findByRole("dialog",{name:"新建绘图白板"});
  fireEvent.change(within(drawing).getByRole("textbox"),{target:{value:"入口白板.drawing"}});
  fireEvent.click(within(drawing).getByRole("button",{name:"确定"}));
  await waitFor(()=>expect(tab("入口白板.drawing")?.disabled).toBe(false));
  fireEvent.click(screen.getByLabelText("文档更多操作"));
  expect(screen.getByRole("button",{name:"导出白板 SVG 快照"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"导出（HTML / PDF）"})).toBeNull();
  fireEvent.keyDown(window,{key:"p",ctrlKey:true});
  const quick=await screen.findByRole("dialog",{name:"快速打开文档"});
  expect(within(quick).getByText("知识画布 · 入口画布.canvas")).toBeTruthy();
  expect(within(quick).getByText("绘图白板 · 入口白板.drawing")).toBeTruthy();
  fireEvent.click(within(quick).getByRole("option",{name:/入口画布.canvas/}));
  await waitFor(()=>expect(tab("入口画布.canvas").getAttribute("aria-selected")).toBe("true"));
  expect(screen.getAllByRole("tab")).toHaveLength(2);
 });
 it("原文件已删除时明确丢弃草稿，移除失效标签并回到原编辑器",async()=>{
  const {mount,vault}=fixture(kind),lost=cases[2],base=vault.notes.get(lost.path)!;
  vault.notes.delete(lost.path);vault.stored.set(lost.path,{path:lost.path,content:lost.source("孤立草稿"),baseVersion:base.version});
  mount();await open("其他.md");const original=view();replace(original,"另一篇继续输入");
  fireEvent.click(await screen.findByRole("button",{name:lost.path}));
  await screen.findByRole("button",{name:"丢弃草稿"});
  fireEvent.click(screen.getByRole("button",{name:"丢弃草稿"}));
  fireEvent.click(within(await screen.findByRole("dialog",{name:"丢弃恢复草稿？"})).getByRole("button",{name:"确定"}));
  await waitFor(()=>expect(tab(lost.path)).toBeUndefined());
  expect(tab("其他.md").getAttribute("aria-selected")).toBe("true");
  expect(view()).toBe(original);expect(original.state.doc.toString()).toBe("另一篇继续输入");
  expect(vault.notes.has(lost.path)).toBe(false);expect(vault.stored.has(lost.path)).toBe(false);
 });
 it("文件树重命名在中文组字期间不提交或取消",async()=>{
  const {mount,vault}=fixture(kind);mount();await open("文档.md");
  fireEvent.keyDown(screen.getByRole("button",{name:"文档.md"}),{key:"F2"});
  const field=await screen.findByRole("textbox",{name:"重命名 文档.md"});
  fireEvent.change(field,{target:{value:"输入中的新名称.md"}});
  fireEvent.keyDown(field,{key:"Enter",isComposing:true});fireEvent.keyDown(field,{key:"Escape",isComposing:true});
  expect(screen.getByRole("textbox",{name:"重命名 文档.md"})).toBe(field);
  expect(vault.notes.has("文档.md")).toBe(true);expect(vault.notes.has("输入中的新名称.md")).toBe(false);
  fireEvent.keyDown(field,{key:"Escape"});expect(screen.queryByRole("textbox",{name:"重命名 文档.md"})).toBeNull();
 });
 it("三类文档草稿写入失败时批量关闭保留输入，恢复存储后重启可逐份恢复",async()=>{
  const {api,mount,vault,closeWindow}=fixture(kind);
  api.save.mockRejectedValue(new WorkspaceError("network","断线"));
  api.writeDraft.mockRejectedValue(new WorkspaceError("storage","草稿空间不足"));
  mount();const controls=[];
  for(const item of cases){await open(item.path);controls.push(await edit(item.path,"恢复输入"+item.name));}
  fireEvent.contextMenu(tab(cases[2].path));fireEvent.click(screen.getByRole("menuitem",{name:"关闭全部标签"}));
  await screen.findByText(/无法关闭标签/);expect(screen.getAllByRole("tab")).toHaveLength(3);
  for(const [index,item] of cases.entries()){fireEvent.click(tab(item.path));expect(await edit(item.path,"恢复输入"+item.name)).toBe(controls[index]);}
  api.writeDraft.mockImplementation(vault.writeDraft);
  if(kind==="desktop")await act(async()=>{await closeWindow();});
  else {vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");act(()=>document.dispatchEvent(new Event("visibilitychange")));}
  await waitFor(()=>{for(const item of cases)expect(vault.stored.get(item.path)?.content).toContain("恢复输入"+item.name);});
  cleanup();mount();await screen.findByRole("button",{name:"恢复草稿"});
  api.save.mockImplementation(vault.save);
  for(const item of cases){
   fireEvent.click(tab(item.path));expect(screen.getByText("待确认草稿")).toBeTruthy();
   fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));
   fireEvent.click(screen.getByRole("button",{name:"保存"}));
   await waitFor(()=>expect(vault.notes.get(item.path)?.content).toContain("恢复输入"+item.name));
  }
 });
});
it("网页画布图片在途且源文件干净时，离开页面仍触发保护",async()=>{
 const {api,mount,vault}=fixture("web"),pending=deferred();
 api.importAttachmentData.mockImplementation(async()=>{await pending.promise;return "attachments/image.png";});
 mount();await open("空间.canvas");
 const input=screen.getByLabelText("导入画布图片");
 fireEvent.change(input,{target:{files:[new File(["image"],"图片.png",{type:"image/png"})]}});
 await waitFor(()=>expect(api.importAttachmentData).toHaveBeenCalled());
 const leaving=new Event("beforeunload",{cancelable:true});act(()=>window.dispatchEvent(leaving));
 expect(leaving.defaultPrevented).toBe(true);
 await act(async()=>{pending.resolve();await pending.promise;});
 await waitFor(()=>expect(vault.stored.get("空间.canvas")?.content).toContain("image.png"));
});
it("原生关闭在草稿不可写时保留全部编辑，重试持久化后才交给窗口关闭接口",async()=>{
 const {api,mount,native,closeWindow,vault}=fixture("desktop");mount();
 for(const item of cases){await open(item.path);await edit(item.path,"关闭保护"+item.name);}
 api.writeDraft.mockRejectedValue(new WorkspaceError("storage","无法保存草稿"));
 await act(async()=>{await closeWindow();});
 expect(native.destroy).not.toHaveBeenCalled();expect(screen.getAllByRole("tab")).toHaveLength(3);
 api.writeDraft.mockImplementation(vault.writeDraft);
 await act(async()=>{await closeWindow();});
 expect(native.destroy).toHaveBeenCalledTimes(1);
 for(const item of cases)expect(vault.stored.get(item.path)?.content).toContain("关闭保护"+item.name);
});


describe.each(["desktop","web"] as const)("统一文件快捷键 %s",(kind)=>{
 it.each(cases)("$name 的 Ctrl+S 保存当前快照，Ctrl+Shift+S 只打开一次另存",async(item)=>{
  const {api,mount,vault}=fixture(kind);mount();await open(item.path);
  const field=await edit(item.path,"快捷键输入");
  const target=field instanceof EditorView?field.contentDOM:field;
  expect(fireEvent.keyDown(target,{key:"s",ctrlKey:true})).toBe(false);
  await waitFor(()=>expect(vault.notes.get(item.path)?.content).toContain("快捷键输入"));
  expect(api.save).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(target,{key:"S",ctrlKey:true,shiftKey:true});
  const dialog=await screen.findByRole("dialog",{name:/另存为新/});
  fireEvent.click(within(dialog).getByRole("button",{name:"取消"}));
  expect(screen.queryByRole("dialog",{name:/另存为新/})).toBeNull();
  expect(vault.notes.size).toBe(6);
 });
});
