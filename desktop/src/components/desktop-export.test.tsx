// @vitest-environment jsdom
import "../test/codemirror-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import { MemoryVault } from "../test/memory-vault";
import { WorkspaceRuntimeContext, type WorkspaceRuntime } from "../lib/workspace-runtime";
import type { WorkspaceApi } from "../lib/vault-api";
import { WorkspaceError } from "../lib/api-error";
import { downloadExportHtml,readyExportFrame } from "../lib/export-output";
import {emptyDrawing,parseDrawing,serializeDrawing,defaultDrawingStyle} from "../lib/drawing-document";
import {createDrawingElement} from "../lib/drawing-geometry";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>'<svg xmlns="http://www.w3.org/2000/svg"/>'}));
vi.mock("../lib/export-output",()=>({readyExportFrame:vi.fn(async()=>{}),downloadExportHtml:vi.fn()}));
vi.mock("../lib/export-resources",async(importOriginal)=>{
 const original=await importOriginal<typeof import("../lib/export-resources")>();
 return {...original,decodeExportImage:async()=>{}};
});
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const path="项目/a.md";
function fixture(content="原文",output?:WorkspaceRuntime["saveExportHtml"],saveVaultZip?:WorkspaceRuntime["saveVaultZip"]) {
 const vault=new MemoryVault();vault.put(path,content);vault.put("其他.md","另一篇");
 const api={...vault,status:async()=>({vault:"export-test",id:"export-test",error:null}),read:vi.fn(vault.read),save:vi.fn(vault.save),writeDraft:vi.fn(vault.writeDraft),removeDraft:vi.fn(vault.removeDraft),selectVault:vi.fn(),createVault:vi.fn(),chooseDirectory:vi.fn(),chooseFile:vi.fn(),importAttachment:vi.fn(),importAttachmentData:vi.fn(async()=>"attachments/图片.png"),image:vi.fn(async()=>"data:image/png;base64,AQID"),remove:vi.fn(),openAttachment:vi.fn(),openItem:vi.fn(),openExternal:vi.fn()} satisfies WorkspaceApi;
 const mount=()=>render(<WorkspaceRuntimeContext.Provider value={{kind:output?"desktop":"web",api,saveExportHtml:output,saveVaultZip}}><DesktopApp/></WorkspaceRuntimeContext.Provider>);
 return {vault,api,mount};
}
async function open(name="a.md") {
 fireEvent.click(await screen.findByRole("button",{name}));
 await screen.findByRole("tab",{name:(label)=>label.startsWith(name),selected:true});
 return waitFor(()=>EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!);
}
function edit(view:EditorView,text:string) { act(()=>view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text},selection:{anchor:text.length},userEvent:"input.type"})); }
async function start() {
 fireEvent.click(screen.getByLabelText("文档更多操作"));
 fireEvent.click(screen.getByRole("button",{name:"导出（HTML / PDF）"}));
 return screen.findByRole("dialog",{name:"本地导出"});
}
async function ready(includes?:string) {
 const frame=await waitFor(()=>{
  const element=screen.getByTitle("导出文档预览") as HTMLIFrameElement;
  if(includes)expect(element.srcdoc.includes(includes)).toBe(true);
  return element;
 });
 act(()=>{
  const doc=frame.contentDocument!;
  doc.open();doc.write(frame.srcdoc);doc.close();fireEvent.load(frame);
 });
 await waitFor(()=>expect((screen.getByRole("button",{name:"导出 HTML"}) as HTMLButtonElement).disabled).toBe(false));
 return frame;
}

function openSettingsExports() {
  fireEvent.click(screen.getByRole("button", { name: "软件设置" }));
  const dialog = within(screen.getByRole("dialog", { name: "软件设置" }));
  fireEvent.click(dialog.getByRole("button", { name: "导出与备份" }));
  return dialog;
}

it("设置里的导出操作复用单篇、合并预览和整库 ZIP", async () => {
 const saveZip = vi.fn(async () => "D:/导出/noto-vault.zip");
 const { mount } = fixture("原文", vi.fn(), saveZip);
 mount();
 await screen.findByRole("button", { name: "a.md" });
 expect((openSettingsExports().getByRole("button", { name: /^导出当前笔记/ }) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "完成" }));

 const editor = await open();
 fireEvent.click(openSettingsExports().getByRole("button", { name: /^导出当前笔记/ }));
 await within(await screen.findByRole("dialog", { name: "本地导出" })).findByText(path);
 expect(screen.queryByRole("dialog", { name: "软件设置" })).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "关闭导出预览" }));
 await waitFor(() => expect(document.activeElement).toBe(editor.contentDOM));

 fireEvent.click(openSettingsExports().getByRole("button", { name: /^多篇合并导出/ }));
 const picker = await screen.findByRole("dialog", { name: "选择合并导出的笔记" });
 expect(document.activeElement).toBe(within(picker).getByRole("searchbox"));
 fireEvent.click(within(picker).getByRole("checkbox", { name: "其他.md" }));
 fireEvent.click(within(picker).getByRole("button", { name: "生成预览" }));
 await screen.findByText("合并 2 篇笔记");
 fireEvent.click(screen.getByRole("button", { name: "关闭导出预览" }));

 fireEvent.click(openSettingsExports().getByRole("button", { name: "导出整库 ZIP" }));
 await screen.findByText("知识库 ZIP 已保存 D:/导出/noto-vault.zip");
 expect(saveZip).toHaveBeenCalledOnce();
});

it("导出预设跨重开保存，单篇和合并应用排版并可临时切换", async () => {
 const { mount } = fixture("带预设的笔记");
 const first = mount();
 await open();
 const settings = openSettingsExports();
 fireEvent.click(settings.getByRole("button", { name: "新建预设" }));
 fireEvent.change(settings.getByRole("textbox", { name: "预设名称" }), { target: { value: " 横向讲义 " } });
 fireEvent.change(settings.getByRole("combobox", { name: "首选输出" }), { target: { value: "pdf" } });
 fireEvent.change(settings.getByRole("combobox", { name: "纸张" }), { target: { value: "A5" } });
 fireEvent.change(settings.getByRole("combobox", { name: "方向" }), { target: { value: "landscape" } });
 fireEvent.change(settings.getByRole("combobox", { name: "页边距" }), { target: { value: "12" } });
 fireEvent.change(settings.getByRole("combobox", { name: "正文字号" }), { target: { value: "18" } });
 fireEvent.click(settings.getByRole("button", { name: "保存预设" }));
 fireEvent.click(settings.getByRole("button", { name: "设为默认" }));
 fireEvent.click(settings.getByRole("button", { name: "完成" }));
 first.unmount();
 mount();
 await open();
 await start();
 const selectPreset = screen.getByRole<HTMLSelectElement>("combobox", { name: "导出预设" });
 expect(selectPreset.value).toBe("横向讲义");
 const frame = await ready("size:A5 landscape; margin:12mm;");
 expect(frame.srcdoc).toContain("font:18px/1.75");
 expect(screen.getByRole("button", { name: "打印 / 另存 PDF" }).classList.contains("primary")).toBe(true);
 fireEvent.change(selectPreset, { target: { value: "" } });
 await ready("size:A4 portrait; margin:20mm;");
 fireEvent.click(screen.getByRole("button", { name: "关闭导出预览" }));

 fireEvent.click(openSettingsExports().getByRole("button", { name: /^多篇合并导出/ }));
 const picker = within(await screen.findByRole("dialog", { name: "选择合并导出的笔记" }));
 fireEvent.click(picker.getByRole("checkbox", { name: "其他.md" }));
 fireEvent.click(picker.getByRole("button", { name: "生成预览" }));
 const merged = await ready("size:A5 landscape; margin:12mm;");
 expect(merged.srcdoc).toContain("其他.md");
 fireEvent.click(screen.getByRole("button", { name: "关闭导出预览" }));

 const manage = openSettingsExports();
 fireEvent.click(manage.getByRole("button", { name: "编辑预设" }));
 fireEvent.change(manage.getByRole("textbox", { name: "预设名称" }), { target: { value: "打印讲义" } });
 fireEvent.click(manage.getByRole("button", { name: "保存预设" }));
 expect(manage.getByRole<HTMLOptionElement>("option", { name: "打印讲义 · 默认" }).selected).toBe(true);
 fireEvent.click(manage.getByRole("button", { name: "编辑预设" }));
 fireEvent.click(manage.getByRole("button", { name: "删除预设" }));
 expect(manage.getByRole<HTMLOptionElement>("option", { name: "标准（内置） · 默认" }).selected).toBe(true);
}, 15000);

it.each(["web","desktop"] as const)("%s HTML 和打印使用相同已保存白板快照，保留草稿与两侧撤销",async kind=>{
 vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});
 const ctx={save:vi.fn(),restore:vi.fn(),setTransform:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),strokeRect:vi.fn(),translate:vi.fn(),scale:vi.fn(),setLineDash:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),fill:vi.fn(),arc:vi.fn(),ellipse:vi.fn(),closePath:vi.fn(),fillText:vi.fn(),measureText:vi.fn((s:string)=>({width:[...s].length*18}))} as unknown as CanvasRenderingContext2D;
 vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(()=>ctx);
 const drawingPath="绘图/board.drawing",source="标题\n\n![[绘图/board.drawing|示意图]]",output=vi.fn<NonNullable<WorkspaceRuntime["saveExportHtml"]>>().mockResolvedValue("D:/导出/笔记.html");
 const {mount,vault,api}=fixture(source,kind==="desktop"?output:undefined);
 vault.put(drawingPath,serializeDrawing({...emptyDrawing(),elements:[{...createDrawingElement("text",{x:30,y:40},{x:30,y:40},defaultDrawingStyle,"text"),text:"磁盘白板",width:180,height:56}]}));
 mount();const editor=await open();fireEvent.click(screen.getByRole("button",{name:"board.drawing"}));await screen.findByRole("region",{name:"绘图白板"});
 let release!:()=>void;api.save.mockImplementationOnce((file,content,version)=>new Promise(resolve=>{release=()=>{void vault.save(file,content,version).then(resolve);};}));
 fireEvent.doubleClick(screen.getByLabelText("白板绘制区域"),{clientX:70,clientY:55});const input=await screen.findByRole("textbox",{name:"白板文字"}) as HTMLTextAreaElement;
 fireEvent.change(input,{target:{value:"未保存的白板草稿"}});fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(release).toBeTypeOf("function"));
 fireEvent.click(screen.getByRole("tab",{name:/^a.md/}));await waitFor(()=>expect(vault.stored.get(drawingPath)?.content).toContain("未保存的白板草稿"));
 await start();const frame=await ready(),doc=new DOMParser().parseFromString(frame.srcdoc,"text/html"),image=doc.querySelector("figure.export-drawing-embed img")!;
 const decode=(uri:string)=>new TextDecoder().decode(Uint8Array.from(atob(uri.split(",")[1]),c=>c.charCodeAt(0)));
 expect(image).toBeTruthy();expect(decode(image.getAttribute("src")!)).toContain("磁盘白板");expect(decode(image.getAttribute("src")!)).not.toContain("未保存的白板草稿");
 expect(doc.querySelector("figure.export-drawing-embed figcaption")?.textContent).toBe("白板：示意图（已保存内容）");
 expect(vault.stored.get(drawingPath)?.content).toContain("未保存的白板草稿");
 const print=vi.spyOn(frame.contentWindow!,"print").mockImplementation(()=>{});vi.spyOn(frame.contentWindow!,"focus").mockImplementation(()=>{});
 fireEvent.click(screen.getByRole("button",{name:"打印 / 另存 PDF"}));expect(print).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));
 await waitFor(()=>expect(kind==="desktop"?output:vi.mocked(downloadExportHtml)).toHaveBeenCalledOnce());
 const savedHtml=kind==="desktop"?output.mock.calls[0][0]:vi.mocked(downloadExportHtml).mock.calls[0][0];expect(savedHtml).toBe(frame.srcdoc);
 edit(editor,source+"\n\n新的笔记编辑");expect(frame.srcdoc).not.toContain("新的笔记编辑");
 await act(async()=>release());await waitFor(()=>expect(parseDrawing(vault.notes.get(drawingPath)!.content).elements[0].text).toBe("未保存的白板草稿"),{timeout:4000});
 fireEvent.click(screen.getByRole("button",{name:"更新预览"}));
 await waitFor(()=>{const latest=screen.getByTitle("导出文档预览") as HTMLIFrameElement;const img=new DOMParser().parseFromString(latest.srcdoc,"text/html").querySelector("figure.export-drawing-embed img");expect(img&&decode(img.getAttribute("src")!)).toContain("未保存的白板草稿");});
 fireEvent.click(screen.getByRole("button",{name:"关闭导出预览"}));expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector(".cm-editor")!)).toBe(editor);
 act(()=>{undo(editor);});expect(editor.state.doc.toString()).toBe(source);
 fireEvent.click(screen.getByRole("tab",{name:/^board.drawing/}));expect(screen.getByRole("textbox",{name:"白板文字"})).toBe(input);expect(input.value).toBe("未保存的白板草稿");
 fireEvent.keyDown(input,{key:"Escape"});fireEvent.click(screen.getByRole("button",{name:"撤销白板"}));await waitFor(()=>expect(parseDrawing(vault.notes.get(drawingPath)!.content).elements[0].text).toBe("磁盘白板"),{timeout:4000});
},20000);
it("缺失白板时导出提示并要求确认，成品保留引用和原因",async()=>{
 const source="正文\n\n![[缺失.drawing|示意]]",{mount,api,vault}=fixture(source);mount();const editor=await open();
 await start();const frame=await screen.findByTitle("导出文档预览") as HTMLIFrameElement;
 act(()=>{const doc=frame.contentDocument!;doc.open();doc.write(frame.srcdoc);doc.close();fireEvent.load(frame);});
 await screen.findByText(/白板不存在/);expect((screen.getByRole("button",{name:"导出 HTML"}) as HTMLButtonElement).disabled).toBe(true);
 expect(frame.srcdoc).toContain("![[缺失.drawing|示意]]");expect(frame.srcdoc).toContain("白板不存在");
 fireEvent.click(screen.getByRole("checkbox",{name:/我已查看/}));await waitFor(()=>expect((screen.getByRole("button",{name:"导出 HTML"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));expect(vi.mocked(downloadExportHtml).mock.calls[0][0]).toBe(frame.srcdoc);
 fireEvent.click(screen.getByRole("button",{name:"关闭导出预览"}));expect(editor.state.doc.toString()).toBe(source);expect(vault.notes.get(path)?.content).toBe(source);expect(api.save).not.toHaveBeenCalled();
},10000);
it("导出冻结最新编辑，慢保存返回与后续输入不重挂编辑器，关闭恢复焦点/撤销",async()=>{
 const {mount,api,vault}=fixture();mount();const view=await open();
 let release!:()=>void;
 api.save.mockImplementationOnce((file,content,version)=>new Promise(resolve=>{release=()=>{void vault.save(file,content,version).then(resolve);};}));
 edit(view,"甲原文");
 await waitFor(()=>expect(api.save).toHaveBeenCalled(),{timeout:4000});
 await start();const frame=await ready("甲原文");
 expect(screen.getByText(/包含未保存内容/)).toBeTruthy();
 edit(view,"甲原文乙");
 await act(async()=>release());
 expect(frame.srcdoc.includes("甲原文乙")).toBe(false);
 expect(view.state.doc.toString()).toBe("甲原文乙");
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));
 expect(vi.mocked(downloadExportHtml).mock.calls[0][0].includes("甲原文乙")).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:"更新预览"}));
 await ready("甲原文乙");
 act(()=>view.dispatch({selection:{anchor:2}}));view.scrollDOM.scrollTop=73;
 fireEvent.click(screen.getByRole("button",{name:"关闭导出预览"}));
 await waitFor(()=>expect(globalThis.document.activeElement).toBe(view.contentDOM));
 expect(view.state.selection.main.head).toBe(2);
 expect(view.scrollDOM.scrollTop).toBe(73);
 expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
 act(()=>{undo(view);});
 expect(view.state.doc.toString()).not.toContain("<html");
 expect(view.state.doc.toString()).not.toBe("甲原文乙");
},15000);
it("来源附件导入完成后捕获最新正文，不丢失在途插入的图片链接",async()=>{
 const {mount,api}=fixture();mount();const view=await open();
 let complete!:(path:string)=>void;
 api.importAttachmentData.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
 fireEvent.paste(view.contentDOM,{clipboardData:{files:[new File(["image"],"图片.png",{type:"image/png"})]}});
 await waitFor(()=>expect(api.importAttachmentData).toHaveBeenCalled());
 await start();
 expect(screen.queryByTitle("导出文档预览")).toBeNull();
 await act(async()=>complete("attachments/图片.png"));
 await ready();
 expect(view.state.doc.toString()).toContain("attachments/%E5%9B%BE%E7%89%87.png");
 expect(api.image).toHaveBeenCalledWith(path,"attachments/图片.png");
},10000);
it("保存冲突仍可显式导出本地快照，不覆盖磁盘或清除恢复草稿",async()=>{
 const {mount,api,vault}=fixture();mount();const view=await open();
 api.save.mockRejectedValue(new WorkspaceError("conflict","外部文件已变化"));
 edit(view,"本地冲突编辑");
 await waitFor(()=>expect(vault.stored.get(path)?.content).toBe("本地冲突编辑"),{timeout:4000});
 await waitFor(()=>expect(screen.getByText(/保存未完成：外部文件已变化/)).toBeTruthy(),{timeout:4000});
 await start();await ready("本地冲突编辑");
 expect(screen.getByText(/当前本地冲突快照/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));
 fireEvent.click(screen.getByRole("button",{name:"关闭导出预览"}));
 expect(vault.notes.get(path)?.content).toBe("原文");
 expect(vault.stored.get(path)?.content).toBe("本地冲突编辑");
 expect(screen.getByText(/保存未完成：外部文件已变化/)).toBeTruthy();
},12000);
it("未确认的恢复草稿禁止导出，不自动替用户选择分支",async()=>{
 const {mount,vault}=fixture();const note=vault.notes.get(path)!;
 vault.stored.set(path,{path,content:"待确认草稿",baseVersion:note.version});
 mount();await open();
 fireEvent.click(screen.getByLabelText("文档更多操作"));
 expect((screen.getByRole("button",{name:"导出（HTML / PDF）"}) as HTMLButtonElement).disabled).toBe(true);
 expect(vault.stored.get(path)?.content).toBe("待确认草稿");
 expect(vault.notes.get(path)?.content).toBe("原文");
});
it("关闭资源准备并切换笔记后，迟到图片不能重新打开旧预览或发起下载",async()=>{
 const {mount,api}=fixture("![图](image.png)");mount();const first=await open();
 let complete!:(uri:string)=>void;
 api.image.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
 await start();await waitFor(()=>expect(complete).toBeTypeOf("function"));
 fireEvent.click(screen.getByRole("button",{name:"关闭导出预览"}));
 const second=await open("其他.md");
 await act(async()=>complete("data:image/png;base64,AQID"));
 expect(screen.queryByRole("dialog",{name:"本地导出"})).toBeNull();
 expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)).toBe(second);
 expect(first.state.doc.toString()).toContain("![图]");
 expect(downloadExportHtml).not.toHaveBeenCalled();
});
it("原生保存取消和失败保留编辑，警告需要明确确认，打印不假报 PDF 已保存",async()=>{
 const output=vi.fn<NonNullable<WorkspaceRuntime["saveExportHtml"]>>().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("输出目录只读"));
 const {mount}=fixture("原文\n\n[[未导出笔记]]",output);mount();const view=await open();
 await start();
 const frame=await screen.findByTitle("导出文档预览") as HTMLIFrameElement;
 act(()=>{const doc=frame.contentDocument!;doc.open();doc.write(frame.srcdoc);doc.close();fireEvent.load(frame);});
 await screen.findByText(/Wiki 目标不存在/);
 expect((screen.getByRole("button",{name:"导出 HTML"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole("checkbox",{name:/我已查看/}));
 await waitFor(()=>expect((screen.getByRole("button",{name:"导出 HTML"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));
 await screen.findByText("已取消保存。");
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));
 await screen.findByText(/输出目录只读/);
 expect(view.state.doc.toString()).toContain("原文");
 expect(screen.getByTitle("导出文档预览")).toBe(frame);
 expect((screen.getByRole("checkbox",{name:/我已查看/}) as HTMLInputElement).checked).toBe(true);
 output.mockResolvedValueOnce("D:/导出/重试.html");
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));
 await screen.findByText("HTML 已保存：D:/导出/重试.html");
 expect(output).toHaveBeenCalledTimes(3);
 expect(output.mock.calls[2]).toEqual(output.mock.calls[1]);
 const print=vi.spyOn(frame.contentWindow!,"print").mockImplementationOnce(()=>{throw new Error("打印不可用");}).mockImplementation(()=>{});
 vi.spyOn(frame.contentWindow!,"focus").mockImplementation(()=>{});
 fireEvent.click(screen.getByRole("button",{name:"打印 / 另存 PDF"}));
 await screen.findByText(/无法打开打印对话框：打印不可用/);
 expect(screen.getByTitle("导出文档预览")).toBe(frame);
 fireEvent.click(screen.getByRole("button",{name:"打印 / 另存 PDF"}));
 expect(print).toHaveBeenCalledTimes(2);
 expect(screen.queryByRole("alert")).toBeNull();
 expect(screen.getByText(/已请求打印/)).toBeTruthy();
 expect(screen.queryByText("PDF 已保存")).toBeNull();
},12000);

it("明确恢复冲突草稿后可导出该分支，不保存回外部版本，也不删除草稿",async()=>{
 const {mount,api,vault}=fixture();const base=vault.notes.get(path)!;
 vault.put(path,"外部版本");
 vault.stored.set(path,{path,content:"待恢复的本地分支",baseVersion:base.version});
 mount();await open();
 fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));
 await start();await ready("待恢复的本地分支");
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));
 fireEvent.click(screen.getByRole("button",{name:"关闭导出预览"}));
 await waitFor(()=>expect(vault.stored.get(path)?.content).toBe("待恢复的本地分支"));
 expect(vault.notes.get(path)?.content).toBe("外部版本");
 expect(api.save).not.toHaveBeenCalled();
 expect(api.removeDraft).not.toHaveBeenCalledWith(path);
 expect(screen.getByText("草稿产生后原文件已变化，请另存或重新载入。")).toBeTruthy();
});
it("准备资源时切换已有标签取消旧导出，两篇编辑器和草稿仍保留",async()=>{
 const {mount,api,vault}=fixture("![图](image.png)");mount();const first=await open();
 await open("其他.md");
 fireEvent.click(screen.getByRole("tab",{name:(label)=>label.startsWith("a.md")}));
 edit(first,"![图](image.png)\n\n待保存的第一篇");
 let complete!:(uri:string)=>void;
 api.image.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
 await start();await waitFor(()=>expect(complete).toBeTypeOf("function"));
 fireEvent.click(screen.getByRole("tab",{name:(label)=>label.startsWith("其他.md")}));
 await waitFor(()=>expect(screen.queryByRole("dialog",{name:"本地导出"})).toBeNull());
 await act(async()=>complete("data:image/png;base64,AQID"));
 fireEvent.click(screen.getByRole("tab",{name:(label)=>label.startsWith("a.md")}));
 expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)).toBe(first);
 expect(first.state.doc.toString()).toContain("待保存的第一篇");
 await waitFor(()=>expect(vault.stored.get(path)?.content).toContain("待保存的第一篇"));
 expect(screen.queryByRole("dialog",{name:"本地导出"})).toBeNull();
 expect(downloadExportHtml).not.toHaveBeenCalled();
});
it("预览准备失败后更新重试，网页下载失败则直接重试同一文档",async()=>{
 const {mount}=fixture();mount();const view=await open();
 vi.mocked(readyExportFrame).mockRejectedValueOnce(new Error("字体暂时不可用"));
 await start();const first=await screen.findByTitle("导出文档预览") as HTMLIFrameElement;
 act(()=>{const doc=first.contentDocument!;doc.open();doc.write(first.srcdoc);doc.close();fireEvent.load(first);});
 await screen.findByText("字体暂时不可用");
 expect((screen.getByRole("button",{name:"导出 HTML"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"更新预览"}));
 const frame=await ready("原文");
 vi.mocked(downloadExportHtml).mockImplementationOnce(()=>{throw new Error("浏览器下载失败");});
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));
 await screen.findByText(/浏览器下载失败/);
 fireEvent.click(screen.getByRole("button",{name:"导出 HTML"}));
 await screen.findByText("已发起 HTML 下载，请查看浏览器下载列表。");
 expect(screen.getByTitle("导出文档预览")).toBe(frame);
 expect(downloadExportHtml).toHaveBeenCalledTimes(2);
 expect(vi.mocked(downloadExportHtml).mock.calls[0]).toEqual(vi.mocked(downloadExportHtml).mock.calls[1]);
 expect(view.state.doc.toString()).toBe("原文");
});
it("切库先保护原库草稿，迟到资源不进入新知识库",async()=>{
 const {mount,api,vault}=fixture("![图](image.png)",vi.fn());mount();const view=await open();
 edit(view,"![图](image.png)\n\n原库未保存编辑");
 let complete!:(uri:string)=>void;
 api.image.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
 const next=new MemoryVault();next.put("新库.md","新库原文");
 api.chooseDirectory.mockResolvedValue("new-vault");
 api.selectVault.mockImplementation(async()=>{api.entries=next.entries;api.read.mockImplementation(next.read);return {vault:"new-vault",id:"new-vault",error:null};});
 await start();await waitFor(()=>expect(complete).toBeTypeOf("function"));
 fireEvent.click(screen.getByRole("button", { name: /知识库选项/ }));
 fireEvent.click(screen.getByRole("button", { name: "打开其他知识库" }));
 await waitFor(()=>expect(api.selectVault).toHaveBeenCalledWith("new-vault"));
 expect(vault.stored.get(path)?.content).toContain("原库未保存编辑");
 await open("新库.md");
 await act(async()=>complete("data:image/png;base64,AQID"));
 expect(screen.queryByRole("dialog",{name:"本地导出"})).toBeNull();
 expect(screen.getByRole("tabpanel").textContent).toContain("新库原文");
 expect(downloadExportHtml).not.toHaveBeenCalled();
});
it("来源改名取消正在准备的导出，重新导出使用新路径和完整正文",async()=>{
 const {mount,api,vault}=fixture("![图](image.png)");mount();await open();
 let complete!:(uri:string)=>void;
 api.image.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
 await start();await waitFor(()=>expect(complete).toBeTypeOf("function"));
 const tree=screen.getByRole("complementary",{name:"工作区侧栏"});
 fireEvent.keyDown(within(tree).getByRole("button",{name:"a.md"}),{key:"F2"});
 const input=await screen.findByRole("textbox",{name:"重命名 a.md"});
 fireEvent.change(input,{target:{value:"更名.md"}});fireEvent.keyDown(input,{key:"Enter"});
 await screen.findByRole("tab",{name:"更名.md",selected:true});
 await act(async()=>complete("data:image/png;base64,AQID"));
 expect(screen.queryByRole("dialog",{name:"本地导出"})).toBeNull();
 expect(vault.notes.get("项目/更名.md")?.content).toBe("![图](image.png)");
 await start();const frame=await ready();
 expect(frame.srcdoc).toContain("<title>更名</title>");
 expect(api.image).toHaveBeenLastCalledWith("项目/更名.md","image.png");
 expect(downloadExportHtml).not.toHaveBeenCalled();
});
