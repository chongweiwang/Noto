// @vitest-environment jsdom
import "../test/codemirror-dom";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { acceptCompletion, startCompletion } from "@codemirror/autocomplete";
import { MarkdownEditor } from "./markdown-editor";
import { manualCopyEvent } from "../lib/ui-actions";

vi.mock("../lib/mermaid", () => ({ renderMermaid: async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>图表</text></svg>' }));
afterEach(cleanup);

it("右键复制选中的原文并保留选区", () => {
  const { container, view, onChange } = mount("第一段\n\n第二段");
  const copy = vi.fn();
  window.addEventListener(manualCopyEvent, copy);
  try {
    act(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }));
    fireEvent.contextMenu(container.querySelector(".cm-content")!, { clientX: 12, clientY: 12 });
    expect(screen.getByRole("menuitem", { name: "剪切" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "粘贴" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /^复制$/ }));
    expect(copy.mock.calls[0][0].detail).toBe("第一段\n\n第二段");
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(manualCopyEvent, copy);
  }
});

it("右键剪切成功后删除选区，粘贴替换选区，剪贴板被拒时保留原文", async () => {
  const clip = { writeText: vi.fn(async (_text: string) => {}), readText: vi.fn(async () => "新文字") };
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clip });
  try {
    const { container, view } = mount("第一段\n\n第二段");
    const context = () => fireEvent.contextMenu(container.querySelector(".cm-content")!, { clientX: 30, clientY: 24 });
    act(() => view.dispatch({ selection: { anchor: 0, head: 3 } }));
    context();
    clip.writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "剪切" })); });
    expect(view.state.doc.toString()).toBe("第一段\n\n第二段");
    context();
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "剪切" })); });
    expect(clip.writeText).toHaveBeenLastCalledWith("第一段");
    expect(view.state.doc.toString()).toBe("\n\n第二段");
    act(() => view.dispatch({ selection: { anchor: 2, head: 5 } }));
    context();
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "粘贴" })); });
    expect(view.state.doc.toString()).toBe("\n\n新文字");
  } finally {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("切换到另一栏后，迟到的自动聚焦不会抢回旧笔记", async () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  try {
    let current = true;
    const props = { value: "原文", notePath: "测试.md", disabled: false, live: true, onChange: vi.fn(), onSave: vi.fn(), onSaveAs: vi.fn(), onImport: vi.fn(), isFocusCurrent: () => current };
    const mounted = render(<MarkdownEditor {...props} active focused />);
    const content = mounted.container.querySelector<HTMLElement>(".cm-content")!;
    current = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.activeElement).not.toBe(content);
    mounted.rerender(<MarkdownEditor {...props} active focused={false} />);
    current = true; mounted.rerender(<MarkdownEditor {...props} active focused />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.activeElement).toBe(content);
  } finally { vi.useRealTimers(); }
});

it("实时编辑按原文显示旧标记，右键只提供剪贴和全选",()=>{
  const source="开头\n\n带标记 ^one";
  const {container,view,onChange}=mount(source);
  const line=container.querySelectorAll(".cm-content .cm-line")[2];
  expect(line.textContent).toBe("带标记 ^one");
  fireEvent.contextMenu(line,{button:2,clientX:80,clientY:40});
  expect(screen.getAllByRole("menuitem").map(item=>item.textContent)).toEqual(["剪切","复制","粘贴","全选"]);
  expect(view.state.doc.toString()).toBe(source);
  expect(onChange).not.toHaveBeenCalled();
});

it("中文输入法组合期间格式快捷键不修改未提交文本", () => {
  const { container, view, onChange } = mount("中文输入");
  const content = container.querySelector(".cm-content")!;
  fireEvent.compositionStart(content);
  expect(view.compositionStarted).toBe(true);
  fireEvent.keyDown(content, { key: "b", code: "KeyB", ctrlKey: true, isComposing: true, keyCode: 229 });
  fireEvent.keyDown(content, { key: "i", code: "KeyI", ctrlKey: true, isComposing: true, keyCode: 229 });
  expect(view.state.doc.toString()).toBe("中文输入"); expect(onChange).not.toHaveBeenCalled();
  fireEvent.compositionEnd(content);
});

function mount(value: string, wikiPaths: string[] = [], onWikiOpen?: (target: string) => void) {
  const onChange = vi.fn();
  const result = render(<MarkdownEditor value={value} notePath="测试.md" disabled={false} live wikiPaths={wikiPaths} onWikiOpen={onWikiOpen} onChange={onChange} onSave={() => {}} onSaveAs={() => {}} onImport={() => {}} />);
  const dom = result.container.querySelector<HTMLElement>(".cm-editor")!;
  const view = EditorView.findFromDOM(dom)!;
  return { ...result, view, onChange };
}

it("实时公式和图表可点击回到源码，且不会修改文档", async () => {
  const source = "开头\n\n$x^2$\n\n$$\na+b\n$$\n\n```mermaid\ngraph TD\nA-->B\n```\n";
  const { container, view, onChange } = mount(source);
  await waitFor(() => expect(container.querySelector(".mermaid-diagram svg")).toBeTruthy());
  expect(container.querySelector(".katex-display")).toBeTruthy();
  const math = container.querySelector<HTMLElement>(".katex-display")!;
  fireEvent.mouseDown(math);
  expect(view.state.selection.main.from).toBe(source.indexOf("$$"));
  expect(view.state.doc.toString()).toBe(source);
  expect(onChange).not.toHaveBeenCalled();
});

it("实时视图中可点击 Wiki 链接并保留源码", () => {
  const open = vi.fn();
  const source = "光标\n\n[[目录/目标|别名]] 和 `[[代码]]`";
  const { container, view } = mount(source, ["目录/目标.md"], open);
  const link = container.querySelector<HTMLElement>(".wiki-link")!;
  expect(link.textContent).toBe("别名");
  fireEvent.click(link);
  expect(open).toHaveBeenCalledWith("目录/目标","测试.md");
  expect(view.state.doc.toString()).toBe(source);
  expect(container.querySelectorAll(".wiki-link")).toHaveLength(1);
});

it("光标位于源码链接内时可用 Ctrl+Enter 打开", () => {
  const open = vi.fn();
  const { container, view } = mount("[[目标]]", ["目标.md"], open);
  act(() => view.dispatch({ selection: { anchor: 3 } }));
  fireEvent.keyDown(container.querySelector(".cm-content")!, { key: "Enter", code: "Enter", ctrlKey: true });
  expect(open).toHaveBeenCalledWith("目标","测试.md");
  expect(view.state.doc.toString()).toBe("[[目标]]");
});

it("输入 Wiki 链接时提供路径补全且不会重复插入右括号", async () => {
  const { container, view } = mount("[[]]", ["目录/目标.md"]);
  act(() => { view.dispatch({ selection: { anchor: 2 } }); view.focus(); startCompletion(view); });
  await waitFor(() => expect(container.querySelector(".cm-tooltip-autocomplete")?.textContent).toContain("目录/目标"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  act(() => { acceptCompletion(view); });
  expect(view.state.doc.toString()).toBe("[[目录/目标]]");
});

it("键入两个左括号后自动显示 Wiki 候选", async () => {
  const { container, view } = mount("", ["目录/目标.md"]);
  act(() => { view.focus(); view.dispatch({ changes: { from: 0, insert: "[[" }, selection: { anchor: 2 }, userEvent: "input.type" }); });
  await waitFor(() => expect(container.querySelector(".cm-tooltip-autocomplete")?.textContent).toContain("目录/目标"));
});

it("图标工具栏插入链接保留原编辑器选区并支持撤销", () => {
  const { view } = mount("文字");
  act(() => view.dispatch({ selection: { anchor: 0, head: 2 } }));
  const button = screen.getByRole("button", { name: "插入链接" });
  expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(fireEvent.mouseDown(button)).toBe(false);
  fireEvent.click(button);
  expect(view.state.doc.toString()).toBe("[文字](https://)");
  act(() => { undo(view); });
  expect(view.state.doc.toString()).toBe("文字");
});

it("工具栏切换粗体并保留选区，支持撤销和列表回车", () => {
  const { container, view } = mount("文字");
  act(() => view.dispatch({ selection: { anchor: 0, head: 2 } }));
  fireEvent.click(screen.getByRole("button", { name: "粗体" }));
  expect(view.state.doc.toString()).toBe("**文字**");
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("文字");
  fireEvent.click(screen.getByRole("button", { name: "粗体" }));
  expect(view.state.doc.toString()).toBe("文字");
  act(() => { undo(view); });
  expect(view.state.doc.toString()).toBe("**文字**");
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "- 项目" }, selection: { anchor: 4 } }));
  fireEvent.keyDown(container.querySelector(".cm-content")!, { key: "Enter", code: "Enter" });
  expect(view.state.doc.toString()).toBe("- 项目\n- ");
});

it("标题和引用对完整行操作，并可再次点击取消", () => {
  const { view } = mount("第一行\n第二行");
  act(() => view.dispatch({ selection: { anchor: 1, head: 7 } }));
  fireEvent.click(screen.getByRole("button", { name: "引用" }));
  expect(view.state.doc.toString()).toBe("> 第一行\n> 第二行");
  fireEvent.click(screen.getByRole("button", { name: "引用" }));
  expect(view.state.doc.toString()).toBe("第一行\n第二行");
});

it("实时视图显示下划线强调、链接，保留转义和代码中的标记", () => {
  const { container } = mount("光标\n\n__粗体__ _斜体_ [链接](note.md) \\**原文** `**代码**`");
  expect(container.querySelector(".md-bold strong")?.textContent).toBe("粗体");
  expect(container.querySelector(".md-italic em")?.textContent).toBe("斜体");
  expect(container.querySelector(".md-link")?.textContent).toBe("链接");
  expect(container.querySelector(".md-inline-code code")?.textContent).toBe("**代码**");
  expect(container.querySelectorAll(".md-bold strong")).toHaveLength(1);
});
