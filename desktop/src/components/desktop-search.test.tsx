// @vitest-environment jsdom
import "../test/codemirror-dom";
import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {EditorView} from "@codemirror/view";
import {undo} from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import {MemoryVault} from "../test/memory-vault";
import {WorkspaceRuntimeContext,type WorkspaceRuntime} from "../lib/workspace-runtime";
import type {WorkspaceApi} from "../lib/vault-api";
import {WorkspaceError} from "../lib/api-error";
import {rawSearchOffset} from "../lib/note-search";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
const target="# 标题\n\n开头 命中 以及 命中。\n\n第二段 命中 结束。\n\n[说明](hidden-target)";
beforeEach(()=>{localStorage.clear();vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn()});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture(kind:"desktop"|"web"){
 const vault=new MemoryVault();vault.put("来源.md","# 来源\n\n[[目标#标题|Wiki入口]]\n\n原文");vault.put("目标.md",target);vault.put("其他.md","# 其他\n\n其他正文");vault.put("文件名专用.md","# 不含关键词");
 const api={...vault,status:async()=>({vault:"search-vault",id:"search-vault",error:null}),
 snapshot:vi.fn(async(paths:string[])=>({notes:paths.flatMap(path=>vault.notes.has(path)?[{...vault.notes.get(path)!}]:[]),errors:[]})),
 read:vi.fn(async(path:string)=>{if(!vault.notes.has(path))throw new WorkspaceError("not_found","文件不存在");return vault.read(path);}),
 save:vi.fn(vault.save),writeDraft:vi.fn(vault.writeDraft),removeDraft:vi.fn(vault.removeDraft),
 chooseDirectory:vi.fn(),selectVault:vi.fn(),createVault:vi.fn(),chooseFile:vi.fn(),importAttachment:vi.fn(),image:vi.fn(),openItem:vi.fn(),openAttachment:vi.fn(),openExternal:vi.fn(),remove:vi.fn()} satisfies WorkspaceApi;
 const runtime:WorkspaceRuntime={kind,api,...(kind==="desktop"?{nativeWindow:{destroy:vi.fn(async()=>{}),onCloseRequested:vi.fn(async()=>()=>{})}}:{})};
 return {vault,api,mount:()=>render(<WorkspaceRuntimeContext.Provider value={runtime}><DesktopApp/></WorkspaceRuntimeContext.Provider>)};
}
function tab(path:string){return screen.getAllByRole("tab").find(item=>item.getAttribute("title")===path) as HTMLButtonElement;}
async function active(path:string){await waitFor(()=>{expect(tab(path)?.getAttribute("aria-selected")).toBe("true");expect(tab(path).disabled).toBe(false);});}
async function open(path:string){
 const buttons=await screen.findAllByRole("button",{name:path});fireEvent.click(buttons.find(button=>button.closest(".file-tree-root"))!);await active(path);
 await waitFor(()=>expect(screen.getByRole("tabpanel").querySelector(".cm-editor")).toBeTruthy());
}
function view(){return EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!;}
function put(view:EditorView,content:string){act(()=>view.dispatch({changes:{from:0,to:view.state.doc.length,insert:content},selection:{anchor:content.length},userEvent:"input.type"}));}
async function search(query:string,path="目标.md"){
 if(!screen.queryByRole("searchbox",{name:"搜索笔记"}))fireEvent.click(await screen.findByRole("button",{name:"搜索"}));
 const input=await screen.findByRole("searchbox",{name:"搜索笔记"});fireEvent.change(input,{target:{value:query}});
 const group=await screen.findByRole("region",{name:"搜索结果："+path});await waitFor(()=>expect(group.querySelector(".search-match")??group.querySelector(".search-file-open")).toBeTruthy());return group;
}
function hits(group:HTMLElement){return [...group.querySelectorAll<HTMLButtonElement>(".search-match")];}
function chosenText(){const editor=view(),range=editor.state.selection.main;return editor.state.sliceDoc(range.from,range.to);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};}
describe.each(["desktop","web"] as const)("搜索命中 %s",kind=>{
 it("嵌入使用目标保存态，宿主编辑与目标待恢复草稿保持独立",async()=>{
  const {mount,vault,api}=fixture(kind),source="# 来源\n\n![[目标#标题]]\n\n原文";
  vault.put("来源.md",source);vault.stored.set("目标.md",{path:"目标.md",content:"尚未确认的目标草稿",baseVersion:vault.notes.get("目标.md")!.version});
  mount();await open("来源.md");const editor=view(),changed=source+"\n继续输入";put(editor,changed);
  fireEvent.click(screen.getByRole("button",{name:"阅读"}));
  const group=await screen.findByRole("group",{name:"嵌入：目标#标题"});
  expect(group.textContent).toContain("开头 命中");expect(group.textContent).not.toContain("尚未确认的目标草稿");
  expect(editor.state.doc.toString()).toBe(changed);expect(vault.stored.get("目标.md")?.content).toBe("尚未确认的目标草稿");
  expect(api.removeDraft.mock.calls.some(call=>call[0]==="目标.md")).toBe(false);
  fireEvent.click(within(group).getByRole("button",{name:"目标#标题 ↗"}));
  await screen.findByRole("button",{name:"恢复草稿"});expect(vault.stored.get("目标.md")?.content).toBe("尚未确认的目标草稿");
  expect(editor.state.doc.toString()).toBe(changed);
 });
 it.each(["实时编辑","源码","阅读","分屏"])("保持 %s 视图与原会话，选择同一行第二个命中且不重放",async(mode)=>{
  const {mount,api}=fixture(kind);mount();await open("目标.md");const editor=view();fireEvent.click(screen.getByRole("button",{name:mode}));await open("来源.md");const source=view();
  const group=await search("命中");expect(hits(group)).toHaveLength(3);expect(group.querySelectorAll("mark")).toHaveLength(3);
  fireEvent.click(hits(group)[1]);await active("目标.md");expect(view()).toBe(editor);expect(screen.getByRole("button",{name:mode}).getAttribute("aria-pressed")).toBe("true");
  await waitFor(()=>expect(document.querySelector(".status-notice")?.textContent).toContain("已定位搜索命中"));
  if(mode!=="阅读"){expect(chosenText()).toBe("命中");expect(editor.state.selection.main.from).toBe(target.indexOf("命中",target.indexOf("命中")+2));expect(editor.dom.querySelector(".cm-vault-search-hit")).toBeTruthy();}
  if(mode==="阅读"||mode==="分屏")await waitFor(()=>expect(screen.getByRole("tabpanel").querySelector(".search-hit-mark")?.textContent).toBe("命中"));
  expect(api.save).not.toHaveBeenCalled();expect(api.writeDraft).not.toHaveBeenCalled();expect(screen.getByRole("searchbox",{name:"搜索笔记"})).toHaveProperty("value","命中");
  fireEvent.click(tab("来源.md"));expect(view()).toBe(source);fireEvent.click(tab("目标.md"));
  expect(screen.getByRole("tabpanel").querySelector(".search-hit-mark,.cm-vault-search-hit")).toBeNull();
 });
 it("文件名结果只激活原标签，不移动光标；上下键/Enter 可选具体命中",async()=>{
  const {mount}=fixture(kind);mount();await open("文件名专用.md");const editor=view();act(()=>editor.dispatch({selection:{anchor:3}}));await open("来源.md");
  const group=await search("文件名专用","文件名专用.md");expect(hits(group)).toHaveLength(0);fireEvent.click(within(group).getByRole("button",{name:"文件名专用.md，文件名匹配"}));
  await active("文件名专用.md");expect(view()).toBe(editor);expect(editor.state.selection.main.head).toBe(3);
  await search("命中");const input=screen.getByRole("searchbox",{name:"搜索笔记"});fireEvent.keyDown(input,{key:"ArrowDown"});fireEvent.keyDown(input,{key:"Enter"});
  await active("目标.md");await waitFor(()=>expect(chosenText()).toBe("命中"));expect(view().state.selection.main.from).toBe(target.indexOf("命中",target.indexOf("命中")+2));
 });
 it("未保存内容前插后唯一重定位，保留撤销和最新输入",async()=>{
  const {mount}=fixture(kind);mount();await open("目标.md");const editor=view(),prefix="新增内容\n\n";put(editor,prefix+target);await open("来源.md");
  const group=await search("命中");fireEvent.click(hits(group)[2]);await active("目标.md");
  await waitFor(()=>expect(chosenText()).toBe("命中"));expect(editor.state.selection.main.from).toBe(prefix.length+target.lastIndexOf("命中"));expect(view()).toBe(editor);
  expect(editor.state.doc.toString()).toBe(prefix+target);act(()=>{undo(editor);});expect(editor.state.doc.toString()).toBe(target);
 });
 it("无法确认原命中时保留位置；明确重查当前冲突内容后可重新选择",async()=>{
  const {mount,vault,api}=fixture(kind);mount();await open("目标.md");const editor=view();const group=await search("命中");
  put(editor,"# 全新段落\n\n另一份命中，没有原上下文。");vault.put("目标.md","# 外部改动");
  fireEvent.click(screen.getByRole("button",{name:"保存"}));await screen.findByText("保存需处理");
  const before=editor.state.selection.main.head;fireEvent.click(hits(group)[0]);
  await screen.findByRole("button",{name:"在当前内容中查找"});expect(editor.state.selection.main.head).toBe(before);expect(editor.state.doc.toString()).toContain("另一份命中");
  api.save.mockClear();fireEvent.click(screen.getByRole("button",{name:"在当前内容中查找"}));
  await screen.findByText(/当前内容：目标.md（冲突分支快照）/);
  const current=await screen.findByRole("region",{name:"搜索结果：目标.md"});await waitFor(()=>expect(hits(current)).toHaveLength(1));
  fireEvent.click(hits(current)[0]);await waitFor(()=>expect(chosenText()).toBe("命中"));expect(api.save).not.toHaveBeenCalled();
 });
 it.each(["恢复草稿","丢弃草稿"])("待确认草稿不提前定位，%s 后使用确认内容",async(action)=>{
  const {mount,vault,api}=fixture(kind),base=vault.notes.get("目标.md")!,prefix="草稿新增\n\n";
  vault.stored.set("目标.md",{path:"目标.md",content:prefix+target,baseVersion:base.version});
  mount();await open("来源.md");const group=await search("命中");fireEvent.click(hits(group)[1]);await active("目标.md");
  expect(screen.getByRole("button",{name:"恢复草稿"})).toBeTruthy();expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:action}));
  if(action==="丢弃草稿")fireEvent.click(within(await screen.findByRole("dialog",{name:"丢弃恢复草稿？"})).getByRole("button",{name:"确定"}));
  await waitFor(()=>expect(chosenText()).toBe("命中"));expect(view().state.doc.toString()).toBe(action==="恢复草稿"?prefix+target:target);
 });
 it("迟到读取被切换标签取消，不新建或抢回目标标签",async()=>{
  const {mount,api}=fixture(kind);mount();await open("其他.md");await open("来源.md");const group=await search("命中"),done=deferred(),read=api.read.getMockImplementation()!;
  api.read.mockImplementation(async path=>{if(path==="目标.md")await done.promise;return read(path);});
  fireEvent.click(hits(group)[0]);await waitFor(()=>expect(api.read).toHaveBeenCalledWith("目标.md"));
  fireEvent.click(tab("其他.md"));await act(async()=>{done.resolve();await done.promise;});await active("其他.md");expect(tab("目标.md")).toBeUndefined();
 });
 it("清空查询和关闭搜索取消在途读取；Wiki 导航不被旧搜索抢回",async()=>{
  const {mount,api}=fixture(kind);mount();await open("来源.md");const group=await search("命中"),done=deferred(),read=api.read.getMockImplementation()!;
  api.read.mockImplementation(async path=>{if(path==="目标.md")await done.promise;return read(path);});
  fireEvent.click(hits(group)[0]);await waitFor(()=>expect(api.read).toHaveBeenCalledWith("目标.md"));
  fireEvent.change(screen.getByRole("searchbox",{name:"搜索笔记"}),{target:{value:""}});
  await act(async()=>{done.resolve();await done.promise;});await active("来源.md");expect(tab("目标.md")).toBeUndefined();
 });
 it("阅读中的链接 URL 命中定位所属块，只有明确操作才切源码",async()=>{
  const {mount}=fixture(kind);mount();await open("目标.md");fireEvent.click(screen.getByRole("button",{name:"阅读"}));
  const group=await search("hidden-target");fireEvent.click(hits(group)[0]);await screen.findByRole("button",{name:"在源码中查看"});
  expect(screen.getByRole("button",{name:"阅读"}).getAttribute("aria-pressed")).toBe("true");expect(screen.getByRole("tabpanel").querySelector(".search-hit-mark")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"在源码中查看"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"源码"}).getAttribute("aria-pressed")).toBe("true"));await waitFor(()=>expect(chosenText()).toBe("hidden-target"));
 });
it("目标慢读期间回到源文继续输入会取消导航，保持新输入",async()=>{
  const {mount,api}=fixture(kind);mount();await open("来源.md");const source=view(),group=await search("命中"),done=deferred(),read=api.read.getMockImplementation()!;
  api.read.mockImplementation(async path=>{if(path==="目标.md")await done.promise;return read(path);});
  fireEvent.click(hits(group)[0]);await waitFor(()=>expect(api.read).toHaveBeenCalledWith("目标.md"));
  const latest=source.state.doc.toString()+"\n回到源文继续输入";put(source,latest);source.focus();
  await act(async()=>{done.resolve();await done.promise;});await active("来源.md");
  expect(view()).toBe(source);expect(source.state.doc.toString()).toBe(latest);expect(tab("目标.md")).toBeUndefined();
 });
 it("恢复 CRLF 草稿的程序同步不作为用户输入取消定位",async()=>{
  const {mount,api,vault}=fixture(kind),base=vault.notes.get("目标.md")!,draft=("新增草稿\n\n"+target).replaceAll("\n","\r\n");
  vault.stored.set("目标.md",{path:"目标.md",content:draft,baseVersion:base.version});
  mount();await open("来源.md");const group=await search("命中");fireEvent.click(hits(group)[1]);await active("目标.md");
  fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));await waitFor(()=>expect(chosenText()).toBe("命中"));
  expect(view().state.doc.toString()).toBe(draft.replaceAll("\r\n","\n"));expect(api.save).not.toHaveBeenCalled();
 });

it("读取失败保留源编辑和草稿，不创建空目标",async()=>{
  const {mount,api,vault}=fixture(kind);mount();await open("来源.md");const source=view();put(source,source.state.doc.toString()+"\n未保存输入");
  const group=await search("命中");api.read.mockRejectedValueOnce(new WorkspaceError("permission","拒绝读取"));
  fireEvent.click(hits(group)[0]);await screen.findByText(/无法打开笔记：拒绝读取/);await active("来源.md");
  expect(view()).toBe(source);expect(source.state.doc.toString()).toContain("未保存输入");expect(tab("目标.md")).toBeUndefined();expect(vault.notes.get("目标.md")!.content).toBe(target);
 });
 it("关闭搜索侧栏取消在途读取，重新打开不重放",async()=>{
  const {mount,api}=fixture(kind);mount();await open("来源.md");const group=await search("命中"),done=deferred(),read=api.read.getMockImplementation()!;
  api.read.mockImplementation(async path=>{if(path==="目标.md")await done.promise;return read(path);});
  fireEvent.click(hits(group)[0]);await waitFor(()=>expect(api.read).toHaveBeenCalledWith("目标.md"));
  fireEvent.click(screen.getByRole("button",{name:"关闭搜索"}));await act(async()=>{done.resolve();await done.promise;});await active("来源.md");expect(tab("目标.md")).toBeUndefined();
  fireEvent.click(screen.getByRole("button",{name:"搜索"}));expect(screen.getByRole("searchbox",{name:"搜索笔记"})).toHaveProperty("value","");
 });
 it.each(["搜索后Wiki","Wiki后搜索"])("%s 的最后请求优先，旧请求不再移动同一文件光标",async(order)=>{
  const {mount,api}=fixture(kind);mount();await open("来源.md");const source=view(),group=await search("命中"),done=deferred(),read=api.read.getMockImplementation()!;
  api.read.mockImplementation(async path=>{if(path==="目标.md")await done.promise;return read(path);});
  const wiki=()=>{act(()=>source.dispatch({selection:{anchor:source.state.doc.toString().indexOf("[[")+3}}));fireEvent.keyDown(source.contentDOM,{key:"Enter",code:"Enter",ctrlKey:true});};
  if(order==="搜索后Wiki")fireEvent.click(hits(group)[1]);else wiki();
  await waitFor(()=>expect(api.read.mock.calls.filter(call=>call[0]==="目标.md")).toHaveLength(1));
  if(order==="搜索后Wiki")wiki();else fireEvent.click(hits(group)[1]);
  await waitFor(()=>expect(api.read.mock.calls.filter(call=>call[0]==="目标.md")).toHaveLength(2));
  await act(async()=>{done.resolve();await done.promise;});await active("目标.md");
  if(order==="搜索后Wiki"){await waitFor(()=>expect(view().state.selection.main.from).toBe(0));expect(chosenText()).toBe("");expect(view().dom.querySelector(".cm-vault-search-hit")).toBeNull();}
  else {await waitFor(()=>expect(chosenText()).toBe("命中"));expect(view().state.selection.main.from).toBe(target.indexOf("命中",target.indexOf("命中")+2));}
 });
 it("保存中定位后继续输入，迟到确认不覆盖新内容或重放选区",async()=>{
  const {mount,api,vault}=fixture(kind),done=deferred();let delayed=true;
  api.save.mockImplementation(async(path,content,version)=>{if(delayed)await done.promise;return vault.save(path,content,version);});
  mount();await open("目标.md");const editor=view(),prefix="正在保存的新增内容\n\n";put(editor,prefix+target);
  const group=await search("命中");fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(api.save).toHaveBeenCalled());
  fireEvent.click(hits(group)[1]);await waitFor(()=>expect(chosenText()).toBe("命中"));
  const latest=editor.state.doc.toString()+"\n继续输入";put(editor,latest);
  await act(async()=>{done.resolve();await done.promise;});await waitFor(()=>expect(vault.notes.get("目标.md")!.content).toBe(prefix+target));
  expect(editor.state.doc.toString()).toBe(latest);expect(editor.state.selection.main.head).toBe(latest.length);expect(editor.dom.querySelector(".cm-vault-search-hit")).toBeNull();
  delayed=false;fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(vault.notes.get("目标.md")!.content).toBe(latest));expect(view()).toBe(editor);
 });
 it("目标组字未结束时等待，结束后再定位而不改正文",async()=>{
  const {mount,api}=fixture(kind);mount();await open("目标.md");const editor=view();act(()=>editor.dispatch({selection:{anchor:2}}));fireEvent.compositionStart(editor.contentDOM);
  await open("来源.md");const group=await search("命中");fireEvent.click(hits(group)[1]);await active("目标.md");
  expect(editor.state.selection.main.head).toBe(2);fireEvent.compositionEnd(editor.contentDOM);
  await waitFor(()=>expect(chosenText()).toBe("命中"));expect(editor.state.doc.toString()).toBe(target);expect(api.save).not.toHaveBeenCalled();
 });

 it("CRLF 源码范围映射正确，高亮和人工改选区不触发正文保存",async()=>{
  const {mount,vault,api}=fixture(kind),content="# 标题\r\n\r\n😀 前缀 命中\r\n\r\n末尾";vault.put("目标.md",content);mount();await open("来源.md");const group=await search("命中");fireEvent.click(hits(group)[0]);await active("目标.md");
  await waitFor(()=>expect(chosenText()).toBe("命中"));expect(view().state.selection.main.from).toBe(rawSearchOffset(content,content.indexOf("命中")));
  act(()=>view().dispatch({selection:{anchor:1}}));await waitFor(()=>expect(view().dom.querySelector(".cm-vault-search-hit")).toBeNull());
  expect(api.save).not.toHaveBeenCalled();expect(api.writeDraft).not.toHaveBeenCalled();expect(vault.notes.get("目标.md")!.content).toBe(content);
 });
});
