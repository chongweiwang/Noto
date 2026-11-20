// @vitest-environment jsdom
import "../test/codemirror-dom";
import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {EditorView} from "@codemirror/view";
import {undo} from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import {MemoryVault} from "../test/memory-vault";
import {WorkspaceRuntimeContext,type WorkspaceRuntime} from "../lib/workspace-runtime";
import {WorkspaceError} from "../lib/api-error";
import type {WorkspaceApi} from "../lib/vault-api";
import {appendTask,taskCategoryMarker} from "../lib/tasks";
import {createCanvasNode,serializeCanvas} from "../lib/canvas-document";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
const target="# 开篇\n\n正文\n\n## 重复\n\n首节\n\n## 重复\n\n末节";
const source="[[目标#重复-1|重复标题]]\n\n[[目标#新标题|未保存标题]]\n\n[[目标#恢复标题|恢复标题]]\n\n[[目标#不存在|缺失标题]]\n\n[[同名#重复-1|选择同名]]\n\n[[#自己|同篇]]\n\n# 自己";
beforeEach(()=>{
 localStorage.clear();vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});
 Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,writable:true,value:vi.fn()});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture(kind:"desktop"|"web"){
 const vault=new MemoryVault();vault.put("源.md",source);vault.put("目标.md",target);vault.put("其他.md","# 其他\n\n原文");
 vault.put("甲/同名.md",target);vault.put("乙/同名.md",target);
 vault.put("任务/工作/开发.md",appendTask(taskCategoryMarker+"\n\n# 开发\n","关联核对").content);
 vault.put("空间.canvas",serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{id:"text",text:"[[#开篇|本地标题]]\n\n[[目标#重复-1|跨篇标题]]"})],edges:[]}));
 const api={...vault,status:async()=>({vault:"wiki-tests",id:"wiki-tests",error:null}),
 read:vi.fn(async(path:string)=>{if(!vault.notes.has(path))throw new WorkspaceError("not_found","文件不存在");return vault.read(path);}),
 save:vi.fn(vault.save),writeDraft:vi.fn(vault.writeDraft),removeDraft:vi.fn(vault.removeDraft),
 chooseDirectory:vi.fn(),selectVault:vi.fn(),createVault:vi.fn(),chooseFile:vi.fn(),importAttachment:vi.fn(),image:vi.fn(),openItem:vi.fn(),openAttachment:vi.fn(),openExternal:vi.fn(),remove:vi.fn()} satisfies WorkspaceApi;
 const runtime:WorkspaceRuntime={kind,api,...(kind==="desktop"?{nativeWindow:{destroy:vi.fn(async()=>{}),onCloseRequested:vi.fn(async()=>()=>{})}}:{})};
 const mount=()=>render(<WorkspaceRuntimeContext.Provider value={runtime}><DesktopApp/></WorkspaceRuntimeContext.Provider>);
 return {vault,api,mount};
}
function tab(path:string){return screen.getAllByRole("tab").find(item=>item.getAttribute("title")===path) as HTMLButtonElement;}
async function active(path:string){await waitFor(()=>{expect(tab(path)?.getAttribute("aria-selected")).toBe("true");expect(tab(path).disabled).toBe(false);});}
async function open(path:string){
 const buttons=await screen.findAllByRole("button",{name:path});
 fireEvent.click(buttons.find(button=>button.closest(".file-tree-root"))!);await active(path);
 if(path.endsWith(".md"))await waitFor(()=>expect(screen.getByRole("tabpanel").querySelector(".cm-editor")).toBeTruthy());
}
function view(){return EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!;}
function put(view:EditorView,value:string){act(()=>view.dispatch({changes:{from:0,to:view.state.doc.length,insert:value},selection:{anchor:value.length},userEvent:"input.type"}));}
async function link(label:string){
 const editor=view(),at=editor.state.doc.toString().indexOf("|"+label);
 act(()=>editor.dispatch({selection:{anchor:at}}));
 fireEvent.keyDown(editor.contentDOM,{key:"Enter",code:"Enter",ctrlKey:true});
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};}
describe.each(["desktop","web"] as const)("Wiki 标题导航 %s",kind=>{
 it("切换主题保留原笔记编辑器、选区、撤销与草稿",async()=>{
  const {mount,vault,api}=fixture(kind);mount();await open("目标.md");const editor=view(),updated=target+"\n\n未保存内容";
  put(editor,updated);act(()=>editor.dispatch({selection:{anchor:3,head:5}}));
  fireEvent.click(screen.getByRole("button",{name:"软件设置"}));const dialog=screen.getByRole("dialog",{name:"软件设置"});
  fireEvent.click(within(dialog).getByRole("button",{name:"Nord"}));fireEvent.click(within(dialog).getByRole("button",{name:"完成"}));
  expect(view()).toBe(editor);expect(editor.state.doc.toString()).toBe(updated);expect(editor.state.selection.main.from).toBe(3);expect(editor.state.selection.main.to).toBe(5);
  expect(document.querySelector(".desktop-app")?.getAttribute("data-theme-id")).toBe("nord");
  await waitFor(()=>expect(vault.notes.get("目标.md")?.content).toBe(updated),{timeout:4000});
  expect(api.removeDraft).not.toHaveBeenCalledWith(expect.objectContaining({path:"源.md"}));
  act(()=>{undo(editor);});expect(editor.state.doc.toString()).toBe(target);
 },10000);
 it("切换主题不会消除待确认恢复草稿",async()=>{
  const {mount,vault,api}=fixture(kind),base=vault.notes.get("目标.md")!;
  vault.stored.set("目标.md",{path:"目标.md",content:"需要确认的恢复内容",baseVersion:base.version});mount();await open("目标.md");
  expect(screen.getByRole("button",{name:"恢复草稿"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"软件设置"}));const dialog=screen.getByRole("dialog",{name:"软件设置"});
  fireEvent.click(within(dialog).getByRole("button",{name:"Solarized Light"}));fireEvent.click(within(dialog).getByRole("button",{name:"完成"}));
  expect(vault.stored.get("目标.md")?.content).toBe("需要确认的恢复内容");expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));await waitFor(()=>expect(view().state.doc.toString()).toBe("需要确认的恢复内容"));
 });
 it("块引用等待恢复草稿并定位恢复后的正文",async()=>{
  const {api,vault,mount}=fixture(kind),base=vault.notes.get("目标.md")!,draft=target+"\n\n恢复块 ^restore";
  vault.put("源.md","[[目标#^restore|块恢复]]");vault.stored.set("目标.md",{path:"目标.md",content:draft,baseVersion:base.version});
  mount();await open("源.md");await link("块恢复");await active("目标.md");
  expect(screen.getByRole("button",{name:"恢复草稿"})).toBeTruthy();expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));
  await waitFor(()=>expect(view().state.selection.main.head).toBe(draft.indexOf("恢复块")));
  expect(view().state.doc.toString()).toBe(draft);expect(api.save).not.toHaveBeenCalled();
 });
 it("命令复制当前块时创建可撤销标记并走原编辑会话",async()=>{
  const {mount,vault}=fixture(kind),clipboard={writeText:vi.fn(async(_text:string)=>{})};vi.stubGlobal("navigator",Object.assign(Object.create(navigator),{clipboard}));
  mount();await open("目标.md");const editor=view();act(()=>editor.dispatch({selection:{anchor:target.indexOf("正文")}}));
  fireEvent.click(screen.getByRole("button",{name:"命令面板"}));const palette=await screen.findByRole("dialog",{name:"命令面板"});
  fireEvent.click(within(palette).getByRole("option",{name:/复制当前块 Wiki 链接/}));
  await waitFor(()=>expect(clipboard.writeText).toHaveBeenCalledOnce());
  expect(clipboard.writeText.mock.calls[0][0]).toMatch(/^\[\[\.\/目标\.md#\^b-[0-9a-f]{32}\|正文\]\]$/);
  expect(editor.state.doc.toString()).toMatch(/正文 \^b-[0-9a-f]{32}/);expect(view()).toBe(editor);
  act(()=>{undo(editor);});expect(editor.state.doc.toString()).toBe(target);expect(vault.notes.get("目标.md")?.content).toBe(target);
 });
 it("阅读中右键只复制已有唯一块标记",async()=>{
  const {mount,vault}=fixture(kind),body="# 标题\n\n已有正文 ^block-1",clipboard={writeText:vi.fn(async()=>{})};
  vi.stubGlobal("navigator",Object.assign(Object.create(navigator),{clipboard}));vault.put("目标.md",body);
  mount();await open("目标.md");const editor=view();fireEvent.click(screen.getByRole("button",{name:"阅读"}));
  const block=screen.getByRole("tabpanel").querySelector(`[data-block-from="${body.indexOf("已有正文")}"]`)!;fireEvent.contextMenu(block);
  fireEvent.click(screen.getByRole("menuitem",{name:"复制当前块 Wiki 链接"}));
  await waitFor(()=>expect(clipboard.writeText).toHaveBeenCalledWith("[[./目标.md#^block-1|已有正文]]"));
  expect(editor.state.doc.toString()).toBe(body);
 });
 it("慢保存期间创建块标记并继续输入，迟到确认不覆盖新内容",async()=>{
  const {mount,vault,api}=fixture(kind),done=deferred(),clipboard={writeText:vi.fn(async()=>{})};let first=true;
  vi.stubGlobal("navigator",Object.assign(Object.create(navigator),{clipboard}));
  api.save.mockImplementation(async(path,content,version)=>{if(first){first=false;await done.promise;}return vault.save(path,content,version);});
  mount();await open("目标.md");const editor=view(),before=target+"\n\n继续编辑";put(editor,before);
  fireEvent.click(screen.getByRole("button",{name:"保存"}));await waitFor(()=>expect(api.save).toHaveBeenCalled());
  act(()=>editor.dispatch({selection:{anchor:before.indexOf("正文")}}));fireEvent.click(screen.getByRole("button",{name:"命令面板"}));
  const palette=await screen.findByRole("dialog",{name:"命令面板"});fireEvent.click(within(palette).getByRole("option",{name:/复制当前块 Wiki 链接/}));
  await waitFor(()=>expect(clipboard.writeText).toHaveBeenCalledOnce());const marked=editor.state.doc.toString();expect(marked).toMatch(/正文 \^b-[0-9a-f]{32}/);
  put(editor,marked+"\n新输入");await act(async()=>{done.resolve();await done.promise;});
  await waitFor(()=>expect(vault.notes.get("目标.md")?.content).toBe(before));
  expect(editor.state.doc.toString()).toBe(marked+"\n新输入");expect(view()).toBe(editor);
 });
 it.each(["实时编辑","源码","阅读","分屏"])("块链接在 %s 中复用目标会话并定位具体段落",async mode=>{
  const {mount,vault,api}=fixture(kind),body="# 标题\n\n第一段\n\n目标段落 ^decision\n\n后续";
  vault.put("源.md","[[目标#^decision|块入口]]");vault.put("目标.md",body);
  mount();await open("目标.md");const targetEditor=view();fireEvent.click(screen.getByRole("button",{name:mode}));
  await open("源.md");await link("块入口");await active("目标.md");
  await waitFor(()=>expect(document.querySelector(".status-notice")?.textContent).toContain("已定位块"));
  expect(view()).toBe(targetEditor);expect(targetEditor.state.doc.toString()).toBe(body);
  if(mode!=="阅读")expect(targetEditor.state.selection.main.head).toBe(body.indexOf("目标段落"));
  if(mode==="阅读"||mode==="分屏")await waitFor(()=>expect(screen.getByRole("tabpanel").querySelector(`[data-block-from="${body.indexOf("目标段落")}"]`)).toBeTruthy());
  expect(api.save).not.toHaveBeenCalled();
 });
 it.each(["实时编辑","源码","阅读","分屏"])("已有目标保持 %s 视图，精确重名定位，重复导航不会回放旧跳转",async(mode)=>{
  const {mount,api}=fixture(kind);mount();await open("目标.md");const original=view();
  fireEvent.click(screen.getByRole("button",{name:mode}));
  await open("源.md");const from=view();act(()=>from.dispatch({selection:{anchor:from.state.doc.length}}));
  await link("重复标题");await active("目标.md");
  await waitFor(()=>expect(document.querySelector(".status-notice")?.textContent).toContain("已定位标题：重复"));
  expect(screen.getByRole("button",{name:mode}).getAttribute("aria-pressed")).toBe("true");expect(view()).toBe(original);
  if(mode!=="阅读")expect(original.state.selection.main.head).toBe(target.lastIndexOf("## 重复"));
  if(mode==="阅读"||mode==="分屏")await waitFor(()=>expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.some(node=>(node as HTMLElement).id==="重复-1")).toBe(true));
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(tab("源.md"));expect(view()).toBe(from);
  await link("重复标题");await active("目标.md");
  await waitFor(()=>expect(document.querySelector(".status-notice")?.textContent).toContain("已定位标题"));
  if(mode!=="阅读"){
   act(()=>original.dispatch({selection:{anchor:1}}));fireEvent.click(tab("源.md"));fireEvent.click(tab("目标.md"));
   expect(original.state.selection.main.head).toBe(1);
  }
 });
 it("标题定位读取未保存/冲突分支，保留原会话与撤销历史，不触发保存",async()=>{
  const {api,vault,mount}=fixture(kind);mount();await open("目标.md");const editor=view(),latest=target+"\n\n# 新标题\n\n未保存正文";
  put(editor,latest);vault.put("目标.md","# 外部已改");
  fireEvent.click(screen.getByRole("button",{name:"保存"}));await screen.findByText("保存需处理");
  await open("源.md");api.save.mockClear();await link("未保存标题");await active("目标.md");
  await waitFor(()=>expect(editor.state.selection.main.head).toBe(latest.indexOf("# 新标题")));
  expect(view()).toBe(editor);expect(editor.state.doc.toString()).toBe(latest);expect(screen.getByText("保存需处理")).toBeTruthy();expect(api.save).not.toHaveBeenCalled();
  act(()=>{undo(editor);});expect(editor.state.doc.toString()).toBe(target);
 });
 it("目标恢复草稿必须先选择，恢复后再用草稿正文定位，不提前落盘",async()=>{
  const {api,vault,mount}=fixture(kind),base=vault.notes.get("目标.md")!;
  vault.stored.set("目标.md",{path:"目标.md",content:target+"\n\n# 恢复标题",baseVersion:base.version});
  mount();await open("源.md");await link("恢复标题");await active("目标.md");
  expect(screen.getByRole("button",{name:"恢复草稿"})).toBeTruthy();expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"恢复草稿"}));
  await waitFor(()=>expect(view().state.selection.main.head).toBe((target+"\n\n# 恢复标题").lastIndexOf("# 恢复标题")));
  expect(view().state.doc.toString()).toContain("# 恢复标题");expect(api.save).not.toHaveBeenCalled();
 });
 it("目标输入法尚在组字时等待结束，不抢光标或改写组字内容",async()=>{
  const {mount}=fixture(kind);mount();await open("目标.md");const editor=view();act(()=>editor.dispatch({selection:{anchor:2}}));
  fireEvent.compositionStart(editor.contentDOM);await open("源.md");await link("重复标题");await active("目标.md");
  expect(editor.state.selection.main.head).toBe(2);expect(editor.state.doc.toString()).toBe(target);
  fireEvent.compositionEnd(editor.contentDOM);
  await waitFor(()=>expect(editor.state.selection.main.head).toBe(target.lastIndexOf("## 重复")));
 });
 it("丢弃恢复草稿后读取最新磁盘并继续待定位请求",async()=>{
  const {vault,mount}=fixture(kind),base=vault.notes.get("目标.md")!;
  vault.stored.set("目标.md",{path:"目标.md",content:"# 旧草稿",baseVersion:base.version});
  mount();await open("源.md");await link("未保存标题");await active("目标.md");
  const latest=target+"\n\n# 新标题";vault.put("目标.md",latest);
  fireEvent.click(screen.getByRole("button",{name:"丢弃草稿"}));
  fireEvent.click(within(await screen.findByRole("dialog",{name:"丢弃恢复草稿？"})).getByRole("button",{name:"确定"}));
  await waitFor(()=>expect(view().state.doc.toString()).toBe(latest));
  await waitFor(()=>expect(view().state.selection.main.head).toBe(latest.indexOf("# 新标题")));
 });
 it("缺失标题保留目标光标，同篇来源明确，缺失文件不会新建",async()=>{
  const {api,mount}=fixture(kind);mount();await open("目标.md");const editor=view();act(()=>editor.dispatch({selection:{anchor:2}}));
  await open("源.md");await link("缺失标题");await active("目标.md");
  await screen.findByText("文件存在，标题不存在：目标.md#不存在");expect(editor.state.selection.main.head).toBe(2);
  fireEvent.click(tab("源.md"));await link("同篇");await waitFor(()=>expect(view().state.selection.main.head).toBe(source.indexOf("# 自己")));
  expect(screen.queryByText("文件存在，标题不存在：目标.md#不存在")).toBeNull();
  const before=screen.getAllByRole("tab").length;put(view(),"[[丢失#标题|坏链接]]");await link("坏链接");
  await screen.findByText(/找不到 Wiki 链接目标/);expect(screen.getAllByRole("tab")).toHaveLength(before);expect(api.save).not.toHaveBeenCalled();
 });
 it("同名选择保留原标题片段与来源，不猜第一个文件",async()=>{
  const {mount}=fixture(kind);mount();await open("源.md");await link("选择同名");
  const dialog=await screen.findByRole("dialog",{name:"选择链接目标"});fireEvent.click(within(dialog).getByRole("button",{name:"乙/同名.md"}));
  await active("乙/同名.md");await waitFor(()=>expect(view().state.selection.main.head).toBe(target.lastIndexOf("## 重复")));
 });
 it("读取迟到时切换标签会取消，不能新建或抢回目标标签",async()=>{
  const {api,vault,mount}=fixture(kind);mount();await open("其他.md");await open("源.md");const done=deferred(),read=api.read.getMockImplementation()!;
  api.read.mockImplementation(async(path)=>{if(path==="目标.md")await done.promise;return read(path);});
  const count=api.read.mock.calls.length;await link("重复标题");await waitFor(()=>expect(api.read.mock.calls.length).toBeGreaterThan(count));
  fireEvent.click(tab("其他.md"));await act(async()=>{done.resolve();await done.promise;});
  await active("其他.md");expect(tab("目标.md")).toBeUndefined();expect(vault.stored.size).toBe(0);
 });
 it("更晚的导航优先，迟到读取不能覆盖同篇定位",async()=>{
  const {api,mount}=fixture(kind);mount();await open("源.md");const done=deferred(),read=api.read.getMockImplementation()!;
  api.read.mockImplementation(async(path)=>{if(path==="目标.md")await done.promise;return read(path);});
  const count=api.read.mock.calls.length;await link("重复标题");await waitFor(()=>expect(api.read.mock.calls.length).toBeGreaterThan(count));
  await link("同篇");await waitFor(()=>expect(view().state.selection.main.head).toBe(source.indexOf("# 自己")));
  await act(async()=>{done.resolve();await done.promise;});await active("源.md");expect(tab("目标.md")).toBeUndefined();
 });
 it("大纲复制使用精确重名 ID，剪贴板失败可手动复制，正文和光标不变",async()=>{
  const {mount}=fixture(kind);mount();await open("目标.md");const editor=view();act(()=>editor.dispatch({selection:{anchor:3}}));
  const clipboard={writeText:vi.fn(async()=>{})};vi.stubGlobal("navigator",Object.assign(Object.create(navigator),{clipboard}));
  if(screen.queryByRole("button",{name:"显示标题大纲"}))fireEvent.click(screen.getByRole("button",{name:"显示标题大纲"}));
  fireEvent.click(screen.getByRole("button",{name:"复制标题 Wiki 链接：重复 · 第 9 行"}));
  await waitFor(()=>expect(clipboard.writeText).toHaveBeenCalledWith("[[./目标.md#重复-1|重复]]"));
  expect(editor.state.doc.toString()).toBe(target);expect(editor.state.selection.main.head).toBe(3);
  clipboard.writeText.mockRejectedValueOnce(Error("denied"));fireEvent.contextMenu(screen.getAllByRole("button",{name:"重复"})[0].closest(".outline-row")!);
  fireEvent.click(screen.getByRole("menuitem",{name:"复制 Wiki 标题链接"}));
  const manual=await screen.findByRole("dialog",{name:/手动复制/});expect(within(manual).getByRole("textbox").textContent).toBe("[[./目标.md#重复|重复]]");
 });
 it("任务备注同篇定位使用整个分类文件，切回任务标签仍保留备注输入",async()=>{
  const {mount}=fixture(kind);mount();await screen.findByRole("button",{name:"源.md"});fireEvent.click(screen.getByRole("button",{name:"任务管理"}));
  fireEvent.click(await screen.findByRole("button",{name:"开发"}));await screen.findByRole("heading",{name:"开发"});
  fireEvent.click(await screen.findByRole("button",{name:"关联核对"}));
  const remark=await screen.findByLabelText("Markdown 备注") as HTMLTextAreaElement;fireEvent.change(remark,{target:{value:"[[#开发|返回分类标题]]"}});
  fireEvent.click(within(screen.getByRole("group",{name:"备注视图"})).getByRole("button",{name:"预览"}));
  fireEvent.click(await screen.findByRole("link",{name:"返回分类标题"}));await active("任务/工作/开发.md");
  await waitFor(()=>expect(document.querySelector(".status-notice")?.textContent).toContain("已定位标题：开发"));
  expect(view().state.doc.toString()).toContain("[[#开发|返回分类标题]]");
  fireEvent.click(screen.getByRole("tab",{name:/^任务管理/}));fireEvent.click(within(screen.getByRole("group",{name:"备注视图"})).getByRole("button",{name:"编辑"}));
  expect((screen.getByLabelText("Markdown 备注") as HTMLTextAreaElement).value).toBe("[[#开发|返回分类标题]]");
 });
 it("画布文本拒绝同篇 Markdown 标题，跨篇可跳转且不写画布",async()=>{
  const {api,mount}=fixture(kind);mount();await open("空间.canvas");
  fireEvent.click(await screen.findByRole("link",{name:"本地标题"}));await screen.findByText("同篇标题仅用于 Markdown 笔记");await active("空间.canvas");
  fireEvent.click(screen.getByRole("link",{name:"跨篇标题"}));await active("目标.md");
  await waitFor(()=>expect(view().state.selection.main.head).toBe(target.lastIndexOf("## 重复")));expect(api.save).not.toHaveBeenCalled();
 });
});
