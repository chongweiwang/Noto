// @vitest-environment jsdom
import "../test/codemirror-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import { WorkspaceRuntimeContext } from "../lib/workspace-runtime";
import type { WorkspaceApi } from "../lib/vault-api";
import { MemoryVault } from "../test/memory-vault";
import { defaultPreferences, emptyWorkspace, normalizePreferences, normalizeWorkspace, preferencesKey, workspaceStorageKey } from "../lib/workspace-state";
import { WorkspaceError } from "../lib/api-error";

vi.mock("../lib/mermaid", () => ({ renderMermaid: async () => "<svg />" }));
beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture(id = "server/vault-a") {
  const vault = new MemoryVault(); vault.put("项目/a.md", "第一篇正文"); vault.put("b.md", "第二篇正文"); vault.put("c.md", "第三篇正文"); vault.folders.add("归档");
  const api = { ...vault, status: async () => ({ vault: "vault", error: null, id }), selectVault: vi.fn(), createVault: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), importAttachment: vi.fn(), image: vi.fn(), remove: vi.fn(), openAttachment: vi.fn(), openExternal: vi.fn(), openItem: vi.fn() } as WorkspaceApi;
  const mount = () => render(<WorkspaceRuntimeContext.Provider value={{ kind: "web", api }}><DesktopApp /></WorkspaceRuntimeContext.Provider>);
  return { vault, api, mount, key: workspaceStorageKey("web", id) };
}
function editor() { return EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!; }
async function open(name: string) { fireEvent.click(await screen.findByRole("button", { name })); await screen.findByRole("tab", { name, selected: true }); return waitFor(() => editor()); }
function edit(view: EditorView, value: string) { act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length }, userEvent: "input.type" })); }
function menu(name: string, action: string) { fireEvent.contextMenu(screen.getByRole("tab", { name: new RegExp(name) })); fireEvent.click(screen.getByRole("menuitem", { name: action })); }
function flushUI() { act(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true }))); }

it("自动保存延迟即时生效，草稿先落盘且不重建编辑器或撤销历史", async () => {
  const { mount, vault } = fixture(); mount();
  const view = await open("a.md");
  fireEvent.click(screen.getByRole("button", { name: "软件设置" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "工作区" }));
  fireEvent.change(screen.getByLabelText("自动保存延迟"), { target: { value: "10000" } });
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  expect(JSON.parse(localStorage.getItem(preferencesKey)!).autoSaveDelay).toBe(10000);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  edit(view, "延迟保存的正文");
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(vault.stored.get("项目/a.md")?.content).toBe("延迟保存的正文");
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(vault.notes.get("项目/a.md")?.content).toBe("第一篇正文");
  fireEvent.click(screen.getByRole("button", { name: "软件设置" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "工作区" }));
  fireEvent.change(screen.getByLabelText("自动保存延迟"), { target: { value: "5000" } });
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
  expect(vault.notes.get("项目/a.md")?.content).toBe("第一篇正文");
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(vault.notes.get("项目/a.md")?.content).toBe("延迟保存的正文");
  expect(editor()).toBe(view);
  act(() => { undo(view); });
  expect(view.state.doc.toString()).toBe("第一篇正文");
  fireEvent.keyDown(view.contentDOM, { key: "s", ctrlKey: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(vault.notes.get("项目/a.md")?.content).toBe("第一篇正文");
});

it("旧设置和无效保存延迟回退默认值，有效延迟可恢复", () => {
  for (const autoSaveDelay of [undefined, null, 0, -1, 500, Infinity, "5000", 120000]) {
    expect(normalizePreferences({ autoSaveDelay }).autoSaveDelay).toBe(1600);
  }
  expect(normalizePreferences({ autoSaveDelay: 30000 }).autoSaveDelay).toBe(30000);
});

it("慢保存期间调整延迟，后续输入和旧保存回调使用最新设置", async () => {
  const { mount, vault, api } = fixture();
  const originalSave = api.save;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  api.save = async (...args) => { if (++calls === 1) await pending; return originalSave(...args); };
  mount(); const view = await open("a.md");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  edit(view, "第一次提交");
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(calls).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "软件设置" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "工作区" }));
  fireEvent.change(screen.getByLabelText("自动保存延迟"), { target: { value: "10000" } });
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  edit(view, "保存期间的新输入");
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(calls).toBe(1);
  await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
  expect(vault.notes.get("项目/a.md")?.content).toBe("第一次提交");
  expect(view.state.doc.toString()).toBe("保存期间的新输入");
  await act(async () => { await vi.advanceTimersByTimeAsync(9999); });
  expect(calls).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(vault.notes.get("项目/a.md")?.content).toBe("保存期间的新输入");
  expect(editor()).toBe(view);
});

it("侧栏首个按钮与编辑视图切换保留同一编辑器和撤销", async () => {
  const { mount, vault } = fixture(); mount();
  const view = await open("a.md"); edit(view, "切换视图期间保留的正文");
  const bar = screen.getByRole("navigation", { name: "主要工具栏" });
  const toggle = within(bar).getByRole("button", { name: "显示或隐藏侧栏" });
  expect(bar.querySelector("button")).toBe(toggle);
  fireEvent.click(toggle); expect(screen.queryByRole("complementary", { name: "工作区侧栏" })).toBeNull();
  fireEvent.click(toggle); expect(screen.getByRole("complementary", { name: "工作区侧栏" })).toBeTruthy();
  const modes = screen.getByRole("group", { name: "编辑视图" });
  expect(within(modes).getAllByRole("button")).toHaveLength(4);
  expect(within(modes).queryByRole("button", { name: /标题大纲/ })).toBeNull();
  for (const name of ["阅读", "源码", "分屏", "实时编辑"]) {
    fireEvent.click(within(modes).getByRole("button", { name }));
    expect(within(modes).getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    expect(view.state.doc.toString()).toBe("切换视图期间保留的正文");
  }
  expect(editor()).toBe(view);
  await waitFor(() => expect(vault.stored.get("项目/a.md")?.content).toBe("切换视图期间保留的正文"));
  act(() => { undo(view); }); expect(view.state.doc.toString()).toBe("第一篇正文");
});

it("窄屏关闭自动折叠后仍能用首个按钮收起侧栏", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.setItem(preferencesKey, JSON.stringify({ ...defaultPreferences, autoCollapseSidebar: false }));
  const { mount } = fixture(); mount();
  await screen.findByRole("button", { name: "a.md" });
  await waitFor(() => expect(document.querySelector(".narrow-layout")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  const toggle = screen.getByRole("button", { name: "显示或隐藏侧栏" });
  fireEvent.click(toggle); expect(screen.queryByRole("complementary", { name: "工作区侧栏" })).toBeNull();
  fireEvent.click(toggle); expect(screen.getByRole("complementary", { name: "工作区侧栏" })).toBeTruthy();
});

it("八个主题卡片可切换，明暗快捷键保留最近选择并在重开后恢复",async()=>{
 const {mount}=fixture(),first=mount();await screen.findByRole("button",{name:"软件设置"});
 fireEvent.click(screen.getByRole("button",{name:"软件设置"}));let dialog=screen.getByRole("dialog",{name:"软件设置"});
 expect(within(dialog).getByRole("group",{name:"选择主题"}).querySelectorAll("button")).toHaveLength(8);
 fireEvent.click(within(dialog).getByRole("button",{name:"雾青"}));expect(document.querySelector(".desktop-app")?.getAttribute("data-theme-id")).toBe("jade-mist");
 fireEvent.click(within(dialog).getByRole("button",{name:"松林"}));fireEvent.click(within(dialog).getByRole("button",{name:"纸墨"}));
 fireEvent.click(within(dialog).getByRole("button",{name:"完成"}));
 fireEvent.click(screen.getByRole("button",{name:"切换为深色主题"}));expect(document.querySelector(".desktop-app")?.getAttribute("data-theme-id")).toBe("pine-forest");
 fireEvent.click(screen.getByRole("button",{name:"切换为浅色主题"}));expect(document.querySelector(".desktop-app")?.getAttribute("data-theme-id")).toBe("paper-ink");
 const saved=JSON.parse(localStorage.getItem(preferencesKey)!);expect(saved).toMatchObject({theme:"light",themeId:"paper-ink",lastDarkThemeId:"pine-forest"});expect(localStorage.getItem("noto.theme")).toBe("light");
 first.unmount();mount();await waitFor(()=>expect(document.querySelector(".desktop-app")?.getAttribute("data-theme-id")).toBe("paper-ink"));
 fireEvent.click(screen.getByRole("button",{name:"软件设置"}));dialog=screen.getByRole("dialog",{name:"软件设置"});expect(within(dialog).getByRole("button",{name:"纸墨"}).getAttribute("aria-pressed")).toBe("true");
});

it("设置、调整宽度和固定标签保留编辑器、撤销记录和后台草稿", async () => {
  const { vault, mount, key } = fixture(); mount();
  const view = await open("a.md"); edit(view, "继续编辑的正文");
  fireEvent.click(screen.getByRole("button", { name: "软件设置" }));
  const dialog = screen.getByRole("dialog", { name: "软件设置" });
  fireEvent.change(within(dialog).getByLabelText("字号"), { target: { value: "19" } });
  fireEvent.change(within(dialog).getByLabelText("主题"), { target: { value: "light" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));
  fireEvent.keyDown(screen.getByRole("separator", { name: "侧栏宽度" }), { key: "ArrowRight" });
  menu("a.md", "固定标签");
  expect(editor()).toBe(view); expect(view.state.doc.toString()).toBe("继续编辑的正文");
  expect(screen.queryByRole("button", { name: "关闭标签 a.md" })).toBeNull();
  expect(document.querySelector(".desktop-app.theme-light")?.getAttribute("style")).toContain("--editor-font-size: 19px");
  await waitFor(() => expect(vault.stored.get("项目/a.md")?.content).toBe("继续编辑的正文"));
  flushUI();
  const state = JSON.parse(localStorage.getItem(key)!);
  expect(state.sidebarWidth).toBe(260); expect(state.pinned).toEqual(["项目/a.md"]);
  expect(localStorage.getItem(key)).not.toContain("继续编辑的正文");
  act(() => { undo(view); }); expect(view.state.doc.toString()).toBe("第一篇正文");
});

it("重新打开恢复标签顺序、任务标签、视图、光标和布局，先确认草稿", async () => {
  const { vault, mount, key } = fixture();
  const saved = { ...emptyWorkspace(), tabs: ["项目/a.md", "b.md", "@tasks"], active: "项目/a.md", pinned: ["@tasks"], modes: { "项目/a.md": "source" }, sidebarWidth: 318, outlineWidth: 260, splitRatio: .65, collapsedFolders: ["归档"], editors: { "项目/a.md": { anchor: 2, head: 4, scrollTop: 125, scrollLeft: 0 } } };
  localStorage.setItem(key, JSON.stringify(saved));
  vault.stored.set("项目/a.md", { path: "项目/a.md", content: "还没有保存的草稿", baseVersion: vault.notes.get("项目/a.md")!.version });
  const first = mount();
  await screen.findByRole("button", { name: "恢复草稿" });
  expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("title"))).toEqual(["任务管理", "项目/a.md", "b.md"]);
  expect(editor().state.doc.toString()).toBe("第一篇正文");
  expect(editor().state.readOnly).toBe(true); expect(editor().state.selection.main.head).toBe(4);
  await waitFor(() => expect(editor().scrollDOM.scrollTop).toBe(125));
  expect(screen.getByRole("button", { name: "源码" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
  edit(editor(), "恢复以后继续编辑"); flushUI();
  await waitFor(() => expect(vault.stored.get("项目/a.md")?.content).toBe("恢复以后继续编辑"));
  first.unmount(); mount();
  await screen.findByRole("button", { name: "恢复草稿" });
  fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
  expect(editor().state.doc.toString()).toBe("恢复以后继续编辑");
  expect(screen.getByRole("separator", { name: "侧栏宽度" }).getAttribute("aria-valuenow")).toBe("318");
});

it("同名网页知识库使用稳定身份隔离，缺失文件的草稿仍可恢复", async () => {
  const first = fixture("server-a/vault"), second = fixture("server-b/vault");
  localStorage.setItem(first.key, JSON.stringify({ ...emptyWorkspace(), tabs: ["失踪.md", "不存在.md"], active: "失踪.md" }));
  first.vault.stored.set("失踪.md", { path: "失踪.md", content: "独立的未保存内容", baseVersion: "old" });
  const mounted = first.mount();
  await screen.findByRole("button", { name: "恢复草稿" });
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
  expect(editor().state.doc.toString()).toBe("独立的未保存内容");
  expect(screen.getByRole("button", { name: "重新载入" })).toBeTruthy();
  flushUI(); mounted.unmount(); second.mount();
  await screen.findByRole("button", { name: "a.md" });
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(first.vault.stored.get("失踪.md")?.content).toBe("独立的未保存内容");
});

it("批量关闭先检查全部文件，遇到冲突保留所有标签与草稿", async () => {
  const { api, vault, mount } = fixture();
  api.save = async (path, content, version) => { if (path === "b.md") throw new WorkspaceError("conflict", "文件已被外部修改"); return vault.save(path, content, version); };
  mount(); edit(await open("a.md"), "第一篇待保存"); edit(await open("b.md"), "第二篇冲突内容"); await open("c.md");
  menu("c.md", "关闭全部标签");
  await screen.findByText(/无法关闭标签/);
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  expect(vault.notes.get("项目/a.md")?.content).toBe("第一篇待保存");
  expect(vault.stored.get("b.md")?.content).toBe("第二篇冲突内容");
  expect(editor().state.doc.toString()).toBe("第二篇冲突内容");
});

it("文件树行内重命名、目录移动复用链接维护，并更新固定标签恢复路径", async () => {
  const { mount, vault, key } = fixture(); vault.put("引用.md", "[[项目/a]]"); mount();
  await open("a.md"); menu("a.md", "固定标签");
  const treeFile = screen.getByRole("button", { name: "a.md" });
  fireEvent.keyDown(treeFile, { key: "F2" });
  const name = await screen.findByRole("textbox", { name: "重命名 a.md" });
  fireEvent.change(name, { target: { value: "改名.md" } }); fireEvent.keyDown(name, { key: "Enter" });
  await screen.findByRole("tab", { name: /改名.md/ });
  expect(vault.notes.get("引用.md")?.content).toBe("[[项目/改名]]");
  fireEvent.contextMenu(screen.getByRole("button", { name: "改名.md" })); fireEvent.click(screen.getByRole("menuitem", { name: "移动" }));
  fireEvent.click(await screen.findByRole("radio", { name: "▱ 归档" })); fireEvent.click(screen.getByRole("button", { name: "移动到此处" }));
  await waitFor(() => expect(screen.getByRole("tab", { name: /改名.md/ }).getAttribute("title")).toBe("归档/改名.md"));
  expect(vault.notes.get("引用.md")?.content).toBe("[[归档/改名]]");
  flushUI(); expect(JSON.parse(localStorage.getItem(key)!).pinned).toEqual(["归档/改名.md"]);
});

it("恢复失败不会清空原来的标签记录，禁用恢复不影响草稿入口", async () => {
  const { api, mount, key, vault } = fixture();
  const raw = JSON.stringify({ ...emptyWorkspace(), tabs: ["项目/a.md"], active: "项目/a.md" }); localStorage.setItem(key, raw);
  api.read = async () => { throw new WorkspaceError("network", "连接暂时中断"); };
  const first = mount(); await screen.findByText("连接暂时中断"); flushUI(); expect(localStorage.getItem(key)).toBe(raw);
  first.unmount(); localStorage.setItem(preferencesKey, JSON.stringify({ ...defaultPreferences, restoreWorkspace: false }));
  vault.stored.set("b.md", { path: "b.md", content: "原有草稿", baseVersion: vault.notes.get("b.md")!.version });
  mount(); await screen.findByText("可恢复草稿"); expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(vault.stored.get("b.md")?.content).toBe("原有草稿");
});

it("解析界面配置时过滤无效路径并限制布局数值", () => {
  expect(normalizePreferences({ fontSize: 400, lineHeight: NaN }).fontSize).toBe(28);
  const result = normalizeWorkspace({ ...emptyWorkspace(), tabs: ["../bad.md", "C:/bad.md", "b.md", "b.md", "@tasks"], pinned: ["@tasks"], sidebarWidth: 9999, splitRatio: -3, editors: { "b.md": { anchor: -10, head: Infinity } } });
  expect(result.tabs).toEqual(["@tasks", "b.md"]); expect(result.sidebarWidth).toBe(520); expect(result.splitRatio).toBe(.25); expect(result.editors["b.md"].head).toBe(0);
  expect(normalizeWorkspace({ version: 99, tabs: ["b.md"] }).tabs).toEqual([]);
});

it("拖动标签保持编辑会话，批量关闭跳过固定标签", async () => {
  const { mount, key, vault } = fixture(); mount();
  const first = await open("a.md"); await open("b.md"); const third = await open("c.md"); edit(third, "排序后继续保存");
  menu("a.md", "固定标签");
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(screen.getByRole("tab", { name: /c.md/ }).parentElement!, { dataTransfer: transfer });
  fireEvent.drop(screen.getByRole("tab", { name: /b.md/ }).parentElement!, { dataTransfer: transfer });
  expect(screen.getAllByRole("tab").map((tab) => tab.title)).toEqual(["项目/a.md", "c.md", "b.md"]);
  expect(editor()).toBe(third);
  menu("b.md", "关闭其他标签");
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
  expect(vault.notes.get("c.md")?.content).toBe("排序后继续保存");
  fireEvent.click(screen.getByRole("tab", { name: /a.md/ })); expect(editor()).toBe(first);
  flushUI(); expect(JSON.parse(localStorage.getItem(key)!).pinned).toEqual(["项目/a.md"]);
});

it("目录拖动使用原有移动流程，折叠状态在重开和定位时正确恢复", async () => {
  const { mount, vault, key } = fixture(); const first = mount();
  await open("a.md");
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(screen.getByRole("button", { name: "a.md" }), { dataTransfer: transfer });
  fireEvent.drop(screen.getByText("归档", { selector: ".tree-name" }).closest("summary")!, { dataTransfer: transfer });
  await waitFor(() => expect(screen.getByRole("tab", { name: "a.md" }).title).toBe("归档/a.md"));
  const folder = screen.getByText("归档", { selector: ".tree-name" }).closest("details")!;
  act(() => { folder.open = false; }); fireEvent(folder, new Event("toggle")); flushUI();
  expect(JSON.parse(localStorage.getItem(key)!).collapsedFolders).toContain("归档");
  first.unmount(); mount(); await screen.findByRole("tab", { name: "a.md" });
  expect(screen.getByText("归档", { selector: ".tree-name" }).closest("details")!.open).toBe(false);
  menu("a.md", "在文件树中定位");
  expect(screen.getByText("归档", { selector: ".tree-name" }).closest("details")!.open).toBe(true);
  expect(vault.notes.has("归档/a.md")).toBe(true);
});
