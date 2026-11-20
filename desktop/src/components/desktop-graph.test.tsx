// @vitest-environment jsdom
import "../test/codemirror-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import DesktopApp from "./desktop-app";
import { KnowledgeGraphView } from "./knowledge-graph-view";
import { MemoryVault } from "../test/memory-vault";
import { WorkspaceRuntimeContext } from "../lib/workspace-runtime";
import type { WorkspaceApi } from "../lib/vault-api";
import { defaultGraphSettings, emptyWorkspace, graphTabId, workspaceStorageKey } from "../lib/workspace-state";
import { getTheme } from "../lib/themes";
const drawing = { clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(), closePath: vi.fn(), arc: vi.fn(), fillText: vi.fn(), setTransform: vi.fn() };
vi.mock("../lib/mermaid", () => ({ renderMermaid: async () => "<svg />" }));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(drawing as unknown as CanvasRenderingContext2D); });
afterEach(() => { cleanup(); drawing.clearRect.mockReset(); drawing.arc.mockReset(); drawing.fill.mockReset(); drawing.fillText.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const vault = new MemoryVault();
  vault.put("a.md", "# 入口\n\n[[folder/b]] [[b]] [[缺失]]\n");
  vault.put("folder/b.md", "# 目标\n\n[[a]]\n");
  vault.put("folder2/b.md", "另一个同名文件");
  const api: WorkspaceApi = { ...vault, status: async () => ({ vault: "graph-vault", id: "graph-test", error: null }), read: vi.fn(vault.read), save: vi.fn(vault.save), writeDraft: vi.fn(vault.writeDraft), selectVault: vi.fn(), createVault: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), importAttachment: vi.fn(), importAttachmentData: vi.fn(), image: vi.fn(), remove: vi.fn(), openAttachment: vi.fn(), openExternal: vi.fn(), openItem: vi.fn() };
  const mount = () => render(<WorkspaceRuntimeContext.Provider value={{ kind: "web", api }}><DesktopApp /></WorkspaceRuntimeContext.Provider>);
  return { vault, api, mount, key: workspaceStorageKey("web", "graph-test") };
}
async function open(path = "a.md") {
  fireEvent.click(await screen.findByRole("button", { name: path }));
  await screen.findByRole("tab", { name: new RegExp("^" + path) , selected: true });
  return waitFor(() => EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector<HTMLElement>(".cm-editor")!)!);
}
async function showGraph() {
  fireEvent.click(await screen.findByRole("button", { name: "知识图谱" }));
  await screen.findByRole("heading", { name: "知识图谱" });
  await waitFor(() => expect(screen.queryByText(/正在刷新已保存笔记/)).toBeNull());
}
function nodeButton(path: string) { return within(screen.getByRole("complementary", { name: "图谱笔记列表" })).getByText(path).closest("button")!; }
function graphFrames() {
  let next = 0;
  const queued = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++next; queued.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
  return (limit = 200) => act(() => {
    for (let i = 0; i < limit && queued.size; i++) {
      const [id, callback] = queued.entries().next().value!;
      queued.delete(id); callback(i * 16);
    }
  });
}

it("切换图谱和节点复用标签，保留真实编辑器、光标、撤销和自动保存", async () => {
  const { vault, api, mount } = fixture(); mount();
  const editor = await open();
  act(() => editor.dispatch({ changes: { from: 0, insert: "连续输入" }, selection: { anchor: 4 }, userEvent: "input.type" }));
  await showGraph();
  fireEvent.click(screen.getByRole("button", { name: "进入图谱专注模式" }));
  expect(screen.getByRole("button", { name: "退出图谱专注模式" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.keyDown(screen.getByRole("searchbox", { name: "图谱搜索" }), { key: "Escape" });
  expect(screen.getByRole("button", { name: "进入图谱专注模式" })).toBeTruthy();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  fireEvent.click(nodeButton("folder/b.md")); await screen.findByRole("tab", { name: /^b.md/, selected: true });
  fireEvent.click(screen.getByRole("tab", { name: /^a.md/ }));
  await waitFor(() => expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector(".cm-editor")!)).toBe(editor));
  expect(editor.state.selection.main.anchor).toBe(4);
  expect(editor.state.doc.toString()).toContain("连续输入");
  act(() => { undo(editor); });
  expect(editor.state.doc.toString()).not.toContain("连续输入");
  act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\n最后输入" }, userEvent: "input.type" }));
  await showGraph(); fireEvent.click(nodeButton("a.md"));
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  await waitFor(() => expect(vault.notes.get("a.md")?.content).toContain("最后输入"), { timeout: 3500 });
  expect(api.read).not.toHaveBeenCalledWith(graphTabId);
  expect(api.save).not.toHaveBeenCalledWith(graphTabId, expect.anything(), expect.anything());
  expect(api.writeDraft).not.toHaveBeenCalledWith(expect.objectContaining({ path: graphTabId }));
});

it("关联面板显示入链出链与问题，同名候选由用户明确选择", async () => {
  const { mount } = fixture(); mount(); await open();
  fireEvent.click(screen.getByRole("button", { name: "反向链接" }));
  await screen.findByText("1 处引用");
  fireEvent.click(screen.getByRole("button", { name: "出链" }));
  await screen.findByText("3 处出链");
  expect(screen.getByText("目标不存在 · 第 3 行")).toBeTruthy();
  expect(screen.getByText("同名目标，请选择 · 第 3 行")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "folder2/b.md" }));
  await screen.findByRole("tab", { name: /^b.md/, selected: true });
});

it("局部范围与图谱筛选持久化，重开图谱工具标签不会读取虚构文件", async () => {
  const { mount, key, api } = fixture();
  let mounted = mount(); await open(); await showGraph();
  fireEvent.click(screen.getByRole("button", { name: "局部图谱" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "图谱搜索" }), { target: { value: "folder/b" } });
  act(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
  const saved = JSON.parse(localStorage.getItem(key)!);
  expect(saved).toMatchObject({ active: graphTabId, graph: { mode: "local", center: "a.md", query: "folder/b" } });
  mounted.unmount(); mounted = mount();
  await screen.findByRole("tab", { name: "知识图谱", selected: true });
  expect(screen.getByRole("searchbox", { name: "图谱搜索" }).getAttribute("value")).toBe("folder/b");
  expect(screen.getByRole("button", { name: "局部图谱" }).getAttribute("aria-pressed")).toBe("true");
  expect(api.read).not.toHaveBeenCalledWith(graphTabId);
  fireEvent.contextMenu(screen.getByRole("tab", { name: "知识图谱" }));
  expect(screen.queryByRole("menuitem", { name: "在文件树中定位" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "关闭标签" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "知识图谱" })).toBeNull());
});

it("关闭图谱不会等待或丢弃另一篇笔记的慢保存，新输入仍写回原文件", async () => {
  const { mount, api, vault } = fixture();
  let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
  api.save = vi.fn(async (path, content, version) => { await pending; return vault.save(path, content, version); });
  mount(); const editor = await open();
  act(() => editor.dispatch({ changes: { from: 0, insert: "第一段" }, userEvent: "input.type" }));
  await waitFor(() => expect(api.save).toHaveBeenCalled(), { timeout: 3500 });
  act(() => editor.dispatch({ changes: { from: 0, insert: "第二段" }, userEvent: "input.type" }));
  await showGraph(); fireEvent.click(screen.getByRole("button", { name: "关闭标签 知识图谱" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "知识图谱" })).toBeNull());
  expect(editor.state.doc.toString()).toContain("第二段第一段");
  await act(async () => { finish(); await pending; });
  await waitFor(() => expect(vault.notes.get("a.md")?.content).toContain("第二段第一段"), { timeout: 3500 });
});

it("原有恢复草稿可从图谱旁的笔记标签继续处理，图谱不删除草稿", async () => {
  const { mount, key, vault } = fixture();
  vault.stored.set("a.md", { path: "a.md", content: "保留的恢复草稿", baseVersion: vault.notes.get("a.md")!.version });
  localStorage.setItem(key, JSON.stringify({ ...emptyWorkspace(), tabs: ["a.md", graphTabId], active: graphTabId }));
  mount(); await screen.findByRole("tab", { name: "知识图谱", selected: true });
  fireEvent.click(screen.getByRole("button", { name: "进入图谱专注模式" }));
  fireEvent.click(screen.getByRole("button", { name: "退出图谱专注模式" }));
  expect(vault.stored.get("a.md")?.content).toBe("保留的恢复草稿");
  fireEvent.click(screen.getByRole("tab", { name: /^a.md/ }));
  await screen.findByText(/发现恢复草稿/);
  expect(vault.stored.get("a.md")?.content).toBe("保留的恢复草稿");
});

it("恢复图谱时不猜测当前笔记，打开笔记后再返回才标记当前笔记", async () => {
  const { mount, key } = fixture();
  localStorage.setItem(key, JSON.stringify({ ...emptyWorkspace(), tabs: ["a.md", "folder/b.md", graphTabId], active: graphTabId }));
  mount(); await screen.findByRole("tab", { name: "知识图谱", selected: true });
  expect(screen.getByLabelText("图谱图例").textContent).not.toContain("当前笔记");
  fireEvent.click(screen.getByRole("tab", { name: /^b.md/ }));
  fireEvent.click(screen.getByRole("tab", { name: "知识图谱" }));
  expect(screen.getByLabelText("图谱图例").textContent).toContain("当前笔记");
});

it("自动适配包含全部节点，等价刷新与手动缩放不重启布局", () => {
  const advance = graphFrames(), arcs: number[][] = [];
  drawing.clearRect.mockImplementation(() => { arcs.length = 0; });
  drawing.arc.mockImplementation((x: number, y: number, radius: number) => { arcs.push([x, y, radius]); });
  const graph = {
    nodes: Array.from({ length: 21 }, (_, i) => ({ id: `${i}.md`, label: `${i}`, connections: 2, unreadable: false })),
    edges: Array.from({ length: 20 }, (_, i) => ({ source: `${i}.md`, target: `${i + 1}.md`, forward: 1, reverse: 0 })),
  };
  const copy = () => ({ nodes: graph.nodes.map((node) => ({ ...node })), edges: graph.edges.map((edge) => ({ ...edge })) });
  const props = { graph, settings: defaultGraphSettings, onChange: vi.fn(), onOpen: vi.fn(), active: true, loading: false, errors: [], issues: [], theme: "dark" };
  const mounted = render(<KnowledgeGraphView {...props} />); advance();
  expect(arcs).toHaveLength(21);
  expect(arcs.every(([x, y, r]) => x - r >= 0 && y - r >= 0 && x + r <= 800 && y + r <= 500)).toBe(true);
  expect(arcs.every(([, y, r]) => y + r + 18 <= 420)).toBe(true);
  const stable = arcs.map((arc) => [...arc]), contexts = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length;
  mounted.rerender(<KnowledgeGraphView {...props} graph={copy()} />); advance();
  expect(arcs).toEqual(stable);
  expect(vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length).toBe(contexts);
  fireEvent.click(screen.getByRole("button", { name: "放大图谱" })); advance();
  const zoomed = arcs.map((arc) => [...arc]);
  expect(zoomed).not.toEqual(stable);
  mounted.rerender(<KnowledgeGraphView {...props} graph={copy()} />); advance();
  expect(arcs).toEqual(zoomed);
  const loadingGraph = { nodes: copy().nodes, edges: [] };
  mounted.rerender(<KnowledgeGraphView {...props} active={false} graph={loadingGraph} />);
  mounted.rerender(<KnowledgeGraphView {...props} graph={loadingGraph} loading />); advance();
  expect(arcs).toEqual(zoomed);
  mounted.rerender(<KnowledgeGraphView {...props} graph={copy()} />); advance();
  expect(arcs).toEqual(zoomed);
});

it("拖动节点时相邻节点跟随，其他指针不能中断手势", () => {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 0; }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  const advance = graphFrames(), arcs: number[][] = [];
  drawing.clearRect.mockImplementation(() => { arcs.length = 0; });
  drawing.arc.mockImplementation((x: number, y: number, radius: number) => { arcs.push([x, y, radius]); });
  const graph = { nodes: ["a", "b"].map((id) => ({ id, label: id, connections: 1, unreadable: false })), edges: [{ source: "a", target: "b", forward: 1, reverse: 0 }] };
  const onOpen = vi.fn();
  render(<KnowledgeGraphView graph={graph} settings={defaultGraphSettings} onChange={vi.fn()} onOpen={onOpen} active loading={false} errors={[]} issues={[]} theme="dark" />); advance();
  const canvas = screen.getByRole("img", { name: "知识图谱画布" }), [a, b] = arcs.map((arc) => [...arc]);
  fireEvent.pointerDown(canvas, { clientX: a[0], clientY: a[1], button: 0, pointerId: 1 });
  fireEvent.pointerDown(canvas, { clientX: b[0], clientY: b[1], button: 0, pointerId: 2 });
  fireEvent.pointerCancel(canvas, { pointerId: 2 });
  fireEvent.pointerMove(canvas, { clientX: a[0] + 70, clientY: a[1] + 30, pointerId: 1 }); advance(5);
  expect(Math.hypot(arcs[1][0] - b[0], arcs[1][1] - b[1])).toBeGreaterThan(.1);
  fireEvent.pointerUp(canvas, { clientX: a[0] + 70, clientY: a[1] + 30, pointerId: 1 });
  expect(onOpen).not.toHaveBeenCalled();
});

it("超出显示上限的笔记定位后，布局重新计算期间仍停在视口中心", () => {
  const advance = graphFrames(), positions: [number, number][] = [];
  drawing.fillText.mockImplementation((text: string, x: number, y: number) => { if (text === "note1000") positions.push([x, y]); });
  drawing.clearRect.mockImplementation(() => { drawing.arc.mockClear(); drawing.fill.mockClear(); drawing.beginPath.mockClear(); drawing.stroke.mockClear(); });
  const graph = { nodes: Array.from({ length: 1001 }, (_, i) => ({ id: `note${String(i).padStart(4, "0")}.md`, label: `note${String(i).padStart(4, "0")}`, connections: 0, unreadable: false })), edges: [] };
  render(<KnowledgeGraphView graph={graph} settings={{ ...defaultGraphSettings, query: "note1000" }} onChange={vi.fn()} onOpen={vi.fn()} active loading={false} errors={[]} issues={[]} theme="dark" />);
  advance(1);
  fireEvent.click(screen.getByRole("button", { name: "定位 note1000.md" }));
  advance(145);
  expect(positions.length).toBeGreaterThan(130);
  expect(positions.every(([x, y]) => Math.abs(x - positions[0][0]) < .01 && Math.abs(y - positions[0][1]) < .01)).toBe(true);
  expect(positions[0][0]).toBeCloseTo(400);
}, 30000);

it("全局图突出当前笔记，局部中心与当前笔记各自保持标记", () => {
  const advance = graphFrames(), fills: string[] = [];
  drawing.clearRect.mockImplementation(() => { fills.length = 0; });
  drawing.fill.mockImplementation(() => { fills.push(String((drawing as unknown as CanvasRenderingContext2D).fillStyle)); });
  const graph = { nodes: ["a.md", "b.md"].map((id) => ({ id, label: id, connections: 1, unreadable: false })), edges: [{ source: "a.md", target: "b.md", forward: 1, reverse: 0 }] };
  const props = { graph, settings: defaultGraphSettings, currentNote: "a.md", onChange: vi.fn(), onOpen: vi.fn(), active: true, loading: false, errors: [], issues: [], theme: "catppuccin-mocha" };
  const colors = getTheme(props.theme).colors, mounted = render(<KnowledgeGraphView {...props} />); advance();
  expect(fills.slice(-2)).toEqual([colors.surface, colors.accent]);
  mounted.rerender(<KnowledgeGraphView {...props} settings={{ ...defaultGraphSettings, mode: "local", center: "b.md" }} />); advance();
  expect(fills.slice(-2)).toEqual([colors.accent, colors.green]);
});

it("专注模式保留筛选和画布，列表可展开且退出时恢复原状态", async () => {
  const { mount } = fixture(); mount(); await open(); await showGraph();
  const canvas = screen.getByRole("img", { name: "知识图谱画布" }), search = screen.getByRole("searchbox", { name: "图谱搜索" });
  fireEvent.change(search, { target: { value: "folder/b" } });
  fireEvent.click(screen.getByRole("button", { name: "进入图谱专注模式" }));
  expect(canvas.closest(".graph-workspace")?.classList.contains("is-focused")).toBe(true);
  expect(screen.queryByRole("complementary", { name: "图谱笔记列表" })).toBeNull();
  expect((search as HTMLInputElement).value).toBe("folder/b");
  expect(screen.getByLabelText("图谱图例").textContent).toContain("当前笔记");
  fireEvent.click(screen.getByRole("button", { name: "展开图谱笔记列表" }));
  expect(nodeButton("folder/b.md")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起图谱笔记列表" }));
  fireEvent.click(screen.getByRole("button", { name: "退出图谱专注模式" }));
  expect(nodeButton("folder/b.md")).toBeTruthy();
  expect(screen.getByRole("img", { name: "知识图谱画布" })).toBe(canvas);
});

it("从专注图谱打开笔记后退出专注，返回图谱仍可使用原画布", async () => {
  const { mount } = fixture(); mount(); await open(); await showGraph();
  const canvas = screen.getByRole("img", { name: "知识图谱画布" });
  fireEvent.click(screen.getByRole("button", { name: "进入图谱专注模式" }));
  fireEvent.click(screen.getByRole("button", { name: "展开图谱笔记列表" }));
  fireEvent.click(nodeButton("folder/b.md"));
  await screen.findByRole("tab", { name: /^b.md/, selected: true });
  fireEvent.click(screen.getByRole("tab", { name: "知识图谱" }));
  expect(screen.getByRole("button", { name: "进入图谱专注模式" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "知识图谱画布" })).toBe(canvas);
});

it("图谱随外部内容与文件删除更新，不再显示旧关系或已删除的中心", async () => {
  const { mount, vault } = fixture(); mount(); await open(); await showGraph();
  fireEvent.click(screen.getByRole("button", { name: "局部图谱" }));
  expect(screen.getByText("folder/b.md")).toBeTruthy();
  vault.put("a.md", "外部改为无链接"); vault.notes.delete("folder/b.md");
  await waitFor(() => expect(within(screen.getByRole("complementary", { name: "图谱笔记列表" })).queryByText("folder/b.md")).toBeNull(), { timeout: 5000 });
  expect(screen.getByRole("tab", { name: "知识图谱", selected: true })).toBeTruthy();
});

it("鼠标拖动节点不打开笔记，单击才打开，图谱隐藏后停止帧调度", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const onOpen = vi.fn(), graph = { nodes: [{ id: "a.md", label: "a", connections: 0, unreadable: false }], edges: [] };
  const props = { graph, settings: defaultGraphSettings, onChange: vi.fn(), onOpen, active: true, loading: false, errors: [], issues: [], theme: "dark" };
  const mounted = render(<KnowledgeGraphView {...props} />);
  await waitFor(() => expect(drawing.arc).toHaveBeenCalled());
  const canvas = screen.getByRole("img", { name: "知识图谱画布" });
  const [x, y] = drawing.arc.mock.calls.at(-1)!;
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: x + 30, clientY: y + 20, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: x + 30, clientY: y + 20, pointerId: 1 });
  expect(onOpen).not.toHaveBeenCalled();
  await waitFor(() => expect(drawing.arc.mock.calls.at(-1)?.[0]).not.toBe(x));
  const [nextX, nextY] = drawing.arc.mock.calls.at(-1)!;
  fireEvent.pointerDown(canvas, { clientX: nextX, clientY: nextY, button: 0, pointerId: 2 });
  fireEvent.pointerUp(canvas, { clientX: nextX, clientY: nextY, button: 0, pointerId: 2 });
  expect(onOpen).toHaveBeenCalledWith("a.md");
  const schedule = vi.spyOn(window, "requestAnimationFrame");
  mounted.rerender(<KnowledgeGraphView {...props} active={false} />);
  schedule.mockClear();
  fireEvent.keyDown(canvas, { key: "+" });
  expect(schedule).not.toHaveBeenCalled();
});

it("主题切换重绘图谱颜色而不重新初始化画布",async()=>{
 const graph={nodes:[{id:"a.md",label:"a",connections:0,unreadable:false}],edges:[]},colors:string[]=[];
 drawing.stroke.mockImplementation(()=>{colors.push(String((drawing as unknown as CanvasRenderingContext2D).strokeStyle));});
 const props={graph,settings:defaultGraphSettings,onChange:vi.fn(),onOpen:vi.fn(),active:true,loading:false,errors:[],issues:[],theme:"catppuccin-mocha"};
 const mounted=render(<KnowledgeGraphView {...props}/>);await waitFor(()=>expect(colors).toContain("#89b4fa"));
 const canvas=screen.getByRole("img",{name:"知识图谱画布"}),count=vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length;
 mounted.rerender(<KnowledgeGraphView {...props} theme="nord"/>);
 await waitFor(()=>expect(colors).toContain("#88c0d0"));
 expect(screen.getByRole("img",{name:"知识图谱画布"})).toBe(canvas);expect(vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length).toBe(count);
 drawing.stroke.mockReset();
});

it("收起列表后搜索和画布保持可用，重新展开保留列表与画布", async () => {
 const { mount } = fixture(); mount(); await open(); await showGraph();
 const canvas = screen.getByRole("img", { name: "知识图谱画布" });
 const search = screen.getByRole("searchbox", { name: "图谱搜索" });
 fireEvent.change(search, { target: { value: "folder/b" } });
 expect(screen.getByText("folder/b.md")).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "收起图谱笔记列表" }));
 expect(screen.queryByRole("complementary", { name: "图谱笔记列表" })).toBeNull();
 expect(screen.getByRole("searchbox", { name: "图谱搜索" })).toBe(search);
 expect(screen.getByRole("img", { name: "知识图谱画布" })).toBe(canvas);
 fireEvent.click(screen.getByRole("button", { name: "展开图谱笔记列表" }));
 expect(screen.getByText("folder/b.md")).toBeTruthy();
 expect(screen.getByRole("img", { name: "知识图谱画布" })).toBe(canvas);
 expect((search as HTMLInputElement).value).toBe("folder/b");
});

it("小型图谱缩小后仍显示节点名称", async () => {
 const graph = { nodes: [{ id: "a.md", label: "笔记 a", connections: 0, unreadable: false }], edges: [] };
 render(<KnowledgeGraphView graph={graph} settings={defaultGraphSettings} onChange={vi.fn()} onOpen={vi.fn()} active loading={false} errors={[]} issues={[]} theme="dark" />);
 await waitFor(() => expect(drawing.fillText).toHaveBeenCalledWith("笔记 a", expect.any(Number), expect.any(Number)));
 drawing.fillText.mockClear();
 for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole("button", { name: "缩小图谱" }));
 await waitFor(() => expect(drawing.fillText).toHaveBeenCalledWith("笔记 a", expect.any(Number), expect.any(Number)));
});

it("图谱打开期间附件导入仍插入来源笔记，保留草稿并最终自动保存", async () => {
  const { mount, api, vault } = fixture();
  let finish!: (value: string) => void;
  api.importAttachmentData = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  mount(); const editor = await open();
  fireEvent.paste(editor.contentDOM, { clipboardData: { files: [new File([new Uint8Array([1,2,3])], "图.png", { type: "image/png" })] } });
  await waitFor(() => expect(api.importAttachmentData).toHaveBeenCalled());
  await showGraph();
  await act(async () => { finish("attachments/图.png"); });
  expect(screen.getByRole("tab", { name: "知识图谱", selected: true })).toBeTruthy();
  expect(editor.state.doc.toString()).toContain("attachments/%E5%9B%BE.png");
  await waitFor(() => expect(vault.notes.get("a.md")?.content).toContain("attachments/%E5%9B%BE.png"), { timeout: 3500 });
  expect(api.writeDraft).not.toHaveBeenCalledWith(expect.objectContaining({ path: graphTabId }));
});

it("改名更新图谱中心和恢复记录，固定的图谱标签仍保持独立", async () => {
  const { mount, key } = fixture(); mount(); await open(); await showGraph();
  fireEvent.click(screen.getByRole("button", { name: "局部图谱" }));
  fireEvent.contextMenu(screen.getByRole("tab", { name: "知识图谱" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "固定标签" }));
  const tree = screen.getByRole("complementary", { name: "工作区侧栏" });
  fireEvent.keyDown(within(tree).getByRole("button", { name: "a.md" }), { key: "F2" });
  const input = await screen.findByRole("textbox", { name: "重命名 a.md" });
  fireEvent.change(input, { target: { value: "更名.md" } }); fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(within(screen.getByRole("complementary", { name: "图谱笔记列表" })).getByText("更名.md")).toBeTruthy());
  act(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ active: graphTabId, pinned: [graphTabId], graph: { center: "更名.md", mode: "local" } });
});

it("删除与工具标签同名的普通目录不会取消图谱固定或关闭工具标签", async () => {
  const { mount, vault, api, key } = fixture();
  vault.put("@graph/测试.md", "# 普通笔记");
  api.remove = vi.fn(async () => { vault.notes.delete("@graph/测试.md"); });
  mount(); await open(); await showGraph();
  fireEvent.contextMenu(screen.getByRole("tab", { name: "知识图谱" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "固定标签" }));
  const tree = screen.getByRole("complementary", { name: "工作区侧栏" });
  fireEvent.contextMenu(within(tree).getByText("@graph"));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith("@graph"));
  await waitFor(() => expect(within(tree).queryByText("@graph")).toBeNull());
  act(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ active: graphTabId, pinned: [graphTabId] });
  expect(screen.getByRole("tab", { name: /^已固定\s*知识图谱$/, selected: true })).toBeTruthy();
});

it("批量快照失败明确提示不完整，保留已知文件节点和当前编辑", async () => {
  const { mount, api } = fixture();
  api.snapshot = async () => ({ notes: [], errors: [{ path: "知识库", error: "测试网络中断" }] });
  mount(); const editor = await open(); await showGraph();
  expect(screen.getByText("关联数据不完整：1 项读取失败")).toBeTruthy();
  fireEvent.click(nodeButton("a.md"));
  expect(EditorView.findFromDOM(screen.getByRole("tabpanel").querySelector(".cm-editor")!)).toBe(editor);
});
