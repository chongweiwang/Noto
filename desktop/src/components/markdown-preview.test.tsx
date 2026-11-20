// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MarkdownPreview } from "./markdown-preview";
import { manualCopyEvent } from "../lib/ui-actions";
import { useState } from "react";

const api = vi.hoisted(() => ({ image: vi.fn(), read: vi.fn(), openAttachment: vi.fn(), openExternal: vi.fn() }));
const renderDiagram = vi.hoisted(() => vi.fn(async (_source: string) => '<svg xmlns="http://www.w3.org/2000/svg"><text>示意图</text></svg>'));
vi.mock("../lib/desktop-api", () => ({ desktop: api }));
vi.mock("../lib/mermaid", () => ({ renderMermaid: renderDiagram }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("阅读视图右键复制选中的正文", () => {
  const copy = vi.fn();
  render(<MarkdownPreview note="笔记.md" content="选中的正文" onError={vi.fn()} />);
  const paragraph = screen.getByText("选中的正文");
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection()!;
  selection.addRange(range);
  window.addEventListener(manualCopyEvent, copy);
  try {
    fireEvent.contextMenu(paragraph);
    fireEvent.click(screen.getByRole("menuitem", { name: /^复制$/ }));
    expect(copy.mock.calls[0][0].detail).toBe("选中的正文");
  } finally {
    selection.removeAllRanges();
    window.removeEventListener(manualCopyEvent, copy);
  }
});

it("阅读中旧标记作为普通文本显示",()=>{
 const source="正常段落 ^old\n\n^standalone";
 const {container}=render(<MarkdownPreview note="笔记.md" content={source} onError={()=>{}}/>);
 expect(container.textContent).toContain("正常段落 ^old");
 expect(container.textContent).toContain("^standalone");
});

it("嵌入使用目标已保存内容、只读任务框和隔离标题，点击来源复用 Wiki 导航",async()=>{
  api.read.mockResolvedValue({path:"目录/目标.md",version:"v1",content:"# 章节\n\n- [ ] 待办\n\n![图](图.png)\n\n![[嵌套]]\n\n# 后续\n不包含"});
  api.image.mockResolvedValue("data:image/png;base64,AA==");
  const open=vi.fn();
  const {container}=render(<MarkdownPreview note="宿主.md" content={'# 章节\n\n![[目录/目标.md#章节|引用]]'} wikiPaths={["宿主.md","目录/目标.md"]} onWikiOpen={open} onError={()=>{}}/>);
  const group=await screen.findByRole("group",{name:"嵌入：引用"});
  expect(group.textContent).toContain("待办");expect(group.textContent).not.toContain("不包含");
  expect(group.textContent).toContain("嵌套嵌入未展开");
  expect(group.querySelector("input")?.disabled).toBe(true);
  await waitFor(()=>expect(api.image).toHaveBeenCalledWith("目录/目标.md","图.png"));
  const ids=[...container.querySelectorAll("h1")].map(node=>node.id);expect(new Set(ids).size).toBe(ids.length);
  expect(group.querySelector("h1")?.hasAttribute("data-heading-from")).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"引用 ↗"}));expect(open).toHaveBeenCalledWith("目录/目标.md#章节","宿主.md","目录/目标.md");
});
it("嵌入目标变化时丢弃迟到读取，不展示旧目标内容",async()=>{
  let first!:(value:{path:string;version:string;content:string})=>void;
  api.read.mockImplementation((path:string)=>path==="一.md"?new Promise(resolve=>{first=resolve;}):Promise.resolve({path,version:"2",content:"新目标正文"}));
  const props={note:"宿主.md",wikiPaths:["宿主.md","一.md","二.md"],onError:()=>{}};
  const {rerender}=render(<MarkdownPreview {...props} content="![[一]]"/>);
  await waitFor(()=>expect(api.read).toHaveBeenCalledWith("一.md"));
  rerender(<MarkdownPreview {...props} content="![[二]]"/>);
  await act(async()=>{first({path:"一.md",version:"1",content:"过时正文"});});
  await screen.findByText("新目标正文");expect(screen.queryByText("过时正文")).toBeNull();
});
it("嵌入读取失败后可明确重试",async()=>{
  api.read.mockRejectedValueOnce(new Error("网络失败")).mockResolvedValueOnce({path:"目标.md",version:"v1",content:"重试成功"});
  render(<MarkdownPreview note="宿主.md" content="![[目标]]" wikiPaths={["宿主.md","目标.md"]} onError={()=>{}}/>);
  fireEvent.click(await screen.findByRole("button",{name:"重试读取"}));
  await screen.findByText("重试成功");expect(api.read).toHaveBeenCalledTimes(2);
});

it("阅读标题与导出使用相同的不重复锚点，并避开脚注保留 ID", () => {
  const content="# 重复\n\n# 重复\n\n# 重复-1\n\n# 重复\n\n# !!!\n\n# section\n\n# footnote-label\n\n脚注[^a]\n\n[^a]: 说明";
  const {container}=render(<MarkdownPreview note="笔记.md" content={content} onError={()=>{}}/>);
  expect([...container.querySelectorAll("h1")].map(node=>node.id)).toEqual(["重复","重复-1","重复-1-1","重复-2","section","section-1","footnote-label-1"]);
  const ids=[...container.querySelectorAll("[id]")].map(node=>node.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(container.querySelector("h1")?.getAttribute("data-heading-from")).toBe("0");
});

it("按笔记目录解析嵌套图片和附件链接", async () => {
  api.image.mockResolvedValue("data:image/png;base64,AA==");
  api.openAttachment.mockResolvedValue(undefined);
  render(<MarkdownPreview note="目录/笔记.md" content={'![图](../附件/图片%20%281%29.png)\n\n[文件](附件/文件%20一.pdf)'} onError={() => {}} />);
  const image = await screen.findByRole("img", { name: "图" });
  expect(image.getAttribute("src")).toBe("data:image/png;base64,AA==");
  expect(api.image).toHaveBeenCalledWith("目录/笔记.md", "../附件/图片 (1).png");
  fireEvent.click(screen.getByRole("link", { name: "文件" }));
  await waitFor(() => expect(api.openAttachment).toHaveBeenCalledWith("目录/笔记.md", "附件/文件 一.pdf"));
});

it("阅读视图呈现常用 Markdown 和 GFM 内容", () => {
  const content = [
    "# 标题", "正文 **加粗** 和 *斜体*，以及 ~~删除线~~。", "> 引用",
    "- [x] 已完成", "- [ ] 未完成", "", "| 名称 | 数量 |", "| --- | --- |", "| 样例 | 1 |",
    "", "```js", "const value = 1;", "```", "", "脚注[^1]", "", "[^1]: 补充说明",
  ].join("\n");
  const { container } = render(<MarkdownPreview note="笔记.md" content={content} onError={() => {}} />);
  expect(screen.getByRole("heading", { level: 1, name: "标题" })).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("加粗");
  expect(container.querySelector("em")?.textContent).toBe("斜体");
  expect(container.querySelector("del")?.textContent).toBe("删除线");
  expect(container.querySelector("blockquote")?.textContent).toContain("引用");
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  expect(screen.getByRole("table").textContent).toContain("样例");
  expect(container.querySelector("pre code")?.textContent).toContain("const value = 1;");
  expect(container.textContent).toContain("补充说明");
  const footnote = container.querySelector('a[href^="#user-content-fn-"]');
  expect(footnote).toBeTruthy();
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  expect(footnote?.dispatchEvent(click)).toBe(false);
});

it("公式渲染与代码、转义的美元符号互不干扰", () => {
  const content = ["行内 $x^2$ 和 \\$100。", "", "$$", "x^2 + y^2", "$$", "", "$$z^2$$", "", "`$code$`", "", "```text", "$notmath$", "```", "", "$\\unknowncommand$"].join("\n");
  const { container } = render(<MarkdownPreview note="笔记.md" content={content} onError={() => {}} />);
  expect(container.querySelectorAll(".katex-display")).toHaveLength(2);
  expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(3);
  expect(container.querySelector(".katex-error")?.textContent).toContain("\\unknowncommand");
  expect(container.querySelector("code")?.textContent).toBe("$code$");
  expect(container.querySelector("pre code")?.textContent).toContain("$notmath$");
  expect(container.textContent).toContain("$100");
});

it("相对 Markdown 链接打开知识库内笔记，拒绝越界", () => {
  const open = vi.fn(), error = vi.fn();
  render(<MarkdownPreview note="目录/笔记.md" content={'[笔记](../另一篇.md#章节) [越界](../../secret.md)'} onError={error} onOpenNote={open} />);
  fireEvent.click(screen.getByRole("link", { name: "笔记" }));
  expect(open).toHaveBeenCalledWith("另一篇.md", "章节");
  fireEvent.click(screen.getByRole("link", { name: "越界" }));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("超出知识库"));
});

it("任务备注中的本文件锚点指向分类文件", () => {
  const open = vi.fn();
  render(<MarkdownPreview note="任务/工作.md" content="[章节](#计划)" onError={() => {}} onOpenNote={open} anchorsInSource />);
  fireEvent.click(screen.getByRole("link", { name: "章节" }));
  expect(open).toHaveBeenCalledWith("任务/工作.md", "计划");
});

it("保存状态刷新不重建标题内的链接或重新读取图片，链接使用最新回调", async () => {
  api.image.mockResolvedValue("data:image/png;base64,AA==");
  const before = vi.fn(), after = vi.fn();
  const content = "# [笔记](../目标.md)\n\n![图](图.png)";
  const view = render(<MarkdownPreview note="目录/源.md" content={content} onError={() => {}} onOpenNote={before} />);
  const link = screen.getByRole("link", { name: "笔记" });
  await screen.findByRole("img", { name: "图" });
  link.focus();
  view.rerender(<MarkdownPreview note="目录/源.md" content={content} onError={() => {}} onOpenNote={after} />);
  expect(screen.getByRole("link", { name: "笔记" })).toBe(link);
  expect(document.activeElement).toBe(link);
  expect(api.image).toHaveBeenCalledTimes(1);
  fireEvent.click(link);
  expect(after).toHaveBeenCalledWith("目标.md", undefined);
  expect(before).not.toHaveBeenCalled();
});

it("多篇预览含有相同标题时，锚点只滚动所属笔记", () => {
  render(<><MarkdownPreview note="第一篇.md" content={"## 相同标题\n\n[跳转](#相同标题)"} onError={() => {}} /><MarkdownPreview note="第二篇.md" content={"## 相同标题\n\n[跳转](#相同标题)"} onError={() => {}} /></>);
  const headings = screen.getAllByRole("heading", { name: "相同标题" });
  const first = vi.fn(), second = vi.fn();
  headings[0].scrollIntoView = first; headings[1].scrollIntoView = second;
  fireEvent.click(screen.getAllByRole("link", { name: "跳转" })[1]);
  expect(second).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
});

it("任务备注的脚注留在当前预览中", () => {
  const open = vi.fn();
  const { container } = render(<MarkdownPreview note="任务/工作.md" content={'正文[^1]\n\n[^1]: 补充说明'} onError={() => {}} onOpenNote={open} anchorsInSource />);
  const footnote = container.querySelector('a[href^="#user-content-fn-"]');
  expect(footnote).toBeTruthy();
  fireEvent.click(footnote!);
  expect(open).not.toHaveBeenCalled();
});

it("备注任务框可直接勾选，嵌套和有序任务只修改对应状态", () => {
  const source = "- [ ] 重复步骤\n  - [ ] 内层步骤\n- [ ] 重复步骤\n\n1. [x] 有序步骤\n\n```md\n- [ ] 示例\n```\n\n\\- [ ] 转义示例";
  const changed = vi.fn();
  function Remark() {
    const [content, setContent] = useState(source);
    return <MarkdownPreview note="任务/工作.md" content={content} onError={() => {}} onCheckboxChange={(next) => { changed(next); setContent(next); }} />;
  }
  render(<Remark />);
  expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  const second = screen.getAllByRole("checkbox", { name: "备注任务：重复步骤" })[1] as HTMLInputElement;
  second.focus();
  fireEvent.click(second);
  expect(screen.getAllByRole("checkbox", { name: "备注任务：重复步骤" })[1]).toBe(second);
  expect(document.activeElement).toBe(second);
  expect(changed).toHaveBeenLastCalledWith(source.replace("- [ ] 内层步骤\n- [ ] 重复步骤", "- [ ] 内层步骤\n- [x] 重复步骤"));
  fireEvent.click(screen.getByRole("checkbox", { name: "备注任务：有序步骤" }));
  expect(changed.mock.lastCall?.[0]).toContain("1. [ ] 有序步骤");
  expect(changed.mock.lastCall?.[0]).toContain("- [ ] 示例");
});

it("未提供修改回调或发生冲突时预览任务框保持只读", () => {
  const change = vi.fn();
  const view = render(<MarkdownPreview note="任务/工作.md" content="- [ ] 第一步" onError={() => {}} onCheckboxChange={change} checkboxesDisabled />);
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(change).not.toHaveBeenCalled();
  view.rerender(<MarkdownPreview note="任务/工作.md" content="- [ ] 第一步" onError={() => {}} />);
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
});

it("图表保留在阅读视图中，其他文字更新时不重复渲染", async () => {
  const diagram = "```mermaid\ngraph TD\nA-->B\n```";
  const onError = vi.fn();
  const view = render(<MarkdownPreview note="笔记.md" content={`正文\n\n${diagram}`} onError={onError} />);
  expect(await screen.findByLabelText("Mermaid 图表")).toBeTruthy();
  expect(renderDiagram).toHaveBeenCalledTimes(1);
  view.rerender(<MarkdownPreview note="笔记.md" content={`正文变更\n\n${diagram}`} onError={onError} />);
  expect(screen.getByLabelText("Mermaid 图表")).toBeTruthy();
  expect(renderDiagram).toHaveBeenCalledTimes(1);
});

it("无效图表显示错误和原始源码", async () => {
  renderDiagram.mockRejectedValueOnce(new Error("图表语法错误"));
  render(<MarkdownPreview note="笔记.md" content={'```mermaid\ninvalid diagram\n```'} onError={() => {}} />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("图表语法错误");
  expect(alert.textContent).toContain("invalid diagram");
});

it("阅读视图只渲染真实 Wiki 链接并通过统一回调打开", () => {
  const onWikiOpen = vi.fn();
  const { container } = render(<MarkdownPreview note="源.md" content={'[[项目/目标|别名]] 和 \\[[转义]] 与 `[[代码]]`'} wikiPaths={["项目/目标.md"]} onWikiOpen={onWikiOpen} onError={() => {}} />);
  const link = screen.getByRole("link", { name: "别名" });
  expect(link.classList.contains("wiki-unresolved")).toBe(false);
  fireEvent.click(link);
  expect(onWikiOpen).toHaveBeenCalledWith("项目/目标","源.md");
  expect(container.querySelectorAll(".wiki-link")).toHaveLength(1);
  expect(container.textContent).toContain("[[转义]]");
  expect(container.textContent).toContain("[[代码]]");
});
