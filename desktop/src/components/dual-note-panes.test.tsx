// @vitest-environment jsdom
import "../test/codemirror-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import { panelId, workspaceTabType } from "./workspace-tabs";
import { WorkspaceRuntimeContext } from "../lib/workspace-runtime";
import type { WorkspaceApi } from "../lib/vault-api";
import { MemoryVault } from "../test/memory-vault";
import { defaultPreferences, emptyWorkspace, preferencesKey, workspaceStorageKey, normalizeWorkspace } from "../lib/workspace-state";
import { WorkspaceError } from "../lib/api-error";
import { themes } from "../lib/themes";

vi.mock("../lib/mermaid", () => ({ renderMermaid: async () => "<svg />" }));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function fixture(kind: "web" | "desktop" = "web") {
  const vault = new MemoryVault(); vault.put("a.md", "甲的原文"); vault.put("b.md", "乙的原文"); vault.put("c.md", "丙的原文");
  const api = { ...vault, status: async () => ({ vault: "双栏库", id: "dual-vault", error: null }), selectVault: vi.fn(), createVault: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), importAttachment: vi.fn(), image: vi.fn(), remove: vi.fn(), openAttachment: vi.fn(), openExternal: vi.fn(), openItem: vi.fn() } as WorkspaceApi;
  const mount = () => render(<WorkspaceRuntimeContext.Provider value={{ kind, api }}><DesktopApp /></WorkspaceRuntimeContext.Provider>);
  return { vault, api, mount, key: workspaceStorageKey(kind, "dual-vault") };
}
function panel(path: string) { return document.getElementById(panelId(path))!; }
function editor(path: string) { return EditorView.findFromDOM(panel(path).querySelector<HTMLElement>(".cm-editor")!)!; }
async function open(path: string) { fireEvent.click(await screen.findByRole("button", { name: path })); await screen.findByRole("tab", { name: path }); return waitFor(() => editor(path)); }
function edit(path: string, text: string) { fireEvent.pointerDown(panel(path)); const view = editor(path); act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" })); }
function menu(path: string, action: string) { fireEvent.contextMenu(screen.getByRole("tab", { name: new RegExp(path) })); fireEvent.click(screen.getByRole("menuitem", { name: action })); }
function flush() { act(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true }))); }
function transfer() {
  const data = new Map<string, string>();
  return { get types() { return [...data.keys()]; }, setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "", effectAllowed: "", dropEffect: "" };
}
function drag(path: string, target: HTMLElement) {
  const tab = screen.getByRole("tab", { name: new RegExp(path) }).parentElement!, dataTransfer = transfer();
  fireEvent.dragStart(tab, { dataTransfer }); fireEvent.dragOver(target, { dataTransfer }); fireEvent.drop(target, { dataTransfer }); fireEvent.dragEnd(tab, { dataTransfer });
}

it("文件树右侧打开保留左侧选中笔记，两个编辑器独立自动保存和撤销", async () => {
  const { mount, vault } = fixture(); mount(); const first = await open("a.md");
  fireEvent.contextMenu(screen.getByRole("button", { name: "b.md" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "在右侧打开" }));
  await screen.findByRole("tab", { name: "b.md" });
  expect(screen.getAllByRole("tabpanel")).toHaveLength(2);
  expect(panel("a.md").dataset.notePane).toBe("left"); expect(panel("b.md").dataset.notePane).toBe("right");
  const second = editor("b.md"); expect(editor("a.md")).toBe(first);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  edit("a.md", "甲的新内容"); edit("b.md", "乙的新内容");
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(vault.stored.get("a.md")?.content).toBe("甲的新内容"); expect(vault.stored.get("b.md")?.content).toBe("乙的新内容");
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(vault.notes.get("a.md")?.content).toBe("甲的新内容"); expect(vault.notes.get("b.md")?.content).toBe("乙的新内容");
  fireEvent.pointerDown(panel("a.md")); act(() => { undo(first); });
  expect(first.state.doc.toString()).toBe("甲的原文"); expect(second.state.doc.toString()).toBe("乙的新内容");
  fireEvent.pointerDown(panel("b.md")); act(() => { undo(second); });
  expect(second.state.doc.toString()).toBe("乙的原文");
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(vault.notes.get("b.md")?.content).toBe("乙的原文");
  expect(editor("a.md")).toBe(first); expect(editor("b.md")).toBe(second);
});

it("标签可拖到另一栏和编辑区域，固定标签保留且不会把路径插入正文", async () => {
  const { mount, key } = fixture(); mount(); const first = await open("a.md"); const second = await open("b.md");
  menu("a.md", "固定标签");
  drag("b.md", screen.getByRole("button", { name: "在右侧打开当前笔记" }));
  expect(screen.getAllByRole("tabpanel")).toHaveLength(2);
  edit("b.md", "跨栏仍保留的正文");
  drag("a.md", screen.getByRole("tablist", { name: "右侧笔记标签" }));
  expect(panel("a.md").dataset.notePane).toBe("right"); expect(editor("a.md")).toBe(first);
  drag("a.md", screen.getByRole("tablist", { name: "左侧笔记标签" }));
  expect(panel("a.md").dataset.notePane).toBe("left");
  drag("b.md", first.contentDOM);
  expect(screen.queryByRole("separator", { name: "左右笔记宽度" })).toBeNull();
  expect(editor("b.md")).toBe(second); expect(second.state.doc.toString()).toBe("跨栏仍保留的正文");
  expect(first.state.doc.toString()).toBe("甲的原文");
  act(() => { undo(second); }); expect(second.state.doc.toString()).toBe("乙的原文");
  flush(); expect(JSON.parse(localStorage.getItem(key)!).pinned).toEqual(["a.md"]);
});

it("宽度可拖动、键盘调整和还原，恢复双栏时两边草稿分别确认", async () => {
  const { mount, key, vault } = fixture(); localStorage.setItem(preferencesKey, JSON.stringify({ ...defaultPreferences, autoSaveDelay: 60000 }));
  const mounted = mount(); await open("a.md"); await open("b.md"); menu("b.md", "在右侧打开");
  Object.defineProperty(document.querySelector(".main-pane"), "clientWidth", { configurable: true, value: 805 });
  const separator = screen.getByRole("separator", { name: "左右笔记宽度" });
  fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(document, { clientX: 180, pointerId: 1 }); fireEvent.pointerUp(document, { pointerId: 1 });
  expect(Number(separator.getAttribute("aria-valuenow"))).toBe(.6);
  fireEvent.keyDown(separator, { key: "End" }); expect(separator.getAttribute("aria-valuenow")).toBe("0.75");
  fireEvent.doubleClick(separator); expect(separator.getAttribute("aria-valuenow")).toBe("0.5");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  edit("a.md", "左边恢复内容"); edit("b.md", "右边恢复内容"); flush();
  await waitFor(() => expect(vault.stored.size).toBe(2));
  expect(JSON.parse(localStorage.getItem(key)!).panes.ratio).toBe(.55);
  mounted.unmount(); mount();
  await screen.findByRole("button", { name: "恢复草稿" });
  expect(screen.getAllByRole("tabpanel")).toHaveLength(2);
  expect(editor("a.md").state.readOnly).toBe(true); expect(editor("b.md").state.readOnly).toBe(true);
  expect(screen.getByRole("separator", { name: "左右笔记宽度" }).getAttribute("aria-valuenow")).toBe("0.55");
  fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
  expect(editor("b.md").state.doc.toString()).toBe("右边恢复内容"); expect(editor("a.md").state.readOnly).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: /a.md/ })); fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
  expect(editor("a.md").state.doc.toString()).toBe("左边恢复内容");
});

it("慢保存跨栏后保留新输入，并按焦点保存另一篇笔记", async () => {
  const { mount, api, vault } = fixture(); const original = api.save;
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); let firstSave = true;
  api.save = async (...args) => { if (args[0] === "a.md" && firstSave) { firstSave = false; await pending; } return original(...args); };
  mount(); const first = await open("a.md"); const second = await open("b.md");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  edit("a.md", "已提交的甲"); await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  menu("a.md", "在右侧打开"); edit("a.md", "甲保存期间的新输入"); edit("b.md", "乙应手动保存");
  fireEvent.keyDown(window, { key: "s", ctrlKey: true }); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(vault.notes.get("b.md")?.content).toBe("乙应手动保存"); expect(vault.notes.get("a.md")?.content).toBe("甲的原文");
  await act(async () => { release(); await vi.advanceTimersByTimeAsync(2000); });
  expect(vault.notes.get("a.md")?.content).toBe("甲保存期间的新输入");
  expect(panel("b.md").dataset.focused).toBe("true"); expect(editor("a.md")).toBe(first); expect(editor("b.md")).toBe(second);
});

it("右栏保存冲突阻止关闭，另存后仍在右栏；合并不重建左边编辑器", async () => {
  const { mount, api, vault, key } = fixture(); const original = api.save;
  api.save = async (...args) => { if (args[0] === "b.md") throw new WorkspaceError("conflict", "外部修改"); return original(...args); };
  mount(); const first = await open("a.md"); await open("b.md"); menu("b.md", "在右侧打开"); edit("b.md", "冲突时保留乙");
  fireEvent.click(screen.getByRole("button", { name: "关闭标签 b.md" })); await screen.findByText(/无法关闭标签/);
  expect(screen.getAllByRole("tabpanel")).toHaveLength(2); expect(vault.stored.get("b.md")?.content).toBe("冲突时保留乙");
  expect(vault.notes.get("b.md")?.content).toBe("乙的原文");
  fireEvent.click(screen.getAllByRole("button", { name: "另存为" })[0]);
  fireEvent.change(within(await screen.findByRole("dialog")).getByRole("textbox"), { target: { value: "恢复乙.md" } }); fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await screen.findByRole("tab", { name: "恢复乙.md" });
  expect(panel("恢复乙.md").dataset.notePane).toBe("right"); expect(vault.notes.get("恢复乙.md")?.content).toBe("冲突时保留乙");
  fireEvent.click(screen.getByRole("button", { name: "合并到左侧" }));
  expect(editor("a.md")).toBe(first); expect(screen.queryByRole("tablist", { name: "右侧笔记标签" })).toBeNull();
  flush(); expect(JSON.parse(localStorage.getItem(key)!).panes.right).toEqual([]);
});

it("桌面运行时恢复双栏并维护右栏重命名路径，拒绝其他知识库的拖入", async () => {
  const { mount, key } = fixture("desktop");
  localStorage.setItem(key, JSON.stringify({ ...emptyWorkspace(), tabs: ["a.md", "b.md"], active: "b.md", panes: { right: ["b.md"], leftActive: "a.md", rightActive: "b.md", ratio: .4 } }));
  mount(); await screen.findByRole("tab", { name: "b.md" });
  expect(screen.getAllByRole("tabpanel")).toHaveLength(2);
  fireEvent.keyDown(screen.getByRole("button", { name: "b.md" }), { key: "F2" });
  const name = await screen.findByRole("textbox", { name: "重命名 b.md" }); fireEvent.change(name, { target: { value: "改名乙.md" } }); fireEvent.keyDown(name, { key: "Enter" });
  await screen.findByRole("tab", { name: "改名乙.md" }); expect(panel("改名乙.md").dataset.notePane).toBe("right");
  const dataTransfer = transfer(); dataTransfer.setData(workspaceTabType, JSON.stringify({ scope: "其他知识库", path: "a.md" }));
  fireEvent.drop(screen.getByRole("tablist", { name: "右侧笔记标签" }), { dataTransfer });
  expect(panel("a.md").dataset.notePane).toBe("left");
  flush(); expect(JSON.parse(localStorage.getItem(key)!).panes.right).toEqual(["改名乙.md"]);
});

it("旧工作区保持单栏，损坏布局不能把工具或不存在的路径放入右栏", () => {
  const saved = normalizeWorkspace({ ...emptyWorkspace(), tabs: ["a.md", "b.md", "@tasks", "x.canvas"], active: "a.md", panes: { right: ["b.md", "b.md", "gone.md", "@tasks", "x.canvas"], leftActive: "gone.md", rightActive: "@tasks", ratio: Infinity } });
  expect(saved.panes).toEqual({ right: ["b.md"], leftActive: "a.md", rightActive: "b.md", ratio: .5 });
  expect(normalizeWorkspace({ ...emptyWorkspace(), tabs: ["a.md"], active: "a.md" }).panes?.right).toEqual([]);
});

it("各栏独立切换标签和编辑模式，关闭最后一个右栏标签后回到左栏", async () => {
  const { mount, vault } = fixture(); mount(); const first = await open("a.md"); await open("b.md"); menu("b.md", "在右侧打开");
  const third = await open("c.md");
  expect(within(screen.getByRole("tablist", { name: "右侧笔记标签" })).getAllByRole("tab")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "源码" }));
  expect(panel("c.md").classList.contains("source")).toBe(true); expect(panel("a.md").classList.contains("live")).toBe(true);
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
  expect(panel("b.md").hidden).toBe(false); expect(panel("c.md").hidden).toBe(true); expect(panel("a.md").hidden).toBe(false);
  fireEvent.focus(first.contentDOM);
  expect(panel("a.md").dataset.focused).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "分屏" }));
  expect(panel("a.md").classList.contains("split")).toBe(true); expect(panel("c.md").classList.contains("source")).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "c.md" })); edit("c.md", "右栏关闭时保存");
  menu("c.md", "关闭全部标签");
  await waitFor(() => expect(screen.queryByRole("tablist", { name: "右侧笔记标签" })).toBeNull());
  expect(vault.notes.get("c.md")?.content).toBe("右栏关闭时保存"); expect(editor("a.md")).toBe(first);
  expect(screen.getAllByRole("tab")).toHaveLength(1); expect(third.dom.isConnected).toBe(false);
});

it("原文件消失的右栏恢复入口保留，恢复不会覆盖左栏或其他文件", async () => {
  const { mount, key, vault } = fixture();
  localStorage.setItem(key, JSON.stringify({ ...emptyWorkspace(), tabs: ["a.md", "失踪.md"], active: "失踪.md", panes: { right: ["失踪.md"], leftActive: "a.md", rightActive: "失踪.md", ratio: .5 } }));
  vault.stored.set("失踪.md", { path: "失踪.md", content: "待恢复的右栏", baseVersion: "old" });
  mount(); await screen.findByRole("button", { name: "恢复草稿" });
  expect(panel("失踪.md").style.gridColumn).toBe("3"); expect(screen.getAllByRole("tabpanel")).toHaveLength(2);
  fireEvent.click(screen.getByRole("tab", { name: "a.md" }));
  fireEvent.click(screen.getByRole("tab", { name: /^失踪.md/ })); fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
  expect(editor("失踪.md").state.doc.toString()).toBe("待恢复的右栏");
  expect(editor("a.md").state.doc.toString()).toBe("甲的原文"); expect(vault.notes.has("失踪.md")).toBe(false);
});

it("五套主题切换保留两栏各自的标题、保存状态和原编辑器", async () => {
  const { mount, vault } = fixture();
  localStorage.setItem(preferencesKey, JSON.stringify({ ...defaultPreferences, autoSaveDelay: 60000 }));
  mount(); const first = await open("a.md"), second = await open("b.md"); menu("b.md", "在右侧打开");
  edit("a.md", "甲待保存"); edit("b.md", "乙待保存");
  const left = screen.getByRole("group", { name: "文档工具栏 a.md" }), right = screen.getByRole("group", { name: "文档工具栏 b.md" });
  expect(left.parentElement).toBe(right.parentElement); expect(left.parentElement).toBe(panel("a.md").parentElement);
  expect(left.style.gridColumn).toBe("1"); expect(right.style.gridColumn).toBe("3");
  for (const theme of themes) {
    fireEvent.click(screen.getByRole("button", { name: "软件设置" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: theme.name }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(document.querySelector(".desktop-app")?.getAttribute("data-theme-id")).toBe(theme.id);
    expect(editor("a.md")).toBe(first); expect(editor("b.md")).toBe(second);
    expect(within(left).getByRole("status").textContent).toBe("待自动保存");
    expect(within(right).getByRole("status").textContent).toBe("待自动保存");
  }
  // Clicking the other header saves its own file even while the right editor was focused.
  fireEvent.click(within(left).getByRole("button", { name: "保存 a.md" }));
  await waitFor(() => expect(vault.notes.get("a.md")?.content).toBe("甲待保存"));
  expect(vault.notes.get("b.md")?.content).toBe("乙的原文");
  expect(within(left).getByRole("status").textContent).toBe("已保存");
  expect(within(right).getByRole("status").textContent).toBe("待自动保存");
  fireEvent.pointerDown(panel("a.md")); act(() => { undo(first); });
  expect(first.state.doc.toString()).toBe("甲的原文"); expect(second.state.doc.toString()).toBe("乙待保存");
});

it("另一栏标题菜单中的另存操作绑定其来源笔记，保留两边草稿", async () => {
  const { mount, vault } = fixture();
  localStorage.setItem(preferencesKey, JSON.stringify({ ...defaultPreferences, autoSaveDelay: 60000 }));
  mount(); await open("a.md"); const second = await open("b.md"); menu("b.md", "在右侧打开");
  edit("a.md", "甲的未保存内容"); edit("b.md", "乙的未保存内容");
  const left = screen.getByRole("group", { name: "文档工具栏 a.md" });
  fireEvent.click(within(left).getByText("另存为", { selector: "button" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "甲的副本.md" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
  await screen.findByRole("tab", { name: "甲的副本.md" });
  expect(vault.notes.get("甲的副本.md")?.content).toBe("甲的未保存内容"); expect(vault.notes.get("a.md")?.content).toBe("甲的原文");
  expect(panel("甲的副本.md").dataset.notePane).toBe("left"); expect(editor("b.md")).toBe(second);
  expect(second.state.doc.toString()).toBe("乙的未保存内容"); expect(vault.stored.get("b.md")?.content).toBe("乙的未保存内容");
});
