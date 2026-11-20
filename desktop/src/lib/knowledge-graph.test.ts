import { expect, it } from "vitest";
import { KnowledgeIndex } from "./knowledge";
import { buildGraph, filterGraph, graphDisplayLimit } from "./knowledge-graph";
import { defaultGraphSettings, normalizeWorkspace, emptyWorkspace, graphTabId } from "./workspace-state";
const note = (path: string, content: string, version = "v1") => ({ path, content, version });

it("关联统一解析别名、同名、编码的标准链接和诊断，排除附件及伪链接", () => {
  const paths = ["入口.md", "甲/同名.md", "乙/同名.md", "资料/空 格.md"];
  const tick = String.fromCharCode(96);
  const source = [
    "[[甲/同名|别名]] [[同名]] [[缺失]] [[../越界]]",
    "[文档](资料/空%20格.md#标题) [缺失](消失.md) [越界](../坏.md)",
    "![图](不存在.png) [附件](资料.pdf) [目录](folder/) [站点](https://a.test/b.md) [锚点](#h)",
    tick + "[[代码]]" + tick + " $[[公式]]$",
    tick.repeat(3) + "md\n[[围栏]]\n" + tick.repeat(3),
    "\\[[转义]] ![[嵌入]]",
    "<div>\n[[HTML]]\n</div>",
  ].join("\n");
  const index = new KnowledgeIndex().build(paths, [note("入口.md", source)]);
  expect(index.references.map((link) => [link.raw, link.status, link.target])).toEqual([
    ["甲/同名", "resolved", "甲/同名.md"], ["同名", "ambiguous", null], ["缺失", "missing", null], ["../越界", "invalid", null],
    ["资料/空%20格.md#标题", "resolved", "资料/空 格.md"], ["消失.md", "missing", null], ["../坏.md", "invalid", null], ["嵌入", "missing", null],
  ]);
  expect(index.references[1].candidates).toEqual(["乙/同名.md", "甲/同名.md"].sort((a,b) => a.localeCompare(b)));
  expect(index.references[4]).toMatchObject({ line: 2, source: "入口.md", kind: "markdown" });
});

it("图谱聚合重复/双向关系，保留同名独立节点和不可读状态，自环不入图", () => {
  const paths = ["入口.md", "甲/同名.md", "乙/同名.md", "不可读.md", "孤立.md"];
  const index = new KnowledgeIndex().build(paths, [
    note("入口.md", "[[甲/同名]] [[甲/同名]] [[入口]] [[同名]] [[不可读]]"),
    note("甲/同名.md", "[回去](../入口.md)"), note("乙/同名.md", ""), note("孤立.md", ""),
  ]);
  const graph = buildGraph(index);
  expect(graph.nodes).toHaveLength(5);
  expect(graph.edges).toHaveLength(2);
  const edge = graph.edges.find((edge) => [edge.source, edge.target].includes("甲/同名.md"))!;
  expect(edge.forward + edge.reverse).toBe(3); expect(edge.forward).toBeGreaterThan(0); expect(edge.reverse).toBeGreaterThan(0);
  expect(graph.nodes.find((node) => node.id === "入口.md")?.connections).toBe(2);
  expect(graph.nodes.find((node) => node.id === "不可读.md")?.unreadable).toBe(true);
});

it("一跳局部与目录过滤准确，目录边界不混入同前缀路径，过滤后孤立开关生效", () => {
  const paths = ["a.md", "项目/b.md", "项目/c.md", "项目二/d.md"];
  const graph = buildGraph(new KnowledgeIndex().build(paths, [note("a.md", "[[项目/b]]"), note("项目/b.md", "[[项目/c]]"), note("项目/c.md", ""), note("项目二/d.md", "")]));
  const local = filterGraph(graph, { ...defaultGraphSettings, mode: "local", center: "a.md" });
  expect(local.nodes.map((node) => node.id).sort()).toEqual(["a.md", "项目/b.md"]);
  expect(filterGraph(graph, { ...defaultGraphSettings, folder: "项目" }).nodes.map((node) => node.id)).toEqual(["项目/b.md", "项目/c.md"]);
  expect(filterGraph(graph, { ...defaultGraphSettings, folder: "项目二", isolated: false }).nodes).toHaveLength(0);
  expect(filterGraph(graph, { ...defaultGraphSettings, mode: "local", center: "已删除.md" }).centerExists).toBe(false);
});

it("缓存按版本与内容更新，目标目录变化重新解析，不带入被移除的旧笔记", () => {
  const cache = new KnowledgeIndex();
  expect(cache.build(["a.md"], [note("a.md", "[[b]]")]).references[0].status).toBe("missing");
  expect(cache.build(["a.md", "b.md"], [note("a.md", "[[b]]")]).references[0].target).toBe("b.md");
  expect(cache.build(["a.md", "b.md"], [note("a.md", "[[缺失]]")]).references[0].status).toBe("missing");
  expect(cache.build(["b.md"], [note("a.md", "[[b]]")]).references).toEqual([]);
});

it("大图保留完整范围和明确的展示上限，搜索选中节点可提升进入展示", () => {
  const paths = Array.from({ length: graphDisplayLimit + 1 }, (_, i) => "文件" + i.toString().padStart(4,"0") + ".md");
  const graph = buildGraph(new KnowledgeIndex().build(paths, []));
  const shown = filterGraph(graph, defaultGraphSettings, paths.at(-1)!);
  expect(graph.nodes).toHaveLength(graphDisplayLimit + 1);
  expect(shown.scope).toHaveLength(graphDisplayLimit + 1);
  expect(shown.nodes).toHaveLength(graphDisplayLimit);
  expect(shown.nodes[0].id).toBe(paths.at(-1)); expect(shown.truncated).toBe(true);
  const current = filterGraph(graph, defaultGraphSettings, null, paths.at(-1)!);
  expect(current.nodes.some((node) => node.id === paths.at(-1))).toBe(true);
});

it("图谱工具标签与旧工作区兼容，不能恢复成文件编辑或草稿状态", () => {
  expect(normalizeWorkspace({ ...emptyWorkspace(), tabs: ["a.md", graphTabId], active: graphTabId, modes: { [graphTabId]: "source" }, editors: { [graphTabId]: { anchor: 5 } }, graph: { mode: "local", center: "a.md", folder: "项目", query: "a", isolated: false } })).toMatchObject({
    tabs: ["a.md", graphTabId], active: graphTabId, modes: {}, editors: {}, graph: { mode: "local", center: "a.md", folder: "项目", query: "a", isolated: false },
  });
  expect(normalizeWorkspace({ version: 1, tabs: ["a.md"] }).graph).toEqual(defaultGraphSettings);
});

it("内联 HTML 中的标记不生成关联，标签之后的真实链接仍保留", () => {
  const refs = new KnowledgeIndex().build(["a.md", "b.md"], [note("a.md", '<span title="x"><b>[[伪链接]]</b></span> <br> [[b]]')]).references;
  expect(refs.map((link) => link.raw)).toEqual(["b"]);
});

it("千篇已保存笔记可重建和增量更新关联，删除缓存不改变图谱关系", () => {
  const notes = Array.from({ length: 1000 }, (_, i) => note("笔记" + i + ".md", "# 笔记\n\n[[笔记" + ((i + 1) % 1000) + "]]\n"));
  const paths = notes.map((item) => item.path), cache = new KnowledgeIndex();
  const start = performance.now(), first = buildGraph(cache.build(paths, notes)), cold = performance.now() - start;
  const warmStart = performance.now(), second = buildGraph(cache.build(paths, notes)), warm = performance.now() - warmStart;
  expect(first.nodes).toHaveLength(1000); expect(first.edges).toHaveLength(1000);
  expect(second).toEqual(first);
  const changed = [...notes]; changed[0] = note(notes[0].path, "移除出链", "v2");
  expect(buildGraph(cache.build(paths, changed)).edges).toHaveLength(999);
  expect(buildGraph(new KnowledgeIndex().build(paths, notes))).toEqual(first);
  console.log("1000-note in-memory relation build: cold=" + cold.toFixed(1) + "ms, warm=" + warm.toFixed(1) + "ms");
});
