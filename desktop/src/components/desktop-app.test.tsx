// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emptyWorkspace, workspaceStorageKey } from "../lib/workspace-state";
import DesktopApp from "./desktop-app";

const api = vi.hoisted(() => ({
  status: vi.fn(), entries: vi.fn(), drafts: vi.fn(), read: vi.fn(), save: vi.fn(),
  writeDraft: vi.fn(), removeDraft: vi.fn(), createNote: vi.fn(), createDirectory: vi.fn(),
  selectVault: vi.fn(), createVault: vi.fn(), move: vi.fn(), remove: vi.fn(),
  importAttachment: vi.fn(), image: vi.fn(), openAttachment: vi.fn(), openItem: vi.fn(),
  chooseDirectory: vi.fn(), chooseFile: vi.fn(),
}));
const windowMock = vi.hoisted(() => ({
  onClose: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>),
  destroy: vi.fn(),
}));
vi.mock("../lib/desktop-api", () => ({ desktop: api }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: typeof windowMock.onClose) => { windowMock.onClose = handler; return () => {}; },
    destroy: windowMock.destroy,
  }),
}));
vi.mock("./markdown-editor", async () => {
  const React = await import("react");
  return { MarkdownEditor: React.forwardRef(function FakeEditor(props: { value: string; disabled: boolean; onChange: (value: string) => void }, _ref) {
    return <textarea aria-label="测试编辑器" value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)} />;
  }) };
});
vi.mock("./markdown-preview", () => ({ MarkdownPreview: () => <div /> }));

const initial = { path: "项目/笔记.md", content: "磁盘原文", version: "version-1" };
const second = { path: "其他.md", content: "另一篇", version: "version-2" };
const entries = [
  { path: "项目", name: "项目", isDirectory: true, children: [{ path: initial.path, name: "笔记.md", isDirectory: false, children: [] }] },
  { path: second.path, name: "其他.md", isDirectory: false, children: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  api.status.mockResolvedValue({ vault: "test-vault", error: null });
  api.entries.mockResolvedValue(entries);
  api.drafts.mockResolvedValue([]);
  api.read.mockImplementation(async (path: string) => path === initial.path ? initial : second);
  api.writeDraft.mockResolvedValue(undefined);
  api.removeDraft.mockResolvedValue(undefined);
  api.createNote.mockImplementation(async (path: string, content = "") => ({ path, content, version: `created:${path}` }));
  api.save.mockImplementation(async (path: string, content: string) => ({ path, content, version: `saved:${path}` }));
  windowMock.onClose = undefined;
  windowMock.destroy.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("桌面启动", () => {
  it("完成知识库检查和标签读取后直接显示上次的笔记", async () => {
    let finishStatus!: (value: { vault: string; error: null }) => void;
    let finishRead!: (value: typeof initial) => void;
    api.status.mockReturnValueOnce(new Promise(resolve => { finishStatus = resolve; }));
    api.read.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve; }));
    localStorage.setItem(workspaceStorageKey("desktop", "test-vault"), JSON.stringify({
      ...emptyWorkspace(), tabs: [initial.path], active: initial.path,
    }));

    render(<DesktopApp />);
    expect(screen.getByRole("status").textContent).toBe("正在启动本地知识库…");
    expect(screen.queryByRole("button", { name: /打开现有知识库/ })).toBeNull();

    await act(async () => { finishStatus({ vault: "test-vault", error: null }); });
    await waitFor(() => expect(api.read).toHaveBeenCalledWith(initial.path));
    expect(screen.queryByRole("heading", { name: /创建你的知识空间|打开文档/ })).toBeNull();
    expect(api.entries).toHaveBeenCalledTimes(2);
    expect(api.drafts).toHaveBeenCalledTimes(1);

    await act(async () => { finishRead(initial); });
    expect((await screen.findByLabelText("测试编辑器") as HTMLTextAreaElement).value).toBe(initial.content);
    expect(screen.getByRole("tab", { name: /^笔记.md/, selected: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /打开现有知识库/ })).toBeNull();
    expect(api.chooseDirectory).not.toHaveBeenCalled();
  });

  it("确认没有知识库时才显示首次打开界面", async () => {
    api.status.mockResolvedValueOnce({ vault: null, error: null });
    render(<DesktopApp />);
    expect(screen.queryByRole("heading", { name: "创建你的知识空间" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "创建你的知识空间" })).toBeTruthy();
  });

  it("已有知识库的工作区读取失败时显示错误并保留当前知识库", async () => {
    api.drafts.mockRejectedValueOnce(new Error("无法读取恢复草稿"));
    render(<DesktopApp />);
    expect((await screen.findByRole("alert")).textContent).toContain("无法读取恢复草稿");
    expect(screen.getByRole("button", { name: "快速打开笔记" }).textContent).toBe("test-vault");
    expect(screen.queryByRole("heading", { name: "创建你的知识空间" })).toBeNull();
  });

  it("启动时单篇无法读取，仍恢复其他标签页", async () => {
    localStorage.setItem(workspaceStorageKey("desktop", "test-vault"), JSON.stringify({
      ...emptyWorkspace(), tabs: [initial.path, second.path], active: initial.path,
    }));
    api.read.mockRejectedValueOnce(new Error("文件不是 UTF-8"));
    render(<DesktopApp />);
    expect((await screen.findByRole("alert")).textContent).toContain(initial.path);
    expect(screen.getByRole("tab", { name: second.path, selected: true })).toBeTruthy();
    expect((screen.getByLabelText("测试编辑器") as HTMLTextAreaElement).value).toBe(second.content);
    expect(api.save).not.toHaveBeenCalled();
  });
});

describe("桌面笔记冲突和草稿", () => {
  it("后台保存失败时保留保存期间新输入的内容", async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<typeof initial>((_resolve, fail) => { reject = fail; });
    api.save.mockReturnValue(pending);
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    const editor = await screen.findByLabelText("测试编辑器") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "发起保存" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    fireEvent.change(editor, { target: { value: "保存期间继续输入，全部保留" } });
    await act(async () => { reject(new Error("外部版本已变化")); await pending.catch(() => {}); });
    await screen.findByText(/保存失败：外部版本已变化/);
    expect(editor.value).toBe("保存期间继续输入，全部保留");
    expect(api.writeDraft).toHaveBeenCalledWith(expect.objectContaining({ path: initial.path, content: "保存期间继续输入，全部保留", baseVersion: initial.version }));
  });

  it("后台保存不禁用编辑器，切换笔记无需等待，并持久化原笔记最新草稿", async () => {
    let finish!: (note: typeof initial) => void;
    const pending = new Promise<typeof initial>((resolve) => { finish = resolve; });
    api.save.mockReturnValue(pending);
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    const editor = await screen.findByLabelText("测试编辑器") as HTMLTextAreaElement;
    editor.focus();
    fireEvent.change(editor, { target: { value: "保存中的版本" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(editor.disabled).toBe(false);
    expect(document.activeElement).toBe(editor);
    fireEvent.change(editor, { target: { value: "保存中继续编辑的内容" } });
    fireEvent.click(screen.getByRole("button", { name: "其他.md" }));
    await waitFor(() => expect(api.read).toHaveBeenCalledWith(second.path));
    expect((screen.getByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement).value).toBe(second.content);
    await act(async () => { finish({ ...initial, content: "保存中的版本", version: "saved-version" }); await pending; });
    await waitFor(() => expect(api.writeDraft).toHaveBeenCalledWith({ path: initial.path, content: "保存中继续编辑的内容", baseVersion: "saved-version" }));
    expect((screen.getByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement).value).toBe(second.content);
    fireEvent.click(screen.getByRole("tab", { name: /^笔记.md/ }));
    expect(screen.getByRole("textbox", { name: "测试编辑器" })).toBe(editor);
    expect(editor.value).toBe("保存中继续编辑的内容");
  });

  it("保存遇到外部修改时保留编辑，并能另存为新文件", async () => {
    api.save.mockRejectedValue("文件已被外部修改");
    api.createNote.mockImplementation(async (path: string, content: string) => ({ path, content, version: "new-version" }));
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    const editor = await screen.findByLabelText("测试编辑器") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "未保存的编辑" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    await screen.findByText(/保存失败：文件已被外部修改/);
    expect(editor.value).toBe("未保存的编辑");
    expect(api.writeDraft).toHaveBeenCalledWith(expect.objectContaining({ path: initial.path, content: "未保存的编辑" }));
    fireEvent.click(screen.getAllByRole("button", { name: "另存为" })[0]);
    const input = await screen.findByDisplayValue("项目/恢复的笔记.md");
    fireEvent.change(input, { target: { value: "项目/另存.md" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(api.createNote).toHaveBeenCalledWith("项目/另存.md", "未保存的编辑"));
    await waitFor(() => expect(api.removeDraft).toHaveBeenCalledWith(initial.path));
  });

  it("原文件删除后仍能恢复持久化草稿并另存", async () => {
    const draft = { path: initial.path, content: "异常退出前的内容", baseVersion: "version-1" };
    api.drafts.mockResolvedValue([draft]);
    api.read.mockRejectedValue("文件不存在或已被删除");
    api.createNote.mockImplementation(async (path: string, content: string) => ({ path, content, version: "new-version" }));
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: initial.path }));
    await screen.findByText(/原文件已不存在/);
    fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
    expect((await screen.findByLabelText("测试编辑器") as HTMLTextAreaElement).value).toBe(draft.content);
    expect(screen.getByText(/原文件不存在，请将恢复内容另存/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "另存为" })[0]);
    const input = await screen.findByDisplayValue("项目/恢复的笔记.md");
    fireEvent.change(input, { target: { value: "项目/恢复.md" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(api.createNote).toHaveBeenCalledWith("项目/恢复.md", draft.content));
  });

  it("草稿写入失败时仍保留切换前的会话，并阻止关闭导致丢失编辑", async () => {
    api.writeDraft.mockRejectedValue("模拟磁盘不可写");
    api.save.mockRejectedValue("模拟磁盘不可写");
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    const editor = await screen.findByLabelText("测试编辑器") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "需要保留的内容" } });
    await screen.findByText(/草稿未能保存/);
    fireEvent.click(screen.getByRole("button", { name: "其他.md" }));
    await screen.findByRole("tab", { name: "其他.md" });
    fireEvent.click(screen.getByRole("button", { name: "关闭标签 笔记.md" }));
    await screen.findByText(/无法关闭标签/);
    fireEvent.click(screen.getByRole("tab", { name: /^笔记.md/ }));
    expect(editor.value).toBe("需要保留的内容");
    expect(screen.getByRole("textbox", { name: "测试编辑器" })).toBe(editor);
  });

  it("关闭时草稿无法持久化则保持窗口打开", async () => {
    api.writeDraft.mockRejectedValue("模拟磁盘不可写");
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    const editor = await screen.findByLabelText("测试编辑器") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "关闭前仍需保留" } });
    const preventDefault = vi.fn();
    expect(windowMock.onClose).toBeTypeOf("function");
    await windowMock.onClose!({ preventDefault });
    await screen.findByText(/窗口保持打开/);
    expect(preventDefault).toHaveBeenCalled();
    expect(windowMock.destroy).not.toHaveBeenCalled();
    expect(editor.value).toBe("关闭前仍需保留");
  });

  it("非当前标签的草稿写入失败也会阻止窗口关闭", async () => {
    api.writeDraft.mockImplementation(async (draft: { path: string }) => { if (draft.path === initial.path) throw new Error("后台笔记草稿不可写"); });
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    const firstEditor = await screen.findByLabelText("测试编辑器") as HTMLTextAreaElement;
    fireEvent.change(firstEditor, { target: { value: "非当前标签也不能丢" } });
    fireEvent.click(screen.getByRole("button", { name: "其他.md" }));
    await screen.findByRole("tab", { name: "其他.md" });
    await act(async () => { await windowMock.onClose!({ preventDefault: vi.fn() }); });
    await screen.findByText(/窗口保持打开/);
    expect(windowMock.destroy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: /^笔记.md/ }));
    expect(screen.getByRole("textbox", { name: "测试编辑器" })).toBe(firstEditor);
    expect(firstEditor.value).toBe("非当前标签也不能丢");
  });

  it("切换知识库前保存所有恢复草稿，成功后清空旧标签与编辑会话", async () => {
    api.chooseDirectory.mockResolvedValue("new-vault");
    api.selectVault.mockImplementation(async () => {
      api.read.mockImplementation(async (path: string) => ({ ...initial, path, content: "新知识库的原文" }));
      return { vault: "new-vault", error: null };
    });
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    fireEvent.change(await screen.findByLabelText("测试编辑器"), { target: { value: "第一篇旧知识库草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "其他.md" }));
    await screen.findByRole("tab", { name: "其他.md" });
    fireEvent.change(await screen.findByRole("textbox", { name: "测试编辑器" }), { target: { value: "第二篇旧知识库草稿" } });
    expect(screen.queryByRole("button", { name: "切换知识库" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /知识库选项/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开其他知识库" }));
    await waitFor(() => expect(api.selectVault).toHaveBeenCalledWith("new-vault"));
    expect(api.writeDraft).toHaveBeenCalledWith(expect.objectContaining({ path: initial.path, content: "第一篇旧知识库草稿" }));
    expect(api.writeDraft).toHaveBeenCalledWith(expect.objectContaining({ path: second.path, content: "第二篇旧知识库草稿" }));
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
    fireEvent.click(screen.getByRole("button", { name: "笔记.md" }));
    expect((await screen.findByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement).value).toBe("新知识库的原文");
  });

  it("知识库菜单保留创建新库的入口", async () => {
    api.chooseDirectory.mockResolvedValue("parent");
    api.createVault.mockResolvedValue({ vault: "parent/我的知识库", error: null });
    render(<DesktopApp />);
    await screen.findByRole("button", { name: "笔记.md" });
    expect(screen.queryByRole("button", { name: "创建知识库" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /知识库选项/ }));
    fireEvent.click(screen.getByRole("button", { name: "新建知识库" }));
    const dialog = await screen.findByRole("dialog", { name: "新知识库名称" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
    await waitFor(() => expect(api.createVault).toHaveBeenCalledWith("parent", "我的知识库"));
  });

  it("创建其他文件夹后仍会自动保存当前编辑", async () => {
    api.createDirectory.mockResolvedValue(undefined);
    api.save.mockImplementation(async (path: string, content: string) => ({ path, content, version: "saved" }));
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    const editor = await screen.findByLabelText("测试编辑器") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "继续自动保存" } });
    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    await screen.findByDisplayValue("新文件夹");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(api.createDirectory).toHaveBeenCalled());
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(initial.path, "继续自动保存", initial.version), { timeout: 4000 });
  });
});

describe("桌面界面", () => {
  it("文件夹重命名同步更新所有受影响的标签路径及视图", async () => {
    const movedPath = "新项目/笔记.md";
    api.move.mockResolvedValue(undefined);
    api.read.mockImplementation(async (path: string) => path === movedPath ? { ...initial, path } : path === initial.path ? initial : second);
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    await screen.findByLabelText("测试编辑器");
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    fireEvent.click(screen.getByRole("button", { name: "其他.md" }));
    await screen.findByRole("tab", { name: "其他.md" });
    fireEvent.contextMenu(screen.getByText("项目", { selector: ".tree-name" }).closest("summary")!, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const rename = await screen.findByDisplayValue("项目"); fireEvent.change(rename, { target: { value: "新项目" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    await waitFor(() => expect(api.read).toHaveBeenCalledWith(movedPath));
    await waitFor(() => expect(screen.getByRole("tab", { name: "笔记.md" }).getAttribute("title")).toBe(movedPath));
    expect(screen.getByRole("tab", { name: "其他.md" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "笔记.md" }));
    expect(screen.getByRole("button", { name: "源码" }).classList.contains("vt-active")).toBe(true);
    expect((screen.getByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement).value).toBe(initial.content);
  });

  it("非当前标签仍有未保存内容时拒绝重命名它", async () => {
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    fireEvent.change(await screen.findByLabelText("测试编辑器"), { target: { value: "后台仍在编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "其他.md" }));
    await screen.findByRole("tab", { name: "其他.md" });
    fireEvent.contextMenu(screen.getByRole("button", { name: "笔记.md" }), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(await screen.findByText(/请先保存或另存当前笔记/)).toBeTruthy();
    expect(api.move).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("保留竖向图标栏和紧凑操作区，新建位置随选择变化", async () => {
    render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
    await screen.findByLabelText("测试编辑器");
    expect(screen.getAllByRole("button", { name: "新建笔记" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "新建文件夹" })).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "主要工具栏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建笔记" }).getAttribute("title")).toContain("项目");
    fireEvent.click(screen.getByRole("button", { name: "所选文件的操作" }));
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "返回根目录" }));
    expect(screen.getByRole("button", { name: "新建笔记" }).getAttribute("title")).toContain("根目录");
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文件树" }));
    expect(screen.getByRole("navigation", { name: "主要工具栏" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新建笔记" })).toBeNull();
  });

  it("右键菜单操作的是右键选中的文件，未打开其他笔记", async () => {
    api.move.mockResolvedValue(undefined);
    render(<DesktopApp />);
    const file = await screen.findByRole("button", { name: "其他.md" });
    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(await screen.findByDisplayValue("其他.md")).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("其他.md"), { target: { value: "改名.md" } });
    fireEvent.keyDown(screen.getByDisplayValue("改名.md"), { key: "Enter" });
    await waitFor(() => expect(api.move).toHaveBeenCalledWith("其他.md", "改名.md"));
    expect(screen.queryByRole("textbox", { name: "测试编辑器" })).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("可以切换主题并在重新打开时保留选择", async () => {
    const first = render(<DesktopApp />);
    fireEvent.click(await screen.findByRole("button", { name: "切换为浅色主题" }));
    expect(first.container.querySelector(".desktop-app.theme-light")).toBeTruthy();
    expect(window.localStorage.getItem("noto.theme")).toBe("light");
    first.unmount();
    const second = render(<DesktopApp />);
    await screen.findByRole("button", { name: "切换为深色主题" });
    expect(second.container.querySelector(".desktop-app.theme-light")).toBeTruthy();
  });

  it("弹窗可以通过 Escape 取消", async () => {
    render(<DesktopApp />);
    await screen.findByRole("button", { name: "笔记.md" });
    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    const dialog = await screen.findByRole("dialog", { name: "新建文件夹" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.createDirectory).not.toHaveBeenCalled();
  });
});
