// @vitest-environment jsdom
import "../test/codemirror-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import DesktopApp from "./desktop-app";

const api = vi.hoisted(() => ({
  status: vi.fn(), entries: vi.fn(), drafts: vi.fn(), read: vi.fn(), save: vi.fn(), writeDraft: vi.fn(), removeDraft: vi.fn(),
  createNote: vi.fn(), createDirectory: vi.fn(), selectVault: vi.fn(), createVault: vi.fn(), move: vi.fn(), remove: vi.fn(),
  importAttachment: vi.fn(), image: vi.fn(), openAttachment: vi.fn(), openExternal: vi.fn(), openItem: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(),
}));
const windowMock = vi.hoisted(() => ({ onClose: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>), destroy: vi.fn() }));
vi.mock("../lib/desktop-api", () => ({ desktop: api }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async (handler: typeof windowMock.onClose) => { windowMock.onClose = handler; return () => {}; }, destroy: windowMock.destroy }) }));
vi.mock("../lib/mermaid", () => ({ renderMermaid: async () => "<svg />" }));

type Note = { path: string; content: string; version: string };
type Draft = { path: string; content: string; baseVersion: string };
const firstPath = "项目/笔记.md", secondPath = "其他.md";
let notes: Map<string, Note>, drafts: Map<string, Draft>, version: number;
function put(path: string, content: string) { const note = { path, content, version: `v${++version}` }; notes.set(path, note); return { ...note }; }
function files() {
  return [{ path: "项目", name: "项目", isDirectory: true, children: [...notes.values()].filter((note) => note.path.startsWith("项目/")).map((note) => ({ path: note.path, name: note.path.slice(3), isDirectory: false, children: [] })) }, ...[...notes.values()].filter((note) => !note.path.includes("/")).map((note) => ({ path: note.path, name: note.path, isDirectory: false, children: [] }))];
}
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear(); version = 0; notes = new Map(); drafts = new Map();
  put(firstPath, "第一篇正文"); put(secondPath, "第二篇正文");
  api.status.mockResolvedValue({ vault: "tabs-test", error: null });
  api.entries.mockImplementation(async () => files());
  api.read.mockImplementation(async (path: string) => { const note = notes.get(path); if (!note) throw new Error("文件不存在"); return { ...note }; });
  api.drafts.mockImplementation(async () => [...drafts.values()]);
  api.writeDraft.mockImplementation(async (draft: Draft) => { drafts.set(draft.path, { ...draft }); });
  api.removeDraft.mockImplementation(async (path: string) => { drafts.delete(path); });
  api.save.mockImplementation(async (path: string, content: string, expected: string) => { if (notes.get(path)?.version !== expected) throw new Error("文件已被外部修改"); return put(path, content); });
  api.createNote.mockImplementation(async (path: string, content: string) => { if (notes.has(path)) throw new Error("文件已存在"); return put(path, content); });
  windowMock.onClose = undefined; windowMock.destroy.mockResolvedValue(undefined);
});
afterEach(cleanup);

function currentView() { return EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!; }
async function open(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
  await screen.findByRole("tab", { name });
  await waitFor(() => expect(screen.getByRole("tabpanel").querySelector(".cm-editor")).toBeTruthy());
  return currentView();
}
function replace(view: EditorView, content: string) { act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: content.length }, userEvent: "input.type" }); }); }

describe("多笔记标签", () => {
  it("准确匹配路径，不合并大小写不同的两个已有文件", async () => {
    put("Case.md", "大写文件"); put("case.md", "小写文件");
    render(<DesktopApp />);
    expect((await open("Case.md")).state.doc.toString()).toBe("大写文件");
    expect((await open("case.md")).state.doc.toString()).toBe("小写文件");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("切换笔记和任务标签时保留真实编辑器、光标、滚动、视图与撤销记录", async () => {
    render(<DesktopApp />);
    const first = await open("笔记.md");
    replace(first, "第一篇继续编辑");
    act(() => { first.dispatch({ selection: { anchor: 3 } }); first.scrollDOM.scrollTop = 128; });
    const second = await open("其他.md");
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    replace(second, "第二篇独立编辑");
    fireEvent.click(screen.getByRole("button", { name: "任务管理" }));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    fireEvent.click(screen.getByRole("tab", { name: /^笔记.md/ }));
    expect(currentView()).toBe(first);
    expect(first.state.selection.main.anchor).toBe(3);
    expect(first.scrollDOM.scrollTop).toBe(128);
    expect(screen.getByRole("button", { name: "实时编辑" }).classList.contains("vt-active")).toBe(true);
    act(() => { undo(first); });
    expect(first.state.doc.toString()).toBe("第一篇正文");
    fireEvent.click(screen.getByRole("tab", { name: /^其他.md/ }));
    expect(currentView()).toBe(second);
    expect(screen.getByRole("button", { name: "源码" }).classList.contains("vt-active")).toBe(true);
    act(() => { undo(second); });
    expect(second.state.doc.toString()).toBe("第二篇正文");
    fireEvent.click(screen.getByRole("button", { name: "笔记.md" }));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(currentView()).toBe(first);
  });

  it("原笔记慢速保存的返回结果不会切换标签，新输入使用新的版本继续保存", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let first = true;
    api.save.mockImplementation(async (path: string, content: string, expected: string) => {
      if (notes.get(path)?.version !== expected) throw new Error("版本过期");
      if (path === firstPath && first) { first = false; await pending; }
      return put(path, content);
    });
    render(<DesktopApp />);
    const firstView = await open("笔记.md");
    replace(firstView, "保存快照");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    replace(firstView, "保存期间的最新输入");
    const secondView = await open("其他.md");
    replace(secondView, "第二篇的新输入");
    await act(async () => { finish(); await pending; });
    expect(currentView()).toBe(secondView);
    expect(secondView.state.doc.toString()).toBe("第二篇的新输入");
    await waitFor(() => expect(drafts.get(firstPath)?.baseVersion).toBe(notes.get(firstPath)?.version));
    const savedVersion = notes.get(firstPath)!.version;
    await waitFor(() => expect(notes.get(firstPath)?.content).toBe("保存期间的最新输入"), { timeout: 3500 });
    expect(api.save).toHaveBeenCalledWith(firstPath, "保存期间的最新输入", savedVersion);
    await waitFor(() => expect(notes.get(secondPath)?.content).toBe("第二篇的新输入"), { timeout: 3500 });
    expect(currentView()).toBe(secondView);
  }, 10000);

  it("任务标签激活时关闭窗口也会保存所有笔记的最新恢复草稿", async () => {
    render(<DesktopApp />);
    replace(await open("笔记.md"), "第一篇尚未保存");
    replace(await open("其他.md"), "第二篇尚未保存");
    fireEvent.click(screen.getByRole("button", { name: "任务管理" }));
    await act(async () => { await windowMock.onClose!({ preventDefault: vi.fn() }); });
    expect(windowMock.destroy).toHaveBeenCalledOnce();
    expect(drafts.get(firstPath)?.content).toBe("第一篇尚未保存");
    expect(drafts.get(secondPath)?.content).toBe("第二篇尚未保存");
  });

  it("非当前标签发生外部冲突时保留内容并阻止关闭，可另存恢复", async () => {
    render(<DesktopApp />);
    const first = await open("笔记.md"); replace(first, "应该保留的编辑");
    const second = await open("其他.md");
    put(firstPath, "外部同步修改");
    await waitFor(() => expect(screen.getByRole("tab", { name: /^笔记.md/ }).textContent).toContain("!"), { timeout: 4000 });
    expect(currentView()).toBe(second);
    expect(notes.get(firstPath)?.content).toBe("外部同步修改");
    fireEvent.click(screen.getByRole("button", { name: "关闭标签 笔记.md" }));
    await screen.findByText(/无法关闭标签/);
    expect(currentView()).toBe(first);
    expect(first.state.doc.toString()).toBe("应该保留的编辑");
    fireEvent.click(screen.getAllByRole("button", { name: "另存为" })[0]);
    const input = await screen.findByDisplayValue("项目/恢复的笔记.md");
    fireEvent.change(input, { target: { value: "项目/恢复.md" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await screen.findByRole("tab", { name: "恢复.md" });
    expect(notes.get("项目/恢复.md")?.content).toBe("应该保留的编辑");
    expect(notes.get(firstPath)?.content).toBe("外部同步修改");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  }, 10000);

  it("快捷键切换、关闭和中键关闭会保存对应文档，并选择相邻标签", async () => {
    render(<DesktopApp />);
    replace(await open("笔记.md"), "关闭时写入第一篇");
    await open("其他.md");
    fireEvent.click(screen.getByRole("button", { name: "任务管理" }));
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(screen.getByRole("tab", { name: /^笔记.md/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("tab", { name: /^笔记.md/ })).toBeNull());
    expect(notes.get(firstPath)?.content).toBe("关闭时写入第一篇");
    expect(screen.getByRole("tab", { name: "其他.md" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseUp(screen.getByRole("tab", { name: "其他.md" }).parentElement!, { button: 1 });
    await waitFor(() => expect(screen.queryByRole("tab", { name: "其他.md" })).toBeNull());
    expect(screen.getByRole("tab", { name: "任务管理" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
  });
});
