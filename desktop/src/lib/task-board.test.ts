import { expect, it } from "vitest";
import { parseTaskDocument, taskCategoryMarker } from "./tasks";
import { appendManagedTask, changeManagedTask, compareTaskOrder, placeTask, taskWritable } from "./task-board";
const base = taskCategoryMarker + "\n\n# 工作\n\n说明保留。\n\n";
const parse = (text: string) => parseTaskDocument(text).tasks;
it("旧任务只读推导三列，状态冲突以完成框为准并提示，未知状态不隐藏", () => {
  const source = base + "- [ ] 旧任务\n\n- [X] 旧完成\n\n- [ ] 工作\n  - 状态：进行中\n\n- [x] 矛盾\n  - 状态：进行中\n\n- [ ] 重开\n  - 状态：已完成\n\n- [ ] 未知\n  - 状态：等待别人\n";
  const tasks = parse(source);
  expect(tasks.map((task) => task.status)).toEqual(["todo", "done", "doing", "done", "todo", null]);
  expect(tasks[0].id).toBe(""); expect(tasks[0].fields).toEqual({});
  expect(tasks[3].boardIssues).toContain("状态与完成框不一致");
  expect(tasks[5].boardIssues).toContain("状态无法确定");
  expect(taskWritable(tasks[3])).toBe(true); expect(taskWritable(tasks[5])).toBe(false);
});
it("元数据只取任务直接字段，备注和代码中的任务不成为卡片", () => {
  const source = base + "- [ ] 工作\n  - 任务ID：task-a\n  - 状态：进行中\n  - 看板顺序：1000\n  - 备注：\n\n    - 状态：已完成\n    - [x] 子步骤\n\n    ~~~md\n    - [ ] 示例\n    ~~~\n";
  const tasks = parse(source);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ id: "task-a", status: "doing", boardOrder: 1000 });
  expect(tasks[0].remark).toContain("- [x] 子步骤");
});
it("重复或非法元数据不能成为有歧义的写操作，其他任务仍可修改", () => {
  const tasks = parse(base + "- [ ] A\n  - 任务ID：duplicate\n\n- [ ] B\n  - 任务ID：duplicate\n\n- [ ] C\n  - 状态：进行中\n  - 状态：待处理\n\n- [ ] D\n  - 看板顺序：9007199254740992\n\n- [ ] E\n");
  expect(tasks.slice(0,4).map(taskWritable)).toEqual([false,false,false,false]); expect(taskWritable(tasks[4])).toBe(true);
  expect(tasks[2].status).toBeNull();
});
it("状态更新和取消完成同时维护复选框，原文、日期、备注和未知字段保持", () => {
  const source = base + "- [ ] 同名\n  - 任务ID：task-a\n  - 开始日期：2026-11-14\n  - 结束日期：2026-11-20\n  - 未知字段：保留\n  - 备注：\n\n    [资料](../资料.md) 和 [[关联]]\n\n    - [ ] 步骤\n\n- [ ] 同名\n  - 任务ID：task-b\n";
  const other = parse(source)[1].raw;
  const done = changeManagedTask(source, parse(source)[0], { kind: "completed", value: true });
  expect(parse(done)[0]).toMatchObject({ status: "done", completed: true, id: "task-a", startDate: "2026-11-14", endDate: "2026-11-20", remark: parse(source)[0].remark });
  expect(parse(done)[1].raw).toBe(other); expect(done).toContain("- 未知字段：保留");
  const reopened = changeManagedTask(done, parse(done)[0], { kind: "completed", value: false });
  expect(parse(reopened)[0]).toMatchObject({ status: "todo", completed: false });
  expect(reopened.startsWith(base)).toBe(true);
});
it("排序只改列内顺序字段，不跨过标题移动正文，持久身份保持", () => {
  const source = base + "- [ ] A\n  - 任务ID：task-a\n\n## 保留标题\n\n不要移动。\n\n- [ ] B\n  - 任务ID：task-b\n\n- [ ] C\n  - 任务ID：task-c\n";
  const tasks = parse(source);
  const updated = placeTask(source, tasks[2], "todo", tasks[0].from);
  expect(parse(updated).slice().sort(compareTaskOrder).map((task) => task.id)).toEqual(["task-c","task-a","task-b"]);
  expect(updated.indexOf("- [ ] A")).toBeLessThan(updated.indexOf("## 保留标题"));
  expect(updated.indexOf("## 保留标题")).toBeLessThan(updated.indexOf("- [ ] B"));
  expect(parse(updated).map((task) => task.title)).toEqual(["A","B","C"]);
});
it("首次编辑按需补 ID，连续修改保留 ID 和复杂备注的每个中间状态", () => {
  let source = base + "- [ ] A\n\n- [ ] B\n";
  const initialOther = parse(source)[1].raw;
  source = changeManagedTask(source, parse(source)[0], { kind: "title", value: "A 新" });
  const id = parse(source)[0].id; expect(id).toBeTruthy();
  for (const value of ["~","~~~md\n", "~~~md\n- [ ] 示例", "~~~md\n- [ ] 示例\n~~~\n\n备注 "]) {
    source = changeManagedTask(source, parse(source)[0], { kind: "remark", value });
    expect(parse(source)[0]).toMatchObject({ id, remark: value }); expect(parse(source)[1].raw).toBe(initialOther);
  }
});
it("创建三种状态的任务，同名任务各自有 ID，日期不被状态推断修改", () => {
  let source = base;
  for (const status of ["todo","doing","done"] as const) source = appendManagedTask(source, "同名", status).content;
  const tasks = parse(source);
  expect(tasks.map((task) => task.status)).toEqual(["todo","doing","done"]);
  expect(new Set(tasks.map((task) => task.id)).size).toBe(3);
  expect(tasks.every((task) => !task.startDate && !task.endDate)).toBe(true);
});
it("来源过期和目标落点消失时拒绝，不依赖相同标题猜测任务", () => {
  const source = base + "- [ ] A\n";
  const task = parse(source)[0];
  expect(() => placeTask(source.replace("A","B"), task, "doing")).toThrow();
  expect(() => placeTask(source, task, "todo", 9999)).toThrow();
});
import { normalizeWorkspace, defaultTaskViewSettings } from "./workspace-state";
it("任务视图旧记录默认列表，筛选与滚动按有效范围恢复", () => {
  expect(normalizeWorkspace({ version:1 }).tasks).toEqual(defaultTaskViewSettings);
  expect(normalizeWorkspace({ version:1,tasks:{view:"board",query:"任务",filter:"open",scrolls:{todo:200,board:70,list:-50,unknown:9}} }).tasks).toEqual({view:"board",query:"任务",filter:"open",scrolls:{todo:200,board:70,list:0}});
});
it("20分类1000任务可派生，单分类状态与排序修改不影响其他分类", () => {
  const sources = Array.from({length:20},(_,category) => base + Array.from({length:50},(_,i) => "- [ ] 分类"+category+"任务"+i+"\n  - 任务ID：task-"+category+"-"+i+"\n  - 状态："+(i%2?"进行中":"待处理")+"\n").join("\n"));
  const begin = performance.now(), all = sources.flatMap((source,category) => parse(source).map((task) => ({category,task}))), parsed = performance.now()-begin;
  expect(all).toHaveLength(1000);
  const started = performance.now(), changed = placeTask(sources[0],parse(sources[0])[0],"doing"), mutation=performance.now()-started;
  expect(parse(changed).filter((task)=>task.status==="doing")).toHaveLength(26);
  expect(parse(changed)).toHaveLength(50);
  expect(all.filter((item)=>item.category===19)).toHaveLength(50);
  console.log("20 categories / 1000 tasks: parse="+parsed.toFixed(1)+"ms, one-category mutation="+mutation.toFixed(1)+"ms");
});
