// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import DesktopApp from "./desktop-app";
import { MemoryVault } from "../test/memory-vault";
import { taskCategoryMarker, parseTaskDocument } from "../lib/tasks";

const mock = vi.hoisted(() => ({
  api: {} as Record<string, (...args: any[]) => any>, reveal: vi.fn(), copy: vi.fn(), destroy: vi.fn(),
  close: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>),
}));
vi.mock("../lib/desktop-api", () => ({ desktop: mock.api }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async (handler: typeof mock.close) => { mock.close = handler; return () => {}; }, destroy: mock.destroy }) }));
vi.mock("./markdown-editor", async () => {
  const React = await import("react");
  return { MarkdownEditor: React.forwardRef(function Editor(props: { value: string; onChange: (value: string) => void }, ref) {
    React.useImperativeHandle(ref, () => ({ insert: vi.fn(), reveal: mock.reveal, capture: () => undefined, measure: vi.fn(), flushImports: async () => {}, hasPendingImports: () => false }));
    return <textarea aria-label="编辑器" value={props.value} onChange={(event) => props.onChange(event.target.value)} />;
  }) };
});

let api: MemoryVault;
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear(); api = new MemoryVault();
  Object.assign(mock.api, api, { status: async () => ({ vault: "\\\\?\\D:\\测试知识库", error: null }) });
  Object.defineProperty(navigator, "clipboard", { value: { writeText: mock.copy.mockResolvedValue(undefined) }, configurable: true });
});
afterEach(cleanup);

async function openTaskView() {
  const button = await screen.findByRole("button", { name: "任务管理" }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

it("普通笔记移动同时维护入链、共享附件和未保存的引用笔记，不切换其他标签", async () => {
  api.put("项目/笔记.md", "# 标题\n\n![图](attachments/a.png) [需求](需求.md)");
  api.put("项目/需求.md", "需求"); api.put("项目/attachments/a.png", "图片");
  api.put("首页.md", "[[项目/笔记]]"); api.folders.add("归档");
  render(<DesktopApp />); fireEvent.click(await screen.findByRole("button", { name: "首页.md" }));
  fireEvent.change(await screen.findByLabelText("编辑器"), { target: { value: "正在编辑的引用 [[项目/笔记]]" } });
  fireEvent.click(screen.getByRole("button", { name: "笔记.md" })); await screen.findByRole("tab", { name: "笔记.md" });
  fireEvent.contextMenu(screen.getByRole("button", { name: "笔记.md" })); fireEvent.click(screen.getByRole("menuitem", { name: "移动" }));
  fireEvent.click(await screen.findByRole("radio", { name: "▱ 归档" })); fireEvent.click(screen.getByRole("button", { name: "移动到此处" }));
  await waitFor(() => expect(screen.getByRole("tab", { name: "笔记.md" }).getAttribute("title")).toBe("归档/笔记.md"));
  expect(decodeURIComponent(api.notes.get("归档/笔记.md")!.content)).toContain("../项目/attachments/a.png");
  expect(api.notes.get("项目/attachments/a.png")?.content).toBe("图片");
  expect(api.notes.get("首页.md")?.content).toBe("[[归档/笔记]]");
  await waitFor(() => expect(api.stored.get("首页.md")?.content).toBe("正在编辑的引用 [[归档/笔记]]"));
  fireEvent.click(screen.getByRole("tab", { name: /^首页.md/ }));
  expect((screen.getByRole("textbox", { name: "编辑器" }) as HTMLTextAreaElement).value).toBe("正在编辑的引用 [[归档/笔记]]");
  await waitFor(() => expect(api.notes.get("首页.md")?.content).toBe("正在编辑的引用 [[归档/笔记]]"), { timeout: 3500 });
});

it("部分移动失败后同步实际标签路径并暂停自动保存，保留可恢复内容和备份", async () => {
  api.put("原文.md", "需要保留的正文"); api.put("首页.md", "[[原文]]");
  const save = api.save;
  mock.api.save = async (path: string, content: string, version: string) => { if (path === "首页.md") throw new Error("磁盘写入失败"); return save(path, content, version); };
  render(<DesktopApp />); fireEvent.click(await screen.findByRole("button", { name: "原文.md" })); await screen.findByLabelText("编辑器");
  fireEvent.contextMenu(screen.getByRole("button", { name: "原文.md" })); fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  const rename = await screen.findByDisplayValue("原文.md"); fireEvent.change(rename, { target: { value: "改名.md" } }); fireEvent.keyDown(rename, { key: "Enter" });
  await screen.findByText(/目录调整未完成，当前内容已保留/);
  expect(screen.getByRole("tab", { name: /^改名.md/ }).getAttribute("title")).toBe("改名.md");
  expect((screen.getByLabelText("编辑器") as HTMLTextAreaElement).value).toBe("需要保留的正文");
  await waitFor(() => expect(api.stored.get("改名.md")?.content).toBe("需要保留的正文"));
  expect(api.notes.get("首页.md")?.content).toBe("[[原文]]");
  expect([...api.notes.keys()].some((path) => path.includes("/原文/首页.md"))).toBe(true);
});

it("移动后文件被外部删除时仍使用新路径保留草稿，避免会话路径错位", async () => {
  api.put("原文.md", "不能丢失的正文");
  const move = api.move;
  mock.api.move = async (from: string, to: string) => { await move(from, to); api.notes.delete(to); };
  render(<DesktopApp />); fireEvent.click(await screen.findByRole("button", { name: "原文.md" })); await screen.findByLabelText("编辑器");
  fireEvent.contextMenu(screen.getByRole("button", { name: "原文.md" })); fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  const rename = await screen.findByDisplayValue("原文.md"); fireEvent.change(rename, { target: { value: "改名.md" } }); fireEvent.keyDown(rename, { key: "Enter" });
  await screen.findByText(/目录调整期间原文件无法读取/);
  expect(screen.getByRole("tab", { name: /^改名.md/ }).getAttribute("title")).toBe("改名.md");
  await waitFor(() => expect(api.stored.get("改名.md")?.content).toBe("不能丢失的正文"));
  expect(api.notes.has("原文.md")).toBe(false); expect(api.notes.has("改名.md")).toBe(false);
});

it("持久化草稿后模拟异常退出，重开恢复并自动保存最新编辑", async () => {
  api.put("笔记.md", "磁盘正文");
  const first = render(<DesktopApp />); fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
  fireEvent.change(await screen.findByLabelText("编辑器"), { target: { value: "异常退出前的最新编辑" } });
  await waitFor(() => expect(api.stored.get("笔记.md")?.content).toBe("异常退出前的最新编辑"));
  first.unmount(); expect(api.notes.get("笔记.md")?.content).toBe("磁盘正文");
  render(<DesktopApp />); fireEvent.click((await screen.findAllByRole("button", { name: "笔记.md" }))[0]);
  fireEvent.click(await screen.findByRole("button", { name: "恢复草稿" }));
  expect((screen.getByLabelText("编辑器") as HTMLTextAreaElement).value).toBe("异常退出前的最新编辑");
  await waitFor(() => expect(api.notes.get("笔记.md")?.content).toBe("异常退出前的最新编辑"), { timeout: 3500 });
  await waitFor(() => expect(api.stored.has("笔记.md")).toBe(false));
});

it.each(["外部修改", "外部删除"])("草稿对应文件发生%s时保留原文，另存恢复仍维护相对附件", async (change) => {
  const base = api.put("项目/笔记.md", "原文"); api.put("项目/attachments/a.png", "图片");
  api.stored.set(base.path, { path: base.path, baseVersion: base.version, content: "草稿 ![图](attachments/a.png)" });
  if (change === "外部修改") api.put(base.path, "外部新内容"); else api.notes.delete(base.path);
  render(<DesktopApp />); fireEvent.click(await screen.findByRole("button", { name: change === "外部修改" ? "笔记.md" : base.path }));
  fireEvent.click(await screen.findByRole("button", { name: "恢复草稿" }));
  await screen.findByText(/草稿产生后原文件已变化|原文件不存在，请将恢复内容另存/);
  expect(api.notes.get(base.path)?.content).toBe(change === "外部修改" ? "外部新内容" : undefined);
  fireEvent.click(screen.getAllByRole("button", { name: "另存为" })[0]);
  fireEvent.change(await screen.findByDisplayValue("项目/恢复的笔记.md"), { target: { value: "恢复.md" } }); fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await waitFor(() => expect(decodeURIComponent(api.notes.get("恢复.md")?.content ?? "")).toBe("草稿 ![图](项目/attachments/a.png)"));
  expect(api.notes.get(base.path)?.content).toBe(change === "外部修改" ? "外部新内容" : undefined);
});

it("草稿写入失败阻止关闭；修复存储后重试关闭仍保留最新内容", async () => {
  api.put("笔记.md", "磁盘正文");
  mock.api.writeDraft = async () => { throw new Error("存储只读"); };
  render(<DesktopApp />); fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
  fireEvent.change(await screen.findByLabelText("编辑器"), { target: { value: "不能丢失的编辑" } });
  await act(async () => { await mock.close!({ preventDefault() {} }); });
  expect(mock.destroy).not.toHaveBeenCalled();
  await screen.findByText(/窗口保持打开：存储只读/);
  mock.api.writeDraft = api.writeDraft;
  fireEvent.change(screen.getByLabelText("编辑器"), { target: { value: "修复存储后继续编辑" } });
  await act(async () => { await mock.close!({ preventDefault() {} }); });
  expect(mock.destroy).toHaveBeenCalledOnce();
  expect(api.stored.get("笔记.md")?.content).toBe("修复存储后继续编辑");
});

it("分组汇总及折叠，快速添加写入当前分组的收件箱", async () => {
  api.put("任务/工作/开发.md", `${taskCategoryMarker}\n\n- [ ] 设计框架\n`);
  api.put("任务/生活/杂事.md", `${taskCategoryMarker}\n\n- [ ] 整理房间\n`);
  render(<DesktopApp />);
  await openTaskView();
  expect((await screen.findByRole("button", { name: /设计框架/ })).textContent).toContain("工作 / 开发");
  await screen.findByRole("button", { name: /整理房间/ });
  fireEvent.click(screen.getByRole("button", { name: "折叠分组 工作" }));
  expect(screen.queryByRole("button", { name: "开发" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看分组 工作" }));
  await screen.findByRole("heading", { name: "工作" });
  expect(screen.queryByRole("button", { name: /整理房间/ })).toBeNull();
  const input = screen.getByLabelText("新任务名称");
  fireEvent.change(input, { target: { value: "工作组的新任务" } }); fireEvent.submit(input.closest("form")!);
  await screen.findByRole("button", { name: /工作组的新任务/ });
  await waitFor(() => expect(api.notes.get("任务/工作/收件箱.md")?.content).toContain("工作组的新任务"), { timeout: 3500 });
  expect(api.notes.has("任务/默认/收件箱.md")).toBe(false);
  expect(screen.getByRole("heading", { name: "工作" })).toBeTruthy();
});

it("创建分组和分类、跨组移动分类，并同步更新入链和打开的标签", async () => {
  api.put("任务/工作/开发.md", `${taskCategoryMarker}\n\n- [ ] 开发功能\n`);
  api.put("首页.md", "[[任务/工作/开发|开发分类]]");
  render(<DesktopApp />);
  await openTaskView();
  await screen.findByRole("button", { name: /开发功能/ });
  fireEvent.click(screen.getByRole("button", { name: "新建任务分组" }));
  fireEvent.change(await screen.findByDisplayValue("新分组"), { target: { value: "个人" } }); fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await screen.findByRole("button", { name: "查看分组 个人" });
  fireEvent.click(screen.getByRole("button", { name: "在分组 个人 新建分类" }));
  fireEvent.change(await screen.findByDisplayValue("新分类"), { target: { value: "计划" } }); fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await waitFor(() => expect(api.notes.get("任务/个人/计划.md")?.content).toContain(taskCategoryMarker));
  fireEvent.click(await screen.findByRole("button", { name: "开发" }));
  await screen.findByRole("heading", { name: "开发" });
  fireEvent.click(await screen.findByRole("button", { name: /开发功能/ }));
  fireEvent.click(screen.getByRole("button", { name: "打开分类文件" }));
  await screen.findByRole("textbox", { name: "编辑器" });
  fireEvent.click(screen.getByRole("tab", { name: /^任务管理/ }));
  fireEvent.click(screen.getByRole("button", { name: "分类 工作 / 开发 的操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "移动" }));
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; }), move = api.move;
  const moving = vi.fn(async (from: string, to: string) => { await pending; await move(from, to); });
  mock.api.move = moving;
  fireEvent.change(await screen.findByRole("combobox", { name: "移动任务分类" }), { target: { value: "任务/个人" } }); fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await waitFor(() => expect(moving).toHaveBeenCalled());
  let closing!: Promise<void>;
  await act(async () => { closing = mock.close!({ preventDefault() {} }); await Promise.resolve(); });
  expect(mock.destroy).not.toHaveBeenCalled();
  await act(async () => { finish(); await closing; });
  expect(mock.destroy).toHaveBeenCalledOnce();
  await waitFor(() => expect(api.notes.has("任务/个人/开发.md")).toBe(true));
  expect(api.notes.has("任务/工作/开发.md")).toBe(false);
  expect(api.notes.get("首页.md")?.content).toBe("[[任务/个人/开发|开发分类]]");
  fireEvent.click(screen.getByRole("tab", { name: /^开发.md/ }));
  expect(screen.getByRole("textbox", { name: "编辑器" })).toBeTruthy();
  expect(document.querySelector(".active-note-path")?.textContent ?? document.body.textContent).toContain("任务/个人/开发.md");
});

it("大纲随编辑更新，支持跳转、层级折叠和面板开关，底栏统计显示中文和字符", async () => {
  api.put("笔记.md", "# 章节\n\n### 子节\n\n正文");
  render(<DesktopApp />); fireEvent.click(await screen.findByRole("button", { name: "笔记.md" }));
  const outline = await screen.findByRole("complementary", { name: "标题大纲" });
  const nav = within(outline).getByRole("navigation", { name: "笔记标题" });
  fireEvent.click(within(nav).getByRole("button", { name: "子节" }));
  expect(mock.reveal).toHaveBeenCalledWith(6, "# 章节\n\n### 子节\n\n正文");
  fireEvent.click(within(nav).getByRole("button", { name: "折叠标题 章节" }));
  expect(within(nav).queryByRole("button", { name: "子节" })).toBeNull();
  fireEvent.click(within(outline).getByRole("button", { name: "收起标题大纲" }));
  expect(screen.queryByRole("complementary", { name: "标题大纲" })).toBeNull();
  fireEvent.keyDown(window, { key: "o", code: "KeyO", ctrlKey: true, shiftKey: true });
  expect(screen.getByRole("complementary", { name: "标题大纲" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "编辑器" }), { target: { value: "# 新标题\n\n中文 Hello" } });
  expect(within(screen.getByRole("navigation", { name: "笔记标题" })).getByRole("button", { name: "新标题" })).toBeTruthy();
  const stats = screen.getByLabelText("笔记统计");
  expect(stats.textContent).toContain("6 字"); expect(stats.textContent).toContain("3 行");
});

it("结构树右键复制路径和可粘贴链接，文件夹只提供路径", async () => {
  api.put("项目/来源.md", "正文"); api.put("其他/目标 一.md", "目标");
  render(<DesktopApp />); fireEvent.click(await screen.findByRole("button", { name: "来源.md" }));
  await screen.findByRole("textbox", { name: "编辑器" });
  async function copy(name: string, expected: string) {
    fireEvent.contextMenu(screen.getByRole("button", { name: "目标 一.md" }), { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByRole("menuitem", { name })); await waitFor(() => expect(mock.copy).toHaveBeenLastCalledWith(expected));
  }
  await copy("复制相对路径", "其他/目标 一.md");
  await copy("复制绝对路径", "D:/测试知识库/其他/目标 一.md");
  await copy("复制 Wiki 链接", "[[其他/目标 一]]");
  await copy("复制 Markdown 链接", "[目标 一](../%E5%85%B6%E4%BB%96/%E7%9B%AE%E6%A0%87%20%E4%B8%80.md)");
  fireEvent.contextMenu(screen.getByText("其他", { selector: ".tree-name" }).closest("summary")!);
  expect(screen.queryByRole("menuitem", { name: "复制 Wiki 链接" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "复制 Markdown 链接" })).toBeNull();
});

it("首次整理目录时关闭窗口会等待迁移，不会中断文件与草稿写入", async () => {
  api.put("任务/旧分类.md", `${taskCategoryMarker}\n\n- [ ] 原任务\n`);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; }), move = api.move;
  const moving = vi.fn(async (from: string, to: string) => { await pending; await move(from, to); });
  mock.api.move = moving;
  render(<DesktopApp />); await waitFor(() => expect(moving).toHaveBeenCalled());
  let closing!: Promise<void>;
  await act(async () => { closing = mock.close!({ preventDefault() {} }); await Promise.resolve(); });
  expect(mock.destroy).not.toHaveBeenCalled();
  await act(async () => { finish(); await closing; });
  expect(mock.destroy).toHaveBeenCalledOnce();
  expect(parseTaskDocument(api.notes.get("任务/默认/旧分类.md")!.content).tasks[0].title).toBe("原任务");
});
