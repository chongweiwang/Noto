// @vitest-environment jsdom
import "../test/codemirror-dom";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { WorkspaceRuntimeContext, type WorkspaceRuntime } from "../lib/workspace-runtime";
import { WorkspaceError } from "../lib/api-error";
import { MemoryVault } from "../test/memory-vault";
import type { WorkspaceApi } from "../lib/vault-api";
import DesktopApp from "./desktop-app";
import Home from "../app/page";
import { appendTask, taskCategoryMarker } from "../lib/tasks";
import { dailyPath, localDate } from "../lib/calendar";

const native = vi.hoisted(() => ({ getCurrentWindow: vi.fn(() => { throw new Error("网页不应调用窗口接口"); }) }));
vi.mock("@tauri-apps/api/window", () => native);
vi.mock("../lib/mermaid", () => ({ renderMermaid: async () => "<svg />" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => window.localStorage.clear());
function setup(seed?: (vault: MemoryVault) => void, noteActivity?: WorkspaceApi["noteActivity"]) {
  const vault = new MemoryVault(); vault.put("a.md", "# 标题\n原文"); vault.put("b.md", "第二篇");
  seed?.(vault);
  const api: WorkspaceApi = { ...vault, entries: vault.entries, read: vault.read, save: vault.save, createNote: vault.createNote, createDirectory: vault.createDirectory, move: vault.move, drafts: vault.drafts, writeDraft: vault.writeDraft, removeDraft: vault.removeDraft,
    status: async () => ({ vault: "网页知识库", error: null }), noteActivity, selectVault: vi.fn(), createVault: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), importAttachment: vi.fn(), image: vi.fn(), remove: vi.fn(), openAttachment: vi.fn(), openExternal: vi.fn(), openItem: vi.fn(), trash: async () => [], restore: vi.fn() };
  const runtime: WorkspaceRuntime = { kind: "web", api, logout: vi.fn() };
  render(<WorkspaceRuntimeContext.Provider value={runtime}><DesktopApp /></WorkspaceRuntimeContext.Provider>);
  return { vault, api };
}
function view() { return EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!; }
function replace(content: string) { const editor = view(); act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content }, selection: { anchor: content.length }, userEvent: "input.type" })); }

describe("共享网页工作区", () => {
  it("手动检查挂载目录并分别显示读写结果", async () => {
    const { api } = setup();
    api.storageDiagnostics = vi.fn(async () => ({
      vault: { path: "/vault", read: "ok", write: "permissionDenied" },
      data: { path: "/data", read: "ok", write: "ok" },
    }) as const);
    await screen.findByRole("button", { name: "a.md" });
    fireEvent.click(screen.getByRole("button", { name: "软件设置" }));
    const settings = within(screen.getByRole("dialog", { name: "软件设置" }));
    fireEvent.click(settings.getByRole("button", { name: "存储与诊断" }));
    expect(api.storageDiagnostics).not.toHaveBeenCalled();
    fireEvent.click(settings.getByRole("button", { name: "检查读写权限" }));
    const vault = within(await settings.findByRole("region", { name: "知识库目录" }));
    expect(vault.getByText("/vault")).toBeTruthy();
    expect(vault.getByText("可读")).toBeTruthy();
    expect(vault.getByText("权限不足")).toBeTruthy();
    const data = within(settings.getByRole("region", { name: "服务数据目录" }));
    expect(data.getByText("/data")).toBeTruthy();
    expect(data.getByText("可写")).toBeTruthy();
  });

  it("全年笔记热力图消费活动记录，支持按日查看、键盘和独立开关", async () => {
    const now = new Date(), today = localDate(now), journal = dailyPath(today);
    const content = "文".repeat(105);
    const noteActivity = vi.fn(async (starts: number[]) => starts.slice(1).map((_, index) => (
      index === 364 ? { created: 1, edited: 1 } : index === 357 ? { created: 0, edited: 4 } : { created: 0, edited: 0 }
    )));
    setup(vault => {
      vault.put(journal, content);
      vault.put("项目/说明.md", "说明 #NAS #NAS/部署");
    }, noteActivity);
    fireEvent.click(await screen.findByRole("button", { name: "a.md" }));
    await screen.findByRole("tab", { name: "a.md", selected: true });
    const originalEditor = await waitFor(() => {
      const editor = view(); expect(editor).toBeTruthy(); return editor;
    });

    const widgets = within(screen.getByRole("group", { name: "小组件" }));
    fireEvent.click(widgets.getByRole("button", { name: "仪表盘" }));
    const dashboard = within(await screen.findByRole("dialog", { name: "仪表盘" }));
    await dashboard.findByRole("img", { name: /日记共 105 字/ });
    expect(dashboard.getByText("笔记").nextElementSibling?.textContent).toBe("4");
    expect(dashboard.getByText("标签").nextElementSibling?.textContent).toBe("2");
    fireEvent.click(dashboard.getByRole("button", { name: "30 天" }));
    expect(dashboard.getByRole("img").children).toHaveLength(30);
    fireEvent.change(dashboard.getByRole("combobox", { name: "统计目录" }), { target: { value: "项目" } });
    expect(dashboard.getByText("笔记").nextElementSibling?.textContent).toBe("1");
    await dashboard.findByText("这段时间没有可统计的日记内容");

    fireEvent.click(widgets.getByRole("button", { name: "笔记热力图" }));
    const drawer = await screen.findByRole("dialog", { name: "笔记热力图" });
    const heatmap = within(drawer);
    expect(screen.queryByRole("dialog", { name: "仪表盘" })).toBeNull();
    expect(within(heatmap.getByRole("group", { name: "按周排列的笔记热力图" })).getAllByRole("button")).toHaveLength(365);
    const date = await heatmap.findByRole("button", { name: today + "，2 篇笔记" });
    expect(date.dataset.heat).toBe("2");
    expect(heatmap.getByText("创建 1 篇 · 最近修改 1 篇")).toBeTruthy();
    expect(noteActivity.mock.calls[0][0]).toHaveLength(366);
    const lastWeek = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));
    fireEvent.keyDown(date, { key: "ArrowLeft" });
    const earlier = heatmap.getByRole("button", { name: lastWeek + "，4 篇笔记" });
    expect(document.activeElement).toBe(earlier);
    expect(earlier.getAttribute("aria-pressed")).toBe("true");
    expect(heatmap.getByText("创建 0 篇 · 最近修改 4 篇")).toBeTruthy();
    fireEvent.keyDown(earlier, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "笔记热力图" })).toBeNull();
    expect(view()).toBe(originalEditor);

    fireEvent.click(screen.getByRole("button", { name: "软件设置" }));
    const settings = within(screen.getByRole("dialog", { name: "软件设置" }));
    fireEvent.click(settings.getByRole("button", { name: "工作区" }));
    fireEvent.click(settings.getByRole("checkbox", { name: "显示笔记热力图" }));
    fireEvent.click(settings.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("button", { name: "笔记热力图" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "笔记热力图" })).toBeNull();
    expect(screen.getByRole("button", { name: "仪表盘" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "日历" })).toBeTruthy();
  });

  it("真实网页入口经 HTTP 和 IndexedDB 显示同一文件树分组及最新工具入口", async () => {
    const vault = new MemoryVault();
    vault.put("任务/默认/收件箱.md", taskCategoryMarker + "\n\n# 收件箱\n");
    vault.put("项目/任务/说明.md", "嵌套同名目录仍属于项目");
    vault.put("普通.md", "# 网页笔记\n");
    vault.put("日记/2026/11/2026-11-18.md", "# 日记\n");
    const identity = { serverId: crypto.randomUUID(), vaultId: "web-entry", vault: "网页知识库", csrf: "fixture-csrf" };
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const fetch = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/session") return json(identity);
      if (url.pathname === "/api/entries") return json(await vault.entries());
      if (url.pathname === "/api/note") return json(await vault.read(url.searchParams.get("path")!));
      if (url.pathname === "/api/snapshot") {
        const request = JSON.parse(String(options?.body));
        return json({ notes: request.notes.flatMap((item: { path: string }) => vault.notes.has(item.path) ? [vault.notes.get(item.path)] : []), unchanged: [], errors: [] });
      }
      throw new Error("未预期的网页请求：" + url.pathname);
    });
    vi.stubGlobal("fetch", fetch);
    render(<Home />);
    await screen.findByRole("button", { name: "普通.md" });
    const root = document.querySelector(".file-tree-root > .file-tree")!;
    const group = screen.getByRole("button", { name: "任务与日记" });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector('[data-tree-path="任务"]')).toBeNull();
    expect(root.querySelector('[data-tree-path="日记"]')).toBeNull();
    expect(root.querySelector('[data-tree-path="项目/任务"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "快速打开笔记" }));
    fireEvent.click(screen.getByRole("option", { name: /^2026-11-18\.md/ }));
    await screen.findByRole("tab", { name: "2026-11-18.md", selected: true });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByLabelText("文档更多操作"));
    fireEvent.click(screen.getByRole("button", { name: "在文件树中定位" }));
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector('[data-tree-path="任务/默认/收件箱.md"]')).toBeTruthy();
    expect(root.querySelector('[data-tree-path="日记/2026/11/2026-11-18.md"].selected')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "普通.md" }));
    await screen.findByRole("tab", { name: "普通.md" });
    expect(screen.getByLabelText("显示或隐藏侧栏")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "编辑视图" })).getAllByRole("button")).toHaveLength(4);
    expect(screen.queryByText("创建知识库")).toBeNull();
    fireEvent.click(screen.getByLabelText("文档更多操作"));
    expect(screen.getByRole("button", { name: "文件恢复" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("软件设置"));
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    expect(screen.getByRole("button", { name: "配置 WebDAV 同步" })).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url) === "/api/session")).toBe(true);
    expect(native.getCurrentWindow).not.toHaveBeenCalled();
  });
  it("复用文件、多标签、任务、大纲和统计，不出现桌面知识库选择入口", async () => {
    setup(); fireEvent.click(await screen.findByRole("button", { name: "a.md" }));
    await screen.findByRole("tab", { name: "a.md" });
    const first = view(); replace("第一篇未保存");
    fireEvent.click(screen.getByRole("button", { name: "b.md" })); await screen.findByRole("tab", { name: "b.md" });
    fireEvent.click(screen.getByRole("button", { name: "任务管理" }));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    fireEvent.click(screen.getByRole("tab", { name: /^a.md/ })); expect(view()).toBe(first); expect(view().state.doc.toString()).toBe("第一篇未保存");
    expect(screen.getByLabelText("笔记统计")).toBeTruthy(); expect(screen.queryByText("创建知识库")).toBeNull(); expect(screen.queryByRole("button", { name: "切换知识库" })).toBeNull();
    expect(native.getCurrentWindow).not.toHaveBeenCalled();
  });
  it("网络和认证失败保留草稿、编辑器与光标，重试成功接着保存后续输入", async () => {
    const { api, vault } = setup();
    let fail = true;
    api.save = vi.fn(async (path, content, version) => { if (fail) throw new WorkspaceError("network", "连接中断"); return vault.save(path, content, version); });
    fireEvent.click(await screen.findByRole("button", { name: "a.md" })); await screen.findByRole("tab", { name: "a.md" });
    replace("断线期间持续编辑"); const editor = view();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/本机草稿已保留，恢复连接或登录后会重试/);
    replace("断线期间持续编辑，然后继续");
    expect(view()).toBe(editor); expect(editor.state.selection.main.anchor).toBe(editor.state.doc.length);
    expect(screen.queryByRole("button", { name: "重新载入" })).toBeNull();
    fail = false; fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(vault.notes.get("a.md")?.content).toBe("断线期间持续编辑，然后继续"));
    expect(view()).toBe(editor);
  });
  it("浏览器存储失败会提示，离开页面时存在未保存内容则触发关闭提示", async () => {
    const { api } = setup(); api.writeDraft = vi.fn(async () => { throw new Error("存储空间不足"); });
    fireEvent.click(await screen.findByRole("button", { name: "a.md" })); await screen.findByRole("tab", { name: "a.md" });
    await waitFor(() => expect(view()).toBeTruthy());
    replace("待恢复内容");
    const event = new Event("beforeunload", { cancelable: true }); act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true); await screen.findByText(/草稿未能保存：存储空间不足/);
  });
  it("日期控件同时收到 input/change 时只更新一次，日期确实写入 Markdown", async () => {
    const { vault } = setup((vault) => vault.put("任务/工作/日期.md", appendTask(`${taskCategoryMarker}\n\n# 日期\n`, "日期任务").content));
    await screen.findByRole("button", { name: "a.md" });
    fireEvent.click(screen.getByRole("button", { name: "任务管理" }));
    fireEvent.click(await screen.findByRole("button", { name: /日期任务/ }));
    const start = await screen.findByLabelText("开始日期"), end = screen.getByLabelText("结束日期");
    fireEvent.input(start, { target: { value: "2026-11-13" } }); fireEvent.change(start, { target: { value: "2026-11-13" } });
    fireEvent.input(end, { target: { value: "2026-11-15" } }); fireEvent.change(end, { target: { value: "2026-11-15" } });
    await waitFor(() => expect(vault.notes.get("任务/工作/日期.md")?.content).toContain("开始日期：2026-11-13"), { timeout: 3000 });
    expect(vault.notes.get("任务/工作/日期.md")?.content).toContain("结束日期：2026-11-15");
    expect(screen.queryByText(/无法修改任务/)).toBeNull();
  });
});
