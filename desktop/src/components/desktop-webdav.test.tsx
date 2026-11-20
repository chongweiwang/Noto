// @vitest-environment jsdom
import "../test/codemirror-dom";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {EditorView} from "@codemirror/view";
import {undo} from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import {WorkspaceRuntimeContext} from "../lib/workspace-runtime";
import {MemoryVault} from "../test/memory-vault";
import {panelId} from "./workspace-tabs";
import type {WorkspaceApi,WebDavReport} from "../lib/vault-api";
import {defaultPreferences,preferencesKey} from "../lib/workspace-state";
import {emptyCanvas,createCanvasNode,serializeCanvas} from "../lib/canvas-document";
import {emptyDrawing,serializeDrawing} from "../lib/drawing-document";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
beforeEach(()=>{localStorage.clear();vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});
  const ctx={save:vi.fn(),restore:vi.fn(),setTransform:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),strokeRect:vi.fn(),translate:vi.fn(),scale:vi.fn(),setLineDash:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),fill:vi.fn(),arc:vi.fn(),ellipse:vi.fn(),closePath:vi.fn(),fillText:vi.fn(),measureText:vi.fn((s:string)=>({width:s.length*18}))};vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(()=>ctx as unknown as CanvasRenderingContext2D);
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
function report(patch:Partial<WebDavReport>={}):WebDavReport{return {uploaded:0,downloaded:0,deletedLocal:0,deletedRemote:0,conflicts:[],skipped:[],errors:[],changed:[],...patch};}
function fixture(kind:"web"|"desktop"="web"){
  const vault=new MemoryVault();vault.put("a.md","原文");vault.put("b.md","乙的原文");vault.put("map.canvas",serializeCanvas({...emptyCanvas(),nodes:[createCanvasNode("text",{x:0,y:0},{id:"text",text:"画布原文"})]}));vault.put("board.drawing",serializeDrawing({...emptyDrawing(),elements:[{id:"text",type:"text",x:30,y:40,width:200,height:60,strokeColor:"#111111",fontSize:20,text:"白板原文"}]}));
  const api={...vault,status:async()=>({vault:"WebDAV库",id:"webdav-test",error:null}),selectVault:vi.fn(),createVault:vi.fn(),chooseDirectory:vi.fn(),chooseFile:vi.fn(),importAttachment:vi.fn(),openAttachment:vi.fn(),openExternal:vi.fn(),openItem:vi.fn(),remove:vi.fn(),image:vi.fn(),webdavSync:vi.fn(async()=>report()),webdavTest:vi.fn(async()=>{})} as WorkspaceApi;
  const mount=()=>render(<WorkspaceRuntimeContext.Provider value={{kind,api}}><DesktopApp/></WorkspaceRuntimeContext.Provider>);return {vault,api,mount};
}
async function open(path="a.md"){const buttons=await screen.findAllByRole("button",{name:path});fireEvent.click(buttons.find(b=>b.dataset.treePath===path)!);await screen.findByRole("tab",{name:new RegExp(path)});}
function editor(path="a.md"){return EditorView.findFromDOM(document.getElementById(panelId(path))!.querySelector<HTMLElement>(".cm-editor")!)!;}
function edit(text:string,path="a.md"){const e=editor(path);act(()=>e.dispatch({changes:{from:0,to:e.state.doc.length,insert:text},userEvent:"input.type"}));}
async function syncPanel(){fireEvent.click(screen.getByLabelText("软件设置"));fireEvent.click(screen.getByRole("button",{name:"工作区"}));fireEvent.click(screen.getByRole("button",{name:"配置 WebDAV 同步"}));const p=await screen.findByRole("dialog",{name:"WebDAV 同步"});fireEvent.change(within(p).getByLabelText("服务地址"),{target:{value:"https://dav.example.test/files/"}});fireEvent.change(within(p).getByLabelText("用户名"),{target:{value:"user"}});fireEvent.change(within(p).getByLabelText("密码或应用密码"),{target:{value:"secret-app-password"}});return p;}
it.each(["web","desktop"] as const)("%s 同步前保护未保存编辑，密码不落盘且自动保存和撤销保持",async kind=>{
  const {mount,api,vault}=fixture(kind);localStorage.setItem(preferencesKey,JSON.stringify({...defaultPreferences,autoSaveDelay:10000}));mount();await open();await waitFor(()=>expect(editor()).toBeTruthy());const original=editor();edit("未保存内容");const p=await syncPanel();
  api.webdavSync=vi.fn(async input=>{expect(vault.stored.get("a.md")?.content).toBe("未保存内容");return report({skipped:input.protectedPaths});});
  fireEvent.click(within(p).getByRole("button",{name:"立即同步"}));await within(p).findByText(/跳过 1 个/);expect(api.webdavSync).toHaveBeenCalledWith(expect.objectContaining({protectedPaths:["a.md"],config:expect.objectContaining({password:"secret-app-password"})}));expect([...Array(localStorage.length)].map((_,i)=>localStorage.getItem(localStorage.key(i)!)).join("")).not.toContain("secret-app-password");expect(editor()).toBe(original);
  fireEvent.click(within(p).getByRole("button",{name:"关闭"}));vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});act(()=>undo(original));edit("同步后的新输入");await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(vault.notes.get("a.md")?.content).toBe("同步后的新输入");act(()=>undo(original));expect(original.state.doc.toString()).toBe("原文");
});
it("收起后台同步后继续输入，迟到下载不会覆盖新内容或撤销记录",async()=>{
  const {mount,api,vault}=fixture();let release!:()=>void;const pending=new Promise<void>(r=>{release=r;});api.webdavSync=vi.fn(async()=>{await pending;vault.put("a.md","远端更新");return report({downloaded:1,changed:["a.md"]});});
  mount();await open();await waitFor(()=>expect(editor()).toBeTruthy());const original=editor();const p=await syncPanel();fireEvent.click(within(p).getByRole("button",{name:"立即同步"}));await waitFor(()=>expect(api.webdavSync).toHaveBeenCalled());fireEvent.click(within(p).getByRole("button",{name:"收起，继续后台处理"}));edit("后台同步时继续输入");await act(async()=>release());await screen.findByText(/WebDAV 已更新磁盘/);expect(original.state.doc.toString()).toBe("后台同步时继续输入");expect(vault.stored.get("a.md")?.content).toBe("后台同步时继续输入");act(()=>undo(original));expect(original.state.doc.toString()).toBe("原文");expect(editor()).toBe(original);
});
it("同步后的旧重读响应不能覆盖外部刷新后已成功保存的新版本",async()=>{
  const {mount,api,vault}=fixture();const read=api.read;let delay=false,waiting=false;let release!:()=>void;const pending=new Promise<void>(r=>{release=r;});
  api.snapshot=async paths=>({notes:paths.flatMap(path=>vault.notes.has(path)?[vault.notes.get(path)!]:[]),errors:[]});
  api.read=async path=>{const captured=await read(path);if(path==="a.md"&&delay){delay=false;waiting=true;await pending;}return captured;};
  api.webdavSync=vi.fn(async()=>{vault.put("a.md","远端更新");delay=true;return report({downloaded:1,changed:["a.md"]});});mount();await open();await waitFor(()=>expect(editor()).toBeTruthy());const original=editor();const p=await syncPanel();fireEvent.click(within(p).getByRole("button",{name:"立即同步"}));await waitFor(()=>expect(waiting).toBe(true));fireEvent.click(within(p).getByRole("button",{name:"收起，继续后台处理"}));
  // The ordinary external-file poll finishes before the delayed sync read.
  await waitFor(()=>expect(original.state.doc.toString()).toBe("远端更新"),{timeout:6000});edit("此后成功保存的新内容");fireEvent.keyDown(window,{key:"s",ctrlKey:true});await waitFor(()=>expect(vault.notes.get("a.md")?.content).toBe("此后成功保存的新内容"));await act(async()=>release());
  expect(original.state.doc.toString()).toBe("此后成功保存的新内容");expect(editor()).toBe(original);act(()=>undo(original));expect(original.state.doc.toString()).toBe("远端更新");
});
it("连接测试不启动同步，冲突选择携带原版本且失败可以重试",async()=>{
  const {mount,api}=fixture();mount();await open();const p=await syncPanel();fireEvent.click(within(p).getByRole("button",{name:"测试连接"}));await within(p).findByText(/服务目录可访问/);expect(api.webdavSync).not.toHaveBeenCalled();
  api.webdavSync=vi.fn().mockResolvedValueOnce(report({conflicts:[{path:"a.md",reason:"双方变化",copy:null,localVersion:"v1",remoteVersion:"r1"}]})).mockRejectedValueOnce(new Error("WebDAV 断线")).mockResolvedValueOnce(report({uploaded:1}));fireEvent.click(within(p).getByRole("button",{name:"立即同步"}));await within(p).findByText(/待处理冲突/);fireEvent.change(within(p).getByLabelText("处理 a.md"),{target:{value:"local"}});fireEvent.click(within(p).getByRole("button",{name:"处理选中冲突"}));await within(p).findByText("WebDAV 断线");expect(api.webdavSync).toHaveBeenLastCalledWith(expect.objectContaining({resolutions:[{path:"a.md",localVersion:"v1",remoteVersion:"r1",choice:"local"}]}));fireEvent.click(within(p).getByRole("button",{name:"处理选中冲突"}));await within(p).findByText("本轮同步完成。");
});
it("草稿写入失败时不会启动网络同步，原编辑内容保持",async()=>{
  const {mount,api}=fixture();mount();await open();await waitFor(()=>expect(editor()).toBeTruthy());edit("应保留的编辑");api.writeDraft=vi.fn(async()=>{throw new Error("草稿不可写");});const p=await syncPanel();fireEvent.click(within(p).getByRole("button",{name:"立即同步"}));await within(p).findByText("草稿不可写");expect(api.webdavSync).not.toHaveBeenCalled();expect(editor().state.doc.toString()).toBe("应保留的编辑");
});
it.each([{path:"map.canvas",field:"画布文本",undo:"画布撤销",old:"画布原文"},{path:"board.drawing",field:"白板文字",undo:"撤销白板",old:"白板原文"}])("$path 的草稿被同步跳过，撤销和自动保存沿用原文档会话",async item=>{
  const {mount,api,vault}=fixture();localStorage.setItem(preferencesKey,JSON.stringify({...defaultPreferences,autoSaveDelay:10000}));mount();await open(item.path);
  if(item.path.endsWith("canvas"))fireEvent.doubleClick(screen.getByRole("region",{name:"知识画布"}).querySelector<HTMLElement>('[data-canvas-node="text"] .canvas-node-body')!);
  else fireEvent.doubleClick(screen.getByLabelText("白板绘制区域"),{clientX:70,clientY:55});
  fireEvent.change(await screen.findByRole("textbox",{name:item.field}),{target:{value:"同步前的新内容"}});const p=await syncPanel();api.webdavSync=vi.fn(async input=>report({skipped:input.protectedPaths}));fireEvent.click(within(p).getByRole("button",{name:"立即同步"}));await within(p).findByText(/跳过 1 个/);expect(vault.stored.get(item.path)?.content).toContain("同步前的新内容");expect(api.webdavSync).toHaveBeenCalledWith(expect.objectContaining({protectedPaths:[item.path]}));fireEvent.click(within(p).getByRole("button",{name:"关闭"}));
  fireEvent.click(screen.getByRole("button",{name:item.undo}));act(()=>window.dispatchEvent(new Event("beforeunload",{cancelable:true})));await waitFor(()=>expect(vault.stored.get(item.path)?.content??vault.notes.get(item.path)?.content).not.toContain("同步前的新内容"));expect(document.getElementById(panelId(item.path))).toBeTruthy();
});
