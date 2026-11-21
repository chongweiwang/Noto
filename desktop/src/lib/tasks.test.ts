import { describe, expect, it } from "vitest";
import { appendExistingTask, isTaskCategoryDocument, parseTaskDocument, prependTask, removeTask, setTaskCompleted, setTaskField, setTaskTitle, taskCategoryMarker, taskMoveIssue, taskOverdue, validTaskDate } from "./tasks";

const sample = `# 工作

- [ ] 整理需求
  - 开始日期：2026-11-13
  - 结束日期：2026-11-15
  - 未知字段：需要保留
  - 备注：

    参考 **架构** 和 [需求](../项目/需求.md)。

    - [ ] 备注内的清单

    | 名称 | 状态 |
    | --- | --- |
    | 工作 | 待定 |

    ~~~text
    - [ ] 代码内不是任务
    ~~~

- [x] 整理需求
  - 备注：已经完成。
`;

describe("任务 Markdown 文件", () => {
  it("仅未完成且有效的过去结束日期标记为逾期", () => {
    const today = "2026-11-17";
    expect(taskOverdue({ completed: false, endDate: "2026-11-16" }, today)).toBe(true);
    expect(taskOverdue({ completed: false, endDate: today }, today)).toBe(false);
    expect(taskOverdue({ completed: true, endDate: "2026-11-16" }, today)).toBe(false);
    expect(taskOverdue({ completed: false, endDate: "2026-02-30" }, today)).toBe(false);
    expect(taskOverdue({ completed: false, endDate: "" }, today)).toBe(false);
  });
  it("仅将明确标记的 Markdown 文件识别为分类", () => {
    expect(isTaskCategoryDocument(`${taskCategoryMarker}\n\n# 工作\n`)).toBe(true);
    expect(isTaskCategoryDocument("# 普通笔记\n\n- [ ] 待办\n")).toBe(false);
    expect(isTaskCategoryDocument(`# 正文\n\n${taskCategoryMarker}\n`)).toBe(false);
  });
  it("只读取顶层任务，正确解析多段 Markdown 备注", () => {
    const { tasks, issues } = parseTaskDocument(sample);
    expect(issues).toEqual([]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ title: "整理需求", completed: false, startDate: "2026-11-13", endDate: "2026-11-15", issues: [] });
    expect(tasks[0].remark).toContain("[需求](../项目/需求.md)");
    expect(tasks[0].remark).toContain("- [ ] 备注内的清单");
    expect(tasks[0].remark).toContain("~~~text\n- [ ] 代码内不是任务\n~~~");
    expect(tasks[1]).toMatchObject({ title: "整理需求", completed: true, remark: "已经完成。" });
  });

  it("勾选、改名和修改日期只触及目标内容，保留其他字段和备注原文", () => {
    const first = parseTaskDocument(sample).tasks[0];
    const checked = setTaskCompleted(sample, first, true);
    expect(checked).toBe(sample.replace("- [ ] 整理需求", "- [x] 整理需求"));
    const renamed = setTaskTitle(checked, parseTaskDocument(checked).tasks[0], "整理中文需求");
    expect(renamed).toBe(checked.replace("- [x] 整理需求", "- [x] 整理中文需求"));
    const changed = setTaskField(renamed, parseTaskDocument(renamed).tasks[0], "endDate", "2026-11-16");
    expect(changed).toBe(renamed.replace("结束日期：2026-11-15", "结束日期：2026-11-16"));
  });

  it("可写入并重新解析多行 Markdown 备注，内含表格、链接和代码", () => {
    const note = "说明 **重要**：[文件](../项目/需求.md)\n\n- 清单\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```";
    const updated = setTaskField(sample, parseTaskDocument(sample).tasks[1], "remark", note);
    const result = parseTaskDocument(updated);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[1].remark).toBe(note);
    expect(result.tasks[0].raw).toBe(parseTaskDocument(sample).tasks[0].raw);
  });

  it("备注末尾换行和空格在保存与重新解析时不丢失", () => {
    const base = "# 工作\n\n- [ ] 第一项\n\n- [ ] 第二项\n";
    for (const remark of ["第一行\n", "\n", "多行\n\n", "内容  \n下一行", "  缩进\n", "[资料][doc]\n\n[doc]: ../项目/需求.md\n"]) {
      const updated = setTaskField(base, parseTaskDocument(base).tasks[0], "remark", remark);
      const parsed = parseTaskDocument(updated);
      expect(parsed.tasks).toHaveLength(2);
      expect(parsed.tasks[0].remark).toBe(remark);
      const checked = setTaskCompleted(updated, parsed.tasks[0], true);
      expect(parseTaskDocument(checked).tasks[0].remark).toBe(remark);
      const dated = setTaskField(checked, parseTaskDocument(checked).tasks[0], "startDate", "2026-11-13");
      expect(parseTaskDocument(dated).tasks[0].remark).toBe(remark);
    }
  });

  it("输入尚未闭合的备注代码块时不会覆盖后面的任务", () => {
    const base = "# 工作\n\n- [ ] 第一项\n\n- [ ] 第二项\n";
    const once = setTaskField(base, parseTaskDocument(base).tasks[0], "remark", "```text\n内容");
    const tasks = parseTaskDocument(once).tasks;
    expect(tasks).toHaveLength(2);
    const twice = setTaskField(once, tasks[0], "remark", "```text\n内容更多");
    const result = parseTaskDocument(twice).tasks;
    expect(result).toHaveLength(2);
    expect(result[1].title).toBe("第二项");
    expect(result[0].remark).toBe("```text\n内容更多");
    const dated = setTaskField(twice, result[0], "startDate", "2026-11-13");
    const afterDate = parseTaskDocument(dated).tasks;
    expect(afterDate).toHaveLength(2);
    expect(afterDate[0]).toMatchObject({ startDate: "2026-11-13", remark: "```text\n内容更多" });
    expect(afterDate[1].title).toBe("第二项");
    const edited = setTaskField(dated, afterDate[0], "remark", "```text\n继续输入\n```");
    const afterEdit = parseTaskDocument(edited).tasks;
    expect(afterEdit).toHaveLength(2);
    expect(afterEdit[0]).toMatchObject({ startDate: "2026-11-13", remark: "```text\n继续输入\n```" });
    expect(afterEdit[1].title).toBe("第二项");
  });

  it("逐字输入复杂 Markdown 的每个中间状态都保留后续任务", () => {
    const tails = ["- [ ] 第二项\n\n## 其他正文\n不要改动\n", "- 普通列表\n\n## 其他正文\n不要改动\n", "## 其他正文\n不要改动\n"];
    const remarks = ["标题 **重要**\n\n- [ ] 子项\n\n```ts\nconst x = 1;\n```\n\n[文档](../项目/说明.md)\n", "注释：\n\n<!--\n正在输入\n-->\n"];
    for (const tail of tails) for (const remark of remarks) {
      let content = `# 工作\n\n- [ ] 第一项\n\n${tail}`, typed = "";
      for (const char of remark) {
        typed += char;
        content = setTaskField(content, parseTaskDocument(content).tasks[0], "remark", typed);
        const parsed = parseTaskDocument(content);
        expect(parsed.tasks).toHaveLength(tail.startsWith("- [ ]") ? 2 : 1);
        expect(parsed.tasks[0].remark).toBe(typed);
        expect(content.endsWith(tail)).toBe(true);
      }
    }
  });

  it("逐字编辑备注时保留前后的日期和未知字段", () => {
    let content = "- [ ] 任务\n  - 开始日期：2026-11-13\n  - 备注：旧值\n  - 结束日期：2026-11-15\n  - 未知字段：保留\n\n- [ ] 后续\n";
    let typed = "";
    for (const char of "```md\n内容\n```\n\n<!--注释-->\n") {
      typed += char;
      content = setTaskField(content, parseTaskDocument(content).tasks[0], "remark", typed);
      const tasks = parseTaskDocument(content).tasks;
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toMatchObject({ startDate: "2026-11-13", endDate: "2026-11-15", remark: typed });
      expect(content).toContain("- 未知字段：保留");
      expect(tasks[1].title).toBe("后续");
    }
  });

  it("新增、移除日期与任务不会改动相邻任务", () => {
    const added = prependTask("# 生活\n", "买牛奶");
    let task = parseTaskDocument(added.content).tasks[0];
    let content = setTaskField(added.content, task, "startDate", "2026-11-13");
    task = parseTaskDocument(content).tasks[0];
    content = setTaskField(content, task, "endDate", "2026-11-15");
    task = parseTaskDocument(content).tasks[0];
    expect(task).toMatchObject({ startDate: "2026-11-13", endDate: "2026-11-15" });
    content = setTaskField(content, task, "startDate", "");
    expect(parseTaskDocument(content).tasks[0]).toMatchObject({ startDate: "", endDate: "2026-11-15" });
    const two = parseTaskDocument(sample).tasks;
    const removed = removeTask(sample, two[1]);
    expect(parseTaskDocument(removed).tasks).toHaveLength(1);
    expect(parseTaskDocument(removed).tasks[0].raw).toBe(two[0].raw);
  });

  it("将新任务插到第一个任务前，保留分类标题、说明和现有有序列表", () => {
    const header = taskCategoryMarker + "\n\n# 工作\n\n分类说明。\n\n";
    const existing = "  1. [ ] 原任务\n     - 备注：保留\n  2. [x] 已完成\n";
    const added = prependTask(header + existing, "新增");
    expect(added.content).toBe(header + "  1. [ ] 新增\n\n" + existing);
    expect(added.tasks.map((task) => task.title)).toEqual(["新增", "原任务", "已完成"]);
  });

  it("解析直接创建时间字段，缺失、无效及有歧义的时间不用于排序", () => {
    const time = "2026-11-21T06:30:00.000Z";
    const field = "  - 创建时间：" + time + "\n";
    const content = "- [ ] 已记录\n" + field + "\n- [ ] 旧任务\n\n- [ ] 无效\n" +
      "  - 创建时间：2026-02-30T06:30:00.000Z\n\n- [ ] 重复\n" + field + field;
    const { tasks } = parseTaskDocument(content);
    expect(tasks.map((task) => task.createdAt)).toEqual([time, "", "", ""]);
    const edited = setTaskField(content, tasks[2], "remark", "正常编辑");
    expect(edited).toContain("创建时间：2026-02-30T06:30:00.000Z");
  });

  it("检查非法日期、字段重复、过期位置和无法插入的位置", () => {
    expect(validTaskDate("2024-02-29")).toBe(true);
    expect(validTaskDate("2025-02-29")).toBe(false);
    expect(validTaskDate("2026-13-01")).toBe(false);
    const task = parseTaskDocument(sample).tasks[0];
    expect(() => setTaskField(sample, task, "endDate", "2026-11-01")).toThrow("不能早于");
    expect(() => setTaskCompleted(sample.replace("整理需求", "已外部修改"), task, true)).toThrow("已变化");
    const duplicate = "- [ ] 一项\n  - 开始日期：2026-11-13\n  - 开始日期：2026-11-14\n";
    const invalid = parseTaskDocument(duplicate).tasks[0];
    expect(invalid.issues).toContain("开始日期重复");
    expect(() => setTaskField(duplicate, invalid, "remark", "文字")).toThrow("存在问题");
    expect(() => prependTask("```\n未闭合代码块\n", "无法插入")).toThrow("无法安全插入");
  });

  it("跨分类复制原任务并拒绝改变本文件锚点和外部链接定义", () => {
    const task = parseTaskDocument(sample).tasks[0];
    const target = appendExistingTask("# 生活\n", sample, task);
    expect(parseTaskDocument(target).tasks[0].raw).toBe(task.raw);
    const anchor = "- [ ] 一项\n  - 备注：[章节](#标题)\n";
    expect(taskMoveIssue(anchor, parseTaskDocument(anchor).tasks[0])).toContain("锚点");
    const reference = "- [ ] 一项\n  - 备注：[文档][ref]\n\n[ref]: ../项目/说明.md\n";
    expect(taskMoveIssue(reference, parseTaskDocument(reference).tasks[0])).toContain("外部的链接");
    const footnote = "- [ ] 一项\n  - 备注：说明[^1]\n\n[^1]: 任务外的脚注\n";
    expect(taskMoveIssue(footnote, parseTaskDocument(footnote).tasks[0])).toContain("脚注定义");
  });
});
