// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { localDate, dailyPath } from "../lib/calendar";
import { vaultEntries } from "../test/vault-entries";
import DesktopApp from "./desktop-app";

const api = vi.hoisted(() => ({
  status: vi.fn(), entries: vi.fn(), drafts: vi.fn(), read: vi.fn(), save: vi.fn(),
  writeDraft: vi.fn(), removeDraft: vi.fn(), createNote: vi.fn(), createDirectory: vi.fn(),
  selectVault: vi.fn(), createVault: vi.fn(), move: vi.fn(), remove: vi.fn(), importAttachment: vi.fn(),
  image: vi.fn(), openAttachment: vi.fn(), openItem: vi.fn(), openExternal: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(),
}));
vi.mock("../lib/desktop-api", () => ({ desktop: api }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: vi.fn() }) }));
vi.mock("./markdown-editor", async () => {
  const React = await import("react");
  return { MarkdownEditor: React.forwardRef(function FakeEditor(props: { value: string; onChange: (value: string) => void; onWikiOpen?: (target: string) => void }, _ref) {
    return <><textarea aria-label="测试编辑器" value={props.value} onChange={(event) => props.onChange(event.target.value)} /><button type="button" onClick={() => props.onWikiOpen?.("目标")}>打开同名链接</button></>;
  }) };
});
vi.mock("./markdown-preview", () => ({ MarkdownPreview: () => <div /> }));

const entry = (path: string) => ({ path, name: path.split("/").pop()!, isDirectory: false, children: [] });
const folder = (path: string, children: ReturnType<typeof entry>[]) => ({ path, name: path, isDirectory: true, children });
const makeNote = (path: string, content: string) => ({ path, content, version: "v1" });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  api.status.mockResolvedValue({ vault: "test-vault", error: null });
  api.drafts.mockResolvedValue([]);
  api.writeDraft.mockResolvedValue(undefined);
  api.removeDraft.mockResolvedValue(undefined);
  api.createDirectory.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("搜索中文正文并从结果打开笔记", async () => {
  api.entries.mockResolvedValue([entry("目标.md"), folder("项目", [entry("项目/来源.md")])]);
  api.read.mockImplementation(async (path: string) => makeNote(path, path === "目标.md" ? "标题\n需要查找的中文正文" : "另一篇"));
  render(<DesktopApp />);
  await screen.findByRole("button", { name: "目标.md" });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  const input = screen.getByRole("searchbox", { name: "搜索笔记" });
  fireEvent.change(input, { target: { value: "中文正文" } });
  const result = await screen.findByRole("button", { name: /目标\.md.*中文正文/ });
  fireEvent.click(result);
  expect((await screen.findByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement).value).toContain("中文正文");
});

it("中文输入法组合期间按回车不会意外打开搜索结果", async () => {
  api.entries.mockResolvedValue([entry("目标.md")]);
  api.read.mockResolvedValue(makeNote("目标.md", "中文正文"));
  render(<DesktopApp />);
  await screen.findByRole("button", { name: "目标.md" });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  const input = screen.getByRole("searchbox", { name: "搜索笔记" });
  fireEvent.change(input, { target: { value: "中文" } });
  await screen.findByText("找到 1 篇笔记，1 处正文命中");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(screen.queryByLabelText("测试编辑器")).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByRole("textbox", { name: "测试编辑器" })).toBeTruthy();
});

it("同名 Wiki 链接要求选择，跳转前持久化当前编辑", async () => {
  api.entries.mockResolvedValue([entry("当前.md"), folder("一", [entry("一/目标.md")]), folder("二", [entry("二/目标.md")])]);
  api.read.mockImplementation(async (path: string) => makeNote(path, `内容：${path}`));
  render(<DesktopApp />);
  fireEvent.click(await screen.findByRole("button", { name: "当前.md" }));
  const editor = await screen.findByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: "未保存的编辑" } });
  fireEvent.click(screen.getByRole("button", { name: "打开同名链接" }));
  expect(screen.getByRole("dialog", { name: "选择链接目标" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "二/目标.md" }));
  await waitFor(() => expect(api.writeDraft).toHaveBeenCalledWith(expect.objectContaining({ path: "当前.md", content: "未保存的编辑" })));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement).value).toBe("内容：二/目标.md"));
});

it("反向链接忽略代码，并在外部文件修改后刷新", async () => {
  api.entries.mockResolvedValue([entry("目标.md"), entry("来源.md")]);
  let source = "[[目标]]\n`[[目标]]`";
  api.read.mockImplementation(async (path: string) => makeNote(path, path === "来源.md" ? source : "目标正文"));
  render(<DesktopApp />);
  fireEvent.click(await screen.findByRole("button", { name: "目标.md" }));
  await screen.findByRole("textbox", { name: "测试编辑器" });
  fireEvent.click(screen.getByRole("button", { name: "反向链接" }));
  expect(await screen.findByText("1 处引用")).toBeTruthy();
  source = "已删除链接";
  await waitFor(() => expect(screen.getByText("还没有其他笔记引用此笔记。")).toBeTruthy(), { timeout: 5000 });
});

it("日历打开已有每日笔记，不调用创建", async () => {
  const path = dailyPath(localDate(new Date()));
  api.entries.mockResolvedValue(vaultEntries([path]));
  api.read.mockImplementation(async (requested: string) => makeNote(requested, "原有内容"));
  render(<DesktopApp />);
  await screen.findByRole("button", { name: "任务与日记" });
  fireEvent.click(screen.getByRole("button", { name: "日历" }));
  fireEvent.click(screen.getByRole("button", { name: `${localDate(new Date())}，打开每日笔记` }));
  expect((await screen.findByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement).value).toBe("原有内容");
  expect(api.createNote).not.toHaveBeenCalled();
  expect(api.createDirectory).not.toHaveBeenCalled();
});

it("再次选择正在编辑的每日笔记不会打断未保存内容", async () => {
  const date = localDate(new Date()), path = dailyPath(date);
  api.entries.mockResolvedValue(vaultEntries([path]));
  api.read.mockImplementation(async (requested: string) => makeNote(requested, "原有内容"));
  render(<DesktopApp />);
  await screen.findByRole("button", { name: "任务与日记" });
  fireEvent.click(screen.getByRole("button", { name: "日历" }));
  fireEvent.click(screen.getByRole("button", { name: `${date}，打开每日笔记` }));
  const editor = await screen.findByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: "正在编辑" } });
  await waitFor(() => expect(api.writeDraft).toHaveBeenCalledWith(expect.objectContaining({ path, content: "正在编辑" })));
  fireEvent.click(screen.getByRole("button", { name: `${date}，打开每日笔记` }));
  expect(editor.value).toBe("正在编辑");
  expect(screen.queryByText(/发现恢复草稿/)).toBeNull();
});

it("每日笔记被外部抢先创建时只读取已有文件，保留未保存草稿", async () => {
  const path = dailyPath(localDate(new Date()));
  api.entries.mockResolvedValue([entry("当前.md")]);
  api.read.mockImplementation(async (requested: string) => makeNote(requested, requested === path ? "外部已有内容" : "原文"));
  api.createNote.mockRejectedValue("文件已存在");
  render(<DesktopApp />);
  fireEvent.click(await screen.findByRole("button", { name: "当前.md" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "测试编辑器" }), { target: { value: "待恢复编辑" } });
  fireEvent.click(screen.getByRole("button", { name: "日历" }));
  fireEvent.click(screen.getByRole("button", { name: `${localDate(new Date())}，创建每日笔记` }));
  await waitFor(() => expect(api.writeDraft).toHaveBeenCalledWith(expect.objectContaining({ path: "当前.md", content: "待恢复编辑" })));
  expect((await screen.findByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement).value).toBe("外部已有内容");
  expect(api.createNote).toHaveBeenCalledTimes(1);
  expect(api.createNote).toHaveBeenCalledWith(path);
});

it("每日笔记文件消失但存在草稿时先进入恢复，不创建空文件", async () => {
  const path = dailyPath(localDate(new Date()));
  const draft = { path, content: "仍需恢复的日记", baseVersion: "old-version" };
  api.entries.mockResolvedValue([]);
  api.drafts.mockResolvedValue([draft]);
  api.read.mockRejectedValue("文件不存在");
  render(<DesktopApp />);
  await screen.findByRole("button", { name: path });
  fireEvent.click(screen.getByRole("button", { name: "日历" }));
  fireEvent.click(screen.getByRole("button", { name: `${localDate(new Date())}，创建每日笔记` }));
  await screen.findByText(/原文件已不存在/);
  expect(api.createDirectory).not.toHaveBeenCalled();
  expect(api.createNote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
  expect((await screen.findByRole("textbox", { name: "测试编辑器" }) as HTMLTextAreaElement).value).toBe(draft.content);
});

it("日记目录被同名文件占用时显示错误，不创建笔记", async () => {
  api.entries.mockResolvedValue([entry("日记")]);
  render(<DesktopApp />);
  await screen.findByRole("button", { name: "日记" });
  fireEvent.click(screen.getByRole("button", { name: "日历" }));
  fireEvent.click(screen.getByRole("button", { name: `${localDate(new Date())}，创建每日笔记` }));
  await screen.findByText(/已存在但不是文件夹/);
  expect(api.createNote).not.toHaveBeenCalled();
});
