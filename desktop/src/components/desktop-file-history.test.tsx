// @vitest-environment jsdom
import "../test/codemirror-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import { panelId } from "./workspace-tabs";
import { WorkspaceRuntimeContext } from "../lib/workspace-runtime";
import { MemoryVault } from "../test/memory-vault";
import type { HistorySnapshot, WorkspaceApi } from "../lib/vault-api";
import { defaultPreferences, preferencesKey } from "../lib/workspace-state";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg />"}));
beforeEach(()=>{localStorage.clear();});
afterEach(()=>{cleanup();vi.useRealTimers();});
const snapshot:HistorySnapshot={id:"snapshot-a",createdAt:Date.now()-600000,size:12,reason:"save",content:"# 旧版本\n历史正文"};
function fixture(kind:"web"|"desktop"="web") {
  const vault=new MemoryVault();vault.put("a.md","原本磁盘内容");vault.put("b.md","乙的磁盘内容");
  const api={...vault,status:async()=>({vault:"恢复测试库",id:"history-vault",error:null}),selectVault:vi.fn(),createVault:vi.fn(),chooseDirectory:vi.fn(),chooseFile:vi.fn(),importAttachment:vi.fn(),openAttachment:vi.fn(),openExternal:vi.fn(),openItem:vi.fn(),remove:vi.fn(),image:vi.fn(),fileHistory:vi.fn(async()=>[snapshot]),readHistory:vi.fn(async()=>snapshot),checkpointHistory:vi.fn(async()=>{})} as WorkspaceApi;
  const mount=()=>render(<WorkspaceRuntimeContext.Provider value={{kind,api}}><DesktopApp/></WorkspaceRuntimeContext.Provider>);
  return {vault,api,mount};
}
function editor(path="a.md") {return EditorView.findFromDOM(document.getElementById(panelId(path))!.querySelector<HTMLElement>(".cm-editor")!)!;}
async function open(path="a.md") {const buttons=await screen.findAllByRole("button",{name:path});fireEvent.click(buttons.find(button=>button.dataset.treePath===path)!);return waitFor(()=>editor(path));}
function edit(text:string,path="a.md") {const view=editor(path);act(()=>view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text},userEvent:"input.type"}));}
async function history(path?:string) {
  const header=path?screen.getByRole("group",{name:`文档工具栏 ${path}`}):document;
  fireEvent.click(within(header as HTMLElement).getByLabelText(path?`${path}的文档更多操作`:"文档更多操作"));
  fireEvent.click(within(header as HTMLElement).getByRole("button",{name:"文件恢复"}));
  const dialog=await screen.findByRole("dialog",{name:"文件恢复"});
  await waitFor(()=>expect(within(dialog).getByRole("button",{name:"还原到编辑器"}).hasAttribute("disabled")).toBe(false));
  return dialog;
}
it.each(["web","desktop"] as const)("%s 还原进入原编辑器并保护未保存编辑，自动保存后仍可撤销和重做",async kind=>{
  const {mount,api,vault}=fixture(kind);localStorage.setItem(preferencesKey,JSON.stringify({...defaultPreferences,autoSaveDelay:10000}));mount();const original=await open();
  edit("尚未保存的新编辑");await history();
  const diff=screen.getByLabelText("快照与当前编辑的差异");expect(diff.textContent).toContain("− 历史正文");expect(diff.textContent).toContain("+ 尚未保存的新编辑");
  fireEvent.click(screen.getByRole("button",{name:"还原到编辑器"}));
  await waitFor(()=>expect(screen.queryByRole("dialog",{name:"文件恢复"})).toBeNull());
  expect(api.checkpointHistory).toHaveBeenCalledWith("a.md","尚未保存的新编辑",expect.any(String));
  expect(editor()).toBe(original);expect(original.state.doc.toString()).toBe(snapshot.content);
  expect(vault.stored.get("a.md")?.content).toBe(snapshot.content);expect(vault.notes.get("a.md")?.content).toBe("原本磁盘内容");
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});
  // Reschedule through the existing preference path, then verify the selected delay.
  act(()=>undo(original));act(()=>redo(original));
  await act(async()=>{await vi.advanceTimersByTimeAsync(9999);});expect(vault.notes.get("a.md")?.content).toBe("原本磁盘内容");
  await act(async()=>{await vi.advanceTimersByTimeAsync(1);});expect(vault.notes.get("a.md")?.content).toBe(snapshot.content);
  act(()=>undo(original));expect(original.state.doc.toString()).toBe("尚未保存的新编辑");
  act(()=>undo(original));expect(original.state.doc.toString()).toBe("原本磁盘内容");
  expect(editor()).toBe(original);
});
it("保护快照失败不改变编辑内容或撤销栈，草稿仍保留",async()=>{
  const {mount,api,vault}=fixture();api.checkpointHistory=vi.fn(async()=>{throw new Error("快照目录不可写");});mount();const original=await open();edit("应保留的输入");await history();
  fireEvent.click(screen.getByRole("button",{name:"还原到编辑器"}));await screen.findByText(/快照目录不可写/);
  expect(original.state.doc.toString()).toBe("应保留的输入");expect(vault.stored.get("a.md")?.content).toBe("应保留的输入");expect(vault.notes.get("a.md")?.content).toBe("原本磁盘内容");
  fireEvent.click(screen.getByRole("button",{name:"关闭"}));act(()=>undo(original));expect(original.state.doc.toString()).toBe("原本磁盘内容");
});
it("先等待慢保存，再用最新磁盘版本保护，期间更新不被旧快照覆盖",async()=>{
  const {mount,api,vault}=fixture();const save=api.save;let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});
  api.save=async(...args)=>{await wait;return save(...args);};mount();const original=await open();edit("保存中的输入");
  fireEvent.keyDown(window,{key:"s",ctrlKey:true});await waitFor(()=>expect(vault.stored.has("a.md")).toBe(true));
  await history();fireEvent.click(screen.getByRole("button",{name:"还原到编辑器"}));
  expect(api.checkpointHistory).not.toHaveBeenCalled();await act(async()=>{release();});
  await waitFor(()=>expect(original.state.doc.toString()).toBe(snapshot.content));
  expect(api.checkpointHistory).toHaveBeenCalledWith("a.md","保存中的输入",vault.notes.get("a.md")?.version);
});
it("双栏按来源还原，不改变另一篇笔记或其编辑器",async()=>{
  const {mount,api}=fixture();mount();const first=await open();fireEvent.contextMenu(screen.getByRole("button",{name:"b.md"}));fireEvent.click(screen.getByRole("menuitem",{name:"在右侧打开"}));await screen.findByRole("tab",{name:"b.md"});
  const second=editor("b.md");await history("a.md");fireEvent.click(screen.getByRole("button",{name:"还原到编辑器"}));await waitFor(()=>expect(first.state.doc.toString()).toBe(snapshot.content));
  expect(api.checkpointHistory).toHaveBeenCalledWith("a.md","原本磁盘内容",expect.any(String));expect(second.state.doc.toString()).toBe("乙的磁盘内容");expect(editor("b.md")).toBe(second);
});
it("快照读取失败可重试；切换笔记后迟到的响应不会重新打开恢复面板",async()=>{
  const {mount,api}=fixture();let release!:(v:HistorySnapshot)=>void;api.readHistory=vi.fn().mockRejectedValueOnce(new Error("快照损坏")).mockImplementationOnce(()=>new Promise(r=>{release=r;}));mount();await open();
  fireEvent.click(screen.getByLabelText("文档更多操作"));fireEvent.click(screen.getByRole("button",{name:"文件恢复"}));await screen.findByText(/快照损坏/);
  expect(screen.getByRole("button",{name:"还原到编辑器"}).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"重试"}));await waitFor(()=>expect(api.readHistory).toHaveBeenCalledTimes(2));await open("b.md");await act(async()=>release(snapshot));
  expect(screen.queryByRole("dialog",{name:"文件恢复"})).toBeNull();expect(editor("b.md").state.doc.toString()).toBe("乙的磁盘内容");expect(api.checkpointHistory).not.toHaveBeenCalled();
});
it("保护期间内容变化会取消还原，迟到结果不会覆盖新编辑",async()=>{
  const {mount,api}=fixture();let release!:()=>void;api.checkpointHistory=vi.fn(()=>new Promise<void>(r=>{release=r;}));mount();const original=await open();edit("准备还原时的内容");await history();
  fireEvent.click(screen.getByRole("button",{name:"还原到编辑器"}));await waitFor(()=>expect(api.checkpointHistory).toHaveBeenCalled());
  edit("保护期间到来的新内容");await act(async()=>release());await screen.findByText(/笔记内容或草稿状态已变化/);
  expect(original.state.doc.toString()).toBe("保护期间到来的新内容");
});
it("草稿写入失败时不开始还原；待确认草稿仅可查看历史",async()=>{
  const {mount,api,vault}=fixture();mount();const original=await open();edit("必须保护的输入");api.writeDraft=vi.fn(async()=>{throw new Error("草稿磁盘已满");});await history();
  fireEvent.click(screen.getByRole("button",{name:"还原到编辑器"}));await screen.findAllByText(/草稿磁盘已满/);expect(api.checkpointHistory).not.toHaveBeenCalled();expect(original.state.doc.toString()).toBe("必须保护的输入");
  cleanup();localStorage.clear();vault.stored.set("a.md",{path:"a.md",content:"待确认的恢复草稿",baseVersion:vault.notes.get("a.md")!.version});mount();await open();await screen.findByRole("button",{name:"恢复草稿"});
  fireEvent.click(screen.getByLabelText("文档更多操作"));fireEvent.click(screen.getByRole("button",{name:"文件恢复"}));await screen.findByText("请先处理待恢复草稿，再还原快照。");expect(screen.getByRole("button",{name:"还原到编辑器"}).hasAttribute("disabled")).toBe(true);
});
it("阅读模式中还原同步预览，隐藏编辑器保持原撤销记录",async()=>{
  const {mount}=fixture();localStorage.setItem(preferencesKey,JSON.stringify({...defaultPreferences,defaultMode:"preview"}));mount();const original=await open();edit("阅读前的未保存文本");await history();
  fireEvent.click(screen.getByRole("button",{name:"预览"}));expect(screen.getByLabelText("快照原文").textContent).toBe(snapshot.content);
  fireEvent.click(screen.getByRole("button",{name:"还原到编辑器"}));await waitFor(()=>expect(screen.queryByRole("dialog",{name:"文件恢复"})).toBeNull());
  expect(document.getElementById(panelId("a.md"))!.querySelector(".preview-mount")?.textContent).toContain("历史正文");
  expect(editor()).toBe(original);act(()=>undo(original));expect(original.state.doc.toString()).toBe("阅读前的未保存文本");
});
