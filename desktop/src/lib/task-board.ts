import { appendTask, parseTaskDocument, patchTaskFields, taskStatusLabels, type Task, type TaskFieldKey, type TaskStatus } from "./tasks";

export type TaskChange = { kind: "completed"; value: boolean } | { kind: "status"; value: TaskStatus } | { kind: "title" | "startDate" | "endDate" | "remark"; value: string };
export const taskStatuses = ["todo", "doing", "done"] as const;
export function taskWritable(task: Task): boolean { return !task.issues.length && task.boardIssues.every((issue) => issue === "状态与完成框不一致"); }
export function compareTaskOrder(a: Task, b: Task) { return (a.boardOrder ?? Infinity) - (b.boardOrder ?? Infinity) || a.from - b.from; }
let sequence = 0;
function newId(tasks: Task[]) {
  let id: string;
  do { id = globalThis.crypto?.randomUUID?.() ?? ("noto-" + Date.now().toString(36) + "-" + (++sequence).toString(36) + "-" + Math.random().toString(36).slice(2, 12)); } while (tasks.some((task) => task.id === id));
  return id;
}
function verifyTask(source: string, task: Task) {
  if (source.slice(task.from, task.to) !== task.raw) throw new Error("任务内容已变化，请重新选择");
  if (!taskWritable(task)) throw new Error("任务字段需处理，请打开分类文件检查");
}
function identity(source: string, task: Task) { return task.id || newId(parseTaskDocument(source).tasks); }

// before is a source offset in the same immutable content revision; null appends.
// Only the destination column in this category gets order fields, never another file.
export function placeTask(source: string, task: Task, status: TaskStatus, before: number | null = null): string {
  verifyTask(source, task);
  const tasks = parseTaskDocument(source).tasks;
  if (before === task.from && task.status === status) return source;
  const column = tasks.filter((entry) => entry.from !== task.from && entry.status === status && taskWritable(entry)).sort(compareTaskOrder);
  const index = before === null ? column.length : column.findIndex((entry) => entry.from === before);
  if (index < 0) throw new Error("目标位置已变化，请重试");
  column.splice(index, 0, task);
  const orders = new Map(column.map((entry, i) => [entry.from, String((i + 1) * 1000)]));
  return column.sort((a, b) => b.from - a.from).reduce((text, entry) => patchTaskFields(text, entry,
    entry.from === task.from ? { id: identity(source, task), statusText: taskStatusLabels[status], boardOrderText: orders.get(entry.from)! } : { boardOrderText: orders.get(entry.from)! },
    entry.from === task.from ? { completed: status === "done" } : {}), source);
}
export function changeManagedTask(source: string, task: Task, action: TaskChange): string {
  verifyTask(source, task);
  if (action.kind === "status" || action.kind === "completed") {
    const status = action.kind === "status" ? action.value : action.value ? "done" : "todo";
    if (task.status !== status) return placeTask(source, task, status);
    return patchTaskFields(source, task, { id: identity(source, task), statusText: taskStatusLabels[status] }, { completed: status === "done" });
  }
  const values: Partial<Record<TaskFieldKey, string>> = { id: identity(source, task) };
  if (!task.fields.statusText) values.statusText = taskStatusLabels[task.status!];
  if (action.kind !== "title") values[action.kind] = action.value;
  return patchTaskFields(source, task, values, action.kind === "title" ? { title: action.value } : {});
}
export function appendManagedTask(source: string, title: string, status: TaskStatus = "todo") {
  const added = appendTask(source, title), tasks = parseTaskDocument(added.content).tasks;
  const task = tasks.find((entry) => entry.from === added.from)!;
  const column = tasks.filter((entry) => entry.from !== task.from && entry.status === status);
  const values: Partial<Record<TaskFieldKey, string>> = { id: newId(tasks), statusText: taskStatusLabels[status] };
  if (column.some((entry) => entry.boardOrder !== null)) {
    const maximum = Math.max(0, ...column.map((entry) => entry.boardOrder ?? 0));
    if (maximum > Number.MAX_SAFE_INTEGER - 1000) return { content: placeTask(added.content, task, status), from: task.from };
    values.boardOrderText = String(maximum + 1000);
  }
  return { content: patchTaskFields(added.content, task, values, { completed: status === "done" }), from: task.from };
}
