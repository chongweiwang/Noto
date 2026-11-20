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
import { markdownCodeBlocks } from "./code-copy";

vi.mock("../lib/mermaid", () => ({ renderMermaid: async () => "<svg />" }));
const clipboard = vi.fn();
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard.mockResolvedValue(undefined) } }); });
afterEach(cleanup);
function fixture(content = "原文") {
  const vault = new MemoryVault(); vault.put("项目/a.md", content); vault.put("其他.md", "第二篇");
  const api = { ...vault, status: async () => ({ vault: "experience", id: "experience-test", error: null }), selectVault: vi.fn(), createVault: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), importAttachment: vi.fn(), remove: vi.fn(), openAttachment: vi.fn(), openExternal: vi.fn(), openItem: vi.fn(), image: vi.fn(async () => "data:image/png;base64,AQID"), importAttachmentData: vi.fn(async () => "attachments/图片.png") } satisfies WorkspaceApi;
  render(<WorkspaceRuntimeContext.Provider value={{ kind: "web", api }}><DesktopApp /></WorkspaceRuntimeContext.Provider>);
  return { vault, api };
}
function view() { return EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!; }
async function open(name = "a.md") { fireEvent.click(await screen.findByRole("button", { name })); await screen.findByRole("tab", { name, selected: true }); return waitFor(() => view()); }
function paste(editor: EditorView, file = new File([new Uint8Array([1, 2, 3])], "图片.png", { type: "image/png" })) { fireEvent.paste(editor.contentDOM, { clipboardData: { files: [file] } }); }

it("快速打开按路径筛选并激活已有标签，取消不丢光标和撤销状态", async () => {
  fixture(); const first = await open();
  act(() => first.dispatch({ changes: { from: 0, insert: "继续" }, selection: { anchor: 2 }, userEvent: "input.type" }));
  fireEvent.keyDown(window, { key: "p", ctrlKey: true });
  const dialog = screen.getByRole("dialog", { name: "快速打开文档" });
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "项目/a" } });
  expect(within(dialog).getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Enter" });
  expect(screen.getAllByRole("tab")).toHaveLength(1); expect(view()).toBe(first); expect(first.state.selection.main.anchor).toBe(2);
  act(() => { undo(first); }); expect(first.state.doc.toString()).toBe("原文");
});

it("命令面板改变视图和打开设置，编辑器保持同一实例", async () => {
  fixture(); const first = await open();
  fireEvent.click(screen.getByRole("button", { name: "命令面板" }));
  const query = within(screen.getByRole("dialog", { name: "命令面板" })).getByRole("textbox");
  fireEvent.change(query, { target: { value: "分屏" } }); fireEvent.keyDown(query, { key: "Enter" });
  expect(screen.getByRole("button", { name: "分屏" }).getAttribute("aria-pressed")).toBe("true"); expect(view()).toBe(first);
  fireEvent.keyDown(window, { key: "P", ctrlKey: true, shiftKey: true });
  const input = within(screen.getByRole("dialog", { name: "命令面板" })).getByRole("textbox");
  fireEvent.change(input, { target: { value: "软件设置" } }); fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("dialog", { name: "软件设置" })).toBeTruthy(); expect(view()).toBe(first);
});

it("源码与预览复制代码正文，保留中文并排除围栏和引用前缀", async () => {
  const source = '```ts\nconst 中文 = 1;\n```\n\n> ```js\n> const nested = 2;\n> ```';
  expect(markdownCodeBlocks(source).map((code) => code.value)).toEqual(["const 中文 = 1;", "const nested = 2;"]);
  fixture(source); await open();
  fireEvent.click(screen.getAllByRole("button", { name: "复制代码块" })[0]);
  await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith("const 中文 = 1;"));
  fireEvent.click(screen.getByRole("button", { name: "阅读" }));
  fireEvent.click(screen.getAllByRole("button", { name: "复制代码块" })[1]);
  await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith("const nested = 2;"));
});

it("剪贴板不可用时打开手动复制，不修改代码", async () => {
  clipboard.mockRejectedValue(new Error("不支持")); fixture("```js\nconsole.log(1);\n```"); await open();
  fireEvent.click(screen.getByRole("button", { name: "复制代码块" }));
  const dialog = await screen.findByRole("dialog", { name: "手动复制" });
  expect((within(dialog).getByRole("textbox") as HTMLTextAreaElement).value).toBe("console.log(1);");
  expect(view().state.doc.toString()).toContain("console.log(1)");
});

it("粘贴图片完成前继续输入和切换标签，链接按原位置插入并保留最新输入", async () => {
  const { api, vault } = fixture("前后");
  let complete!: (path: string) => void; api.importAttachmentData.mockImplementation(() => new Promise<string>((resolve) => { complete = resolve; }));
  const first = await open(); act(() => first.dispatch({ selection: { anchor: 1 } })); paste(first);
  await waitFor(() => expect(api.importAttachmentData).toHaveBeenCalled());
  act(() => first.dispatch({ changes: { from: 1, insert: "继续" }, userEvent: "input.type" }));
  const second = await open("其他.md");
  await act(async () => { complete("attachments/图片.png"); });
  expect(view()).toBe(second);
  fireEvent.click(screen.getByRole("tab", { name: /a.md/ })); expect(view()).toBe(first);
  expect(first.state.doc.toString()).toBe("前![图片.png](attachments/%E5%9B%BE%E7%89%87.png)\n继续后");
  await waitFor(() => expect(vault.notes.get("项目/a.md")?.content).toContain("继续后"), { timeout: 3000 });
});

it("关闭标签会等待导入并保存包含图片链接的最新正文", async () => {
  const { api, vault } = fixture();
  let complete!: (path: string) => void; api.importAttachmentData.mockImplementation(() => new Promise<string>((resolve) => { complete = resolve; }));
  const first = await open(); paste(first); await waitFor(() => expect(api.importAttachmentData).toHaveBeenCalled());
  const leaving = new Event("beforeunload", { cancelable: true }); act(() => window.dispatchEvent(leaving)); expect(leaving.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "关闭标签 a.md" })); expect(screen.getByRole("tab", { name: "a.md" })).toBeTruthy();
  await act(async () => { complete("attachments/image.png"); });
  await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
  expect(vault.notes.get("项目/a.md")?.content).toContain("![image.png](attachments/image.png)");
});

it("图片导入失败保留正文并提示，拖入可使用同一附件入口", async () => {
  const { api } = fixture(); const first = await open(); api.importAttachmentData.mockRejectedValueOnce(new Error("空间不足"));
  paste(first); await screen.findByText(/导入附件失败：空间不足/); expect(first.state.doc.toString()).toBe("原文");
  fireEvent.drop(first.contentDOM, { dataTransfer: { files: [new File(["file"], "资料.txt")], types: ["Files"] }, clientX: 0, clientY: 0 });
  await waitFor(() => expect(api.importAttachmentData).toHaveBeenCalledTimes(2));
});

it("本地图片支持键盘打开、原始大小与适应窗口，Esc 关闭", async () => {
  fixture("正文\n\n![示例](attachments/image.png)"); await open();
  fireEvent.click(screen.getByRole("button", { name: "阅读" }));
  fireEvent.keyDown(await screen.findByRole("button", { name: "查看图片 示例" }), { key: "Enter" });
  const dialog = screen.getByRole("dialog", { name: "图片查看" }); expect(within(dialog).getByRole("img", { name: "示例" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "原始大小" })); expect(within(dialog).getByRole("button", { name: "适应窗口" })).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "Escape" }); expect(screen.queryByRole("dialog", { name: "图片查看" })).toBeNull();
});

it("实时图片点击不把光标移入源码，关闭查看器后保留编辑内容", async () => {
  const source = "正文\n\n![示例](attachments/image.png)";
  fixture(source); const editor = await open();
  fireEvent.click(screen.getByRole("button", { name: "实时编辑" }));
  const image = await screen.findByRole("button", { name: "查看图片 示例" });
  const selection = editor.state.selection.main.anchor;
  expect(fireEvent.mouseDown(image)).toBe(false);
  fireEvent.click(image);
  const dialog = await screen.findByRole("dialog", { name: "图片查看" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(editor.state.selection.main.anchor).toBe(selection);
  expect(editor.state.doc.toString()).toBe(source);
});
