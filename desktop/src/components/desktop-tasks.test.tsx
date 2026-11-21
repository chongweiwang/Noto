// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import DesktopApp from "./desktop-app";
import { parseTaskDocument, taskCategoryMarker } from "../lib/tasks";
import { vaultEntries } from "../test/vault-entries";

const api = vi.hoisted(() => ({
  status: vi.fn(), entries: vi.fn(), drafts: vi.fn(), read: vi.fn(), save: vi.fn(),
  writeDraft: vi.fn(), removeDraft: vi.fn(), createNote: vi.fn(), createDirectory: vi.fn(),
  selectVault: vi.fn(), createVault: vi.fn(), move: vi.fn(), remove: vi.fn(),
  importAttachment: vi.fn(), image: vi.fn(), openAttachment: vi.fn(), openExternal: vi.fn(), openItem: vi.fn(),
  chooseDirectory: vi.fn(), chooseFile: vi.fn(),
}));
vi.mock("../lib/desktop-api", () => ({ desktop: api }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: vi.fn() }) }));
vi.mock("./markdown-editor", async () => {
  const React = await import("react");
  return { MarkdownEditor: React.forwardRef(function FakeEditor(props: { value: string; onChange: (value: string) => void }, _ref) {
    return <textarea aria-label="笔记编辑器" value={props.value} onChange={(event) => props.onChange(event.target.value)} />;
  }) };
});

type Note = { path: string; content: string; version: string };
type Draft = { path: string; content: string; baseVersion: string };
let notes: Map<string, Note>, drafts: Map<string, Draft>, folders: Set<string>, version: number;
const work = "任务/默认/工作.md", life = "任务/默认/生活.md";

function put(path: string, content: string) {
  const note = { path, content, version: `v${++version}` };
  notes.set(path, note);
  return { ...note };
}
function entries() { return vaultEntries(notes.keys(), folders); }
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear();
  notes = new Map(); drafts = new Map(); folders = new Set(); version = 0;
  api.status.mockResolvedValue({ vault: "test-vault", error: null });
  api.entries.mockImplementation(async () => entries());
  api.drafts.mockImplementation(async () => [...drafts.values()].map((draft) => ({ ...draft })));
  api.read.mockImplementation(async (path: string) => { const note = notes.get(path); if (!note) throw new Error("文件不存在"); return { ...note }; });
  api.createDirectory.mockImplementation(async (path: string) => { if (folders.has(path)) throw new Error("目录已存在"); folders.add(path); });
  api.createNote.mockImplementation(async (path: string, content = "") => { if (notes.has(path)) throw new Error("文件已存在"); return put(path, content); });
  api.save.mockImplementation(async (path: string, content: string, expected: string) => { const note = notes.get(path); if (!note || note.version !== expected) throw new Error("文件已被外部修改"); return put(path, content); });
  api.writeDraft.mockImplementation(async (draft: Draft) => { drafts.set(draft.path, { ...draft }); });
  api.removeDraft.mockImplementation(async (path: string) => { drafts.delete(path); });
  api.move.mockImplementation(async (from: string, to: string) => {
    if (notes.has(to) || folders.has(to)) throw new Error("目标已存在");
    if (folders.has(from)) {
      for (const path of [...folders]) if (path === from || path.startsWith(`${from}/`)) { folders.delete(path); folders.add(to + path.slice(from.length)); }
      for (const [path, note] of [...notes]) if (path.startsWith(`${from}/`)) { notes.delete(path); const target = to + path.slice(from.length); notes.set(target, { ...note, path: target }); }
    } else { const note = notes.get(from); if (!note) throw new Error("无法移动"); notes.delete(from); notes.set(to, { ...note, path: to }); }
  });
  api.remove.mockImplementation(async (path: string) => { if (!notes.delete(path)) throw new Error("文件不存在"); });
  api.openExternal.mockResolvedValue(undefined);
  api.openAttachment.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

async function openTasks() {
  const view = render(<DesktopApp />);
  const button = await screen.findByRole("button", { name: "任务管理" }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByRole("heading", { name: "全部任务" });
  return view;
}
async function openCategory(name: string) {
  const aside = screen.getByRole("complementary");
  fireEvent.click(within(aside).getByRole("button", { name }));
  await screen.findByRole("heading", { name });
}

describe("独立任务管理", () => {
  it("任务管理是独立标签，与分类笔记共用内容并保留详情编辑状态", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 共享分类\n  - 备注：初始备注\n`);
    await openTasks(); await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /共享分类/ }));
    const remark = await screen.findByLabelText("Markdown 备注") as HTMLTextAreaElement;
    fireEvent.change(remark, { target: { value: "详情里编辑的备注" } });
    fireEvent.click(screen.getByRole("button", { name: "打开分类文件" }));
    const source = await screen.findByRole("textbox", { name: "笔记编辑器" }) as HTMLTextAreaElement;
    expect(source.value).toContain("详情里编辑的备注");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent.change(source, { target: { value: source.value.replace("详情里编辑的备注", "原文里编辑的备注") } });
    fireEvent.click(screen.getByRole("tab", { name: /^任务管理/ }));
    expect(screen.getByRole("region", { name: "任务详情" })).toBeTruthy();
    expect(screen.getByLabelText("Markdown 备注")).toBe(remark);
    expect(remark.value).toBe("原文里编辑的备注");
    fireEvent.change(remark, { target: { value: "再次编辑的备注" } });
    fireEvent.click(screen.getByRole("tab", { name: /^工作.md/ }));
    expect(screen.getByRole("textbox", { name: "笔记编辑器" })).toBe(source);
    expect(source.value).toContain("再次编辑的备注");
    expect(screen.queryByText(/发现恢复草稿/)).toBeNull();
    await waitFor(() => expect(parseTaskDocument(notes.get(work)!.content).tasks[0].remark).toBe("再次编辑的备注"), { timeout: 3500 });
  });

  it("跨分类移动前保存目标标签的编辑，并将新增任务同步到那个标签", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 要移动的任务\n`);
    put(life, `${taskCategoryMarker}\n\n# 生活\n\n- [ ] 原有任务\n  - 备注：原始备注\n`);
    await openTasks(); await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /要移动的任务/ }));
    fireEvent.click(screen.getByRole("button", { name: "文件树" }));
    fireEvent.click(await screen.findByRole("button", { name: "任务与日记" }));
    fireEvent.click(await screen.findByRole("button", { name: "生活.md" }));
    const source = await screen.findByRole("textbox", { name: "笔记编辑器" }) as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: source.value.replace("原始备注", "目标标签的新备注") } });
    fireEvent.click(screen.getByRole("tab", { name: /^任务管理/ }));
    fireEvent.change(screen.getByLabelText("任务分类"), { target: { value: life } });
    await waitFor(() => expect(parseTaskDocument(notes.get(work)!.content).tasks).toHaveLength(0));
    expect(parseTaskDocument(notes.get(life)!.content).tasks).toHaveLength(2);
    expect(parseTaskDocument(notes.get(life)!.content).tasks[0].remark).toBe("目标标签的新备注");
    fireEvent.click(screen.getByRole("tab", { name: /^生活.md/ }));
    expect(source.value).toContain("目标标签的新备注");
    expect(source.value).toContain("要移动的任务");
    expect(screen.queryByText(/发现恢复草稿/)).toBeNull();
  });

  it("全部任务默认只显示列表，按需展开详情，关闭和重开不丢失编辑", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 设计框架\n  - 备注：初始说明\n`);
    put(life, `${taskCategoryMarker}\n\n# 生活\n\n- [ ] 整理书房\n`);
    await openTasks();
    const row = await screen.findByRole("button", { name: /设计框架/ });
    expect(screen.queryByRole("region", { name: "任务详情" })).toBeNull();
    fireEvent.click(row);
    const input = await screen.findByLabelText("Markdown 备注") as HTMLTextAreaElement;
    expect(screen.getByRole("heading", { name: "全部任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /整理书房/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: "尚未自动保存的 **说明**" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭任务详情" }));
    expect(screen.queryByRole("region", { name: "任务详情" })).toBeNull();
    fireEvent.click(row);
    expect((await screen.findByLabelText("Markdown 备注") as HTMLTextAreaElement).value).toBe("尚未自动保存的 **说明**");
    fireEvent.keyDown(screen.getByLabelText("Markdown 备注"), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "任务详情" })).toBeNull();
    fireEvent.click(row);
    await screen.findByRole("region", { name: "任务详情" });
    fireEvent.click(document.querySelector(".task-drawer-backdrop")!);
    expect(screen.queryByRole("region", { name: "任务详情" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文件树" }));
    await screen.findByRole("heading", { name: "打开文档，开始记录" });
    fireEvent.click(screen.getByRole("button", { name: "任务管理" }));
    expect(screen.queryByRole("region", { name: "任务详情" })).toBeNull();
    await waitFor(() => expect(parseTaskDocument(notes.get(work)!.content).tasks[0].remark).toBe("尚未自动保存的 **说明**"), { timeout: 3500 });
  });

  it("快速添加和勾选只更新列表，并可折叠已完成分组", async () => {
    await openTasks();
    const input = screen.getByLabelText("新任务名称") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "第一件事" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByRole("button", { name: /第一件事/ });
    expect(screen.getByRole("heading", { name: "全部任务" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "任务详情" })).toBeNull();
    await waitFor(() => expect(input.value).toBe(""));
    fireEvent.change(input, { target: { value: "第二件事" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByRole("button", { name: /第二件事/ });
    expect(screen.getAllByRole("button", { name: /第一件事|第二件事/ }).map((button) => button.title)).toEqual(["第二件事", "第一件事"]);
    fireEvent.click(screen.getByLabelText("完成任务：第一件事"));
    await waitFor(() => expect((screen.getByLabelText("完成任务：第一件事") as HTMLInputElement).checked).toBe(true));
    const group = screen.getByRole("button", { name: /已完成\s*1\s*项/, expanded: true });
    expect(screen.queryByRole("region", { name: "任务详情" })).toBeNull();
    expect(screen.getByRole("heading", { name: "全部任务" })).toBeTruthy();
    fireEvent.click(group);
    expect(screen.queryByRole("button", { name: /第一件事/ })).toBeNull();
    expect(screen.getByRole("button", { name: /第二件事/ })).toBeTruthy();
    fireEvent.click(group);
    expect(screen.getByRole("button", { name: /第一件事/ })).toBeTruthy();
    await waitFor(() => expect(parseTaskDocument(notes.get("任务/默认/收件箱.md")!.content).tasks.map(({ title, completed }) => ({ title, completed }))).toEqual([
      { title: "第二件事", completed: false },
      { title: "第一件事", completed: true },
    ]), { timeout: 3500 });
  });

  it("分类对应单个 Markdown 文件，可重命名并移到回收站", async () => {
    await openTasks();
    fireEvent.click(screen.getByRole("button", { name: "新建任务分类" }));
    fireEvent.change(await screen.findByDisplayValue("新分类"), { target: { value: "工作" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(notes.get(work)?.content).toContain(taskCategoryMarker));
    fireEvent.click(await screen.findByRole("button", { name: "分类 默认 / 工作 的操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(await screen.findByDisplayValue("工作"), { target: { value: "项目" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(notes.has("任务/默认/项目.md")).toBe(true));
    expect(notes.has(work)).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "分类 默认 / 项目 的操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(await screen.findByText(/文件夹中的内容也会一并移入回收站/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(notes.has("任务/默认/项目.md")).toBe(false));
  });

  it("分类确认期间文件被外部修改时停止重命名", async () => {
    folders.add("任务"); put(work, `${taskCategoryMarker}\n\n# 工作\n`);
    await openTasks();
    await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: "分类 默认 / 工作 的操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(await screen.findByDisplayValue("工作"), { target: { value: "项目" } });
    put(work, "# 外部改为普通文件\n");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await screen.findByText(/分类文件已变化/);
    expect(notes.get(work)?.content).toBe("# 外部改为普通文件\n");
    expect(notes.has("任务/默认/项目.md")).toBe(false);
  });

  it("从收件箱创建任务，保存日期、Markdown 备注，并打开相对笔记链接", async () => {
    folders.add("项目"); put("项目/需求.md", "需求内容");
    await openTasks();
    fireEvent.change(screen.getByLabelText("新任务名称"), { target: { value: "设计任务界面" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(await screen.findByRole("button", { name: /设计任务界面/ }));
    const title = await screen.findByLabelText("任务名称") as HTMLInputElement;
    expect(title.value).toBe("设计任务界面");
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-11-13" } });
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2026-11-15" } });
    const note = "参考 **架构** 和 [需求文档](../../项目/需求.md)\n\n- 明确分类\n- 添加备注";
    fireEvent.change(screen.getByLabelText("Markdown 备注"), { target: { value: note } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(parseTaskDocument(notes.get("任务/默认/收件箱.md")!.content).tasks[0]).toMatchObject({ title: "设计任务界面", startDate: "2026-11-13", endDate: "2026-11-15", remark: note }));
    expect(folders.has("任务")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    fireEvent.click(await screen.findByRole("link", { name: "需求文档" }));
    await waitFor(() => expect(api.read).toHaveBeenCalledWith("项目/需求.md"));
    expect((await screen.findByLabelText("笔记编辑器") as HTMLTextAreaElement).value).toBe("需求内容");
  });

  it("重新打开应用后从 Markdown 文件恢复日期和备注", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 持久任务\n`);
    const view = await openTasks();
    await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /持久任务/ }));
    fireEvent.change(await screen.findByLabelText("开始日期"), { target: { value: "2026-11-13" } });
    fireEvent.change(screen.getByLabelText("Markdown 备注"), { target: { value: "第一行\n\n[文档](../../项目/需求.md)\n" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(parseTaskDocument(notes.get(work)!.content).tasks[0].startDate).toBe("2026-11-13"));
    await waitFor(() => expect(drafts.has(work)).toBe(false));
    view.unmount();
    // Validate reconstruction from Markdown independently of restored UI metadata.
    window.localStorage.clear();
    await openTasks();
    await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /持久任务/ }));
    expect((await screen.findByLabelText("开始日期") as HTMLInputElement).value).toBe("2026-11-13");
    expect((screen.getByLabelText("Markdown 备注") as HTMLTextAreaElement).value).toBe("第一行\n\n[文档](../../项目/需求.md)\n");
  });

  it("自动保存期间继续输入时保持焦点、选区并保存最新内容", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 连续编辑\n  - 备注：初始说明\n`);
    let finish!: () => void;
    const firstSave = new Promise<void>((resolve) => { finish = resolve; });
    let first = true;
    api.save.mockImplementation(async (path: string, content: string, expected: string) => {
      if (notes.get(path)?.version !== expected) throw new Error("文件已被外部修改");
      if (first) { first = false; await firstSave; }
      return put(path, content);
    });
    await openTasks(); await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /连续编辑/ }));
    const input = await screen.findByLabelText("Markdown 备注") as HTMLTextAreaElement;
    input.focus();
    fireEvent.change(input, { target: { value: "正在编辑的说明" } });
    input.setSelectionRange(3, 3);
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1), { timeout: 3500 });
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3);
    fireEvent.change(input, { target: { value: "正在编辑的说明，保存时继续输入" } });
    input.setSelectionRange(5, 5);
    await act(async () => { finish(); await firstSave; });
    await waitFor(() => expect(drafts.get(work)?.baseVersion).toBe(notes.get(work)?.version));
    expect(screen.getByLabelText("Markdown 备注")).toBe(input);
    expect(input.value).toBe("正在编辑的说明，保存时继续输入");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(5);
    const savedVersion = notes.get(work)!.version;
    await waitFor(() => expect(parseTaskDocument(notes.get(work)!.content).tasks[0].remark).toBe(input.value), { timeout: 3500 });
    expect(api.save.mock.calls[1][2]).toBe(savedVersion);
    expect(screen.queryByText(/文件已被外部修改/)).toBeNull();
  }, 10000);

  it("说明中插入的任务框能在预览勾选并自动保存", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 带清单的任务\n`);
    await openTasks(); await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /带清单的任务/ }));
    const input = await screen.findByLabelText("Markdown 备注") as HTMLTextAreaElement;
    input.focus();
    fireEvent.change(input, { target: { value: "核对方案" } });
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.click(screen.getByRole("button", { name: "备注插入任务框" }));
    expect(input.value).toBe("- [ ] 核对方案");
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "备注任务：核对方案" }));
    await waitFor(() => expect(parseTaskDocument(notes.get(work)!.content).tasks[0].remark).toBe("- [x] 核对方案"), { timeout: 3500 });
    expect(parseTaskDocument(notes.get(work)!.content).tasks).toHaveLength(1);
    expect(parseTaskDocument(notes.get(work)!.content).tasks[0].completed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect((screen.getByLabelText("Markdown 备注") as HTMLTextAreaElement).value).toBe("- [x] 核对方案");
  });

  it("不汇总普通笔记，并在保存冲突时保留任务备注和草稿", async () => {
    folders.add("任务"); folders.add("项目");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 任务一\n  - 备注：原始备注\n`);
    put("项目/普通.md", "- [ ] 普通笔记里的复选框\n");
    put("任务/普通.md", "# 原有普通笔记\n\n- [ ] 不应作为独立任务\n");
    await openTasks();
    await screen.findByRole("button", { name: /任务一/ });
    expect(screen.queryByText("普通笔记里的复选框")).toBeNull();
    expect(screen.queryByText("不应作为独立任务")).toBeNull();
    expect(within(screen.getByRole("complementary")).queryByRole("button", { name: "普通" })).toBeNull();
    await openCategory("工作");
    fireEvent.click(screen.getByRole("button", { name: /任务一/ }));
    const editor = await screen.findByLabelText("Markdown 备注") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "尚未保存的 **备注**" } });
    put(work, "# 工作\n\n外部修改\n");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/保存失败：文件已被外部修改/);
    expect(editor.value).toBe("尚未保存的 **备注**");
    expect(notes.get(work)?.content).toContain("外部修改");
    await waitFor(() => expect(drafts.get(work)?.content).toContain("尚未保存的 **备注**"));
    fireEvent.click(screen.getByRole("button", { name: "另存为" }));
    const target = await screen.findByDisplayValue("任务/默认/恢复的笔记.md");
    fireEvent.change(target, { target: { value: "任务/默认/恢复的任务.md" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await screen.findByRole("heading", { name: "恢复的任务" });
    expect(parseTaskDocument(notes.get("任务/默认/恢复的任务.md")!.content).tasks[0].remark).toBe("尚未保存的 **备注**");
  });

  it("跨分类移动时先写目标；来源保存失败则显示重复风险并保留来源", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 待移动\n  - 备注：保留 [链接](../../项目/需求.md)\n`);
    put(life, `${taskCategoryMarker}\n\n# 生活\n`);
    api.save.mockImplementation(async (path: string, content: string, expected: string) => {
      const note = notes.get(path); if (!note || note.version !== expected) throw new Error("文件已被外部修改");
      if (path === work) throw new Error("模拟来源写入失败");
      return put(path, content);
    });
    await openTasks();
    await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /待移动/ }));
    fireEvent.change(await screen.findByLabelText("任务分类"), { target: { value: life } });
    await screen.findByText(/目标分类已写入，但来源分类未能确认移除/);
    expect(notes.get(work)?.content).toContain("待移动");
    expect(notes.get(life)?.content).toContain("待移动");
    expect(parseTaskDocument(notes.get(life)!.content).tasks[0].remark).toContain("[链接](../../项目/需求.md)");
  });

  it("目标文件的分类标记被外部移除时拒绝移动", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 不能误写\n`);
    put(life, `${taskCategoryMarker}\n\n# 生活\n`);
    await openTasks();
    await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /不能误写/ }));
    await screen.findByLabelText("任务分类");
    put(life, "# 外部修改成普通笔记\n");
    fireEvent.change(screen.getByLabelText("任务分类"), { target: { value: life } });
    await screen.findByText(/目标文件不再是任务分类/);
    expect(notes.get(life)?.content).toBe("# 外部修改成普通笔记\n");
    expect(notes.get(work)?.content).toContain("不能误写");
  });

  it("完成任务并成功移动到另一分类，保留备注", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 可移动\n  - 备注：[需求](../../项目/需求.md)\n`);
    put(life, `${taskCategoryMarker}\n\n# 生活\n`);
    await openTasks();
    await openCategory("工作");
    fireEvent.click(await screen.findByLabelText("完成任务：可移动"));
    fireEvent.click(await screen.findByRole("button", { name: /可移动/ }));
    await screen.findByLabelText("Markdown 备注");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(parseTaskDocument(notes.get(work)!.content).tasks[0].completed).toBe(true));
    await waitFor(() => expect((screen.getByLabelText("任务分类") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("任务分类"), { target: { value: life } });
    await waitFor(() => expect(parseTaskDocument(notes.get(work)!.content).tasks).toHaveLength(0));
    expect(parseTaskDocument(notes.get(life)!.content).tasks[0]).toMatchObject({ title: "可移动", completed: true, remark: "[需求](../../项目/需求.md)" });
  });

  it("在全部任务中勾选后保留汇总视图并保存来源文件", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 全部视图任务\n`);
    await openTasks();
    fireEvent.click(await screen.findByLabelText("完成任务：全部视图任务"));
    expect(screen.getByRole("heading", { name: "全部任务" })).toBeTruthy();
    await waitFor(() => expect(parseTaskDocument(notes.get(work)!.content).tasks[0].completed).toBe(true), { timeout: 4000 });
  });

  it("切换分类前先保存未保存的 Markdown 备注", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 草稿任务\n`);
    put(life, `${taskCategoryMarker}\n\n# 生活\n`);
    await openTasks();
    await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /草稿任务/ }));
    fireEvent.change(await screen.findByLabelText("Markdown 备注"), { target: { value: "需要保留的 **备注**" } });
    await openCategory("生活");
    expect(notes.get(work)?.content).toContain("需要保留的 **备注**");
  });

  it("切换分类前遇到外部冲突时留在原分类并保留备注", async () => {
    folders.add("任务");
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 原任务\n`);
    put(life, `${taskCategoryMarker}\n\n# 生活\n`);
    await openTasks();
    await openCategory("工作");
    fireEvent.click(await screen.findByRole("button", { name: /原任务/ }));
    fireEvent.change(await screen.findByLabelText("Markdown 备注"), { target: { value: "有冲突的编辑" } });
    put(work, `${taskCategoryMarker}\n\n# 工作\n\n外部变更\n`);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: "生活" }));
    await screen.findByText(/保存失败：文件已被外部修改/);
    expect(screen.getByRole("heading", { name: "工作" })).toBeTruthy();
    expect((screen.getByLabelText("Markdown 备注") as HTMLTextAreaElement).value).toBe("有冲突的编辑");
    expect(notes.get(work)?.content).toContain("外部变更");
  });
});
