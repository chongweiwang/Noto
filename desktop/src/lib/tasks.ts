import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

// Task files remain ordinary Markdown. Only top-level GFM task items are
// managed; nested lists and checkboxes in a remark are part of that remark.
type Node = {
  type: string;
  checked?: boolean | null;
  url?: string;
  identifier?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
export type TaskStatus = "todo" | "doing" | "done";
export const taskStatusLabels: Record<TaskStatus, string> = { todo: "待处理", doing: "进行中", done: "已完成" };
export type TaskFieldKey = "startDate" | "endDate" | "remark" | "id" | "createdAt" | "statusText" | "boardOrderText";
type Field = { from: number; to: number; value: string };
export type Task = {
  from: number; to: number; raw: string; stateAt: number; titleFrom: number; titleTo: number;
  indent: string; title: string; completed: boolean; startDate: string; endDate: string; remark: string;
  id: string; createdAt: string; statusText: string; boardOrderText: string; status: TaskStatus | null; boardOrder: number | null;
  boardIssues: string[];
  fields: Partial<Record<TaskFieldKey, Field>>;
  issues: string[];
};
export type TaskDocument = { tasks: Task[]; issues: string[] };

export const taskFolder = "任务";
export const taskCategoryMarker = "<!-- noto:task-category -->";
export function isTaskCategoryDocument(source: string): boolean {
  return /^[ \t\n]*<!--[ \t]*noto:task-category[ \t]*-->[ \t]*(?:\n|$)/.test(source);
}
const parser = unified().use(remarkParse).use(remarkGfm);
const labels = { startDate: "开始日期", endDate: "结束日期", remark: "备注", id: "任务ID", createdAt: "创建时间", statusText: "状态", boardOrderText: "看板顺序" } as const;
const keys = { "开始日期": "startDate", "结束日期": "endDate", "备注": "remark", "任务ID": "id", "创建时间": "createdAt", "状态": "statusText", "看板顺序": "boardOrderText" } as const;
type FieldKey = keyof typeof labels;

function lineStart(source: string, at: number) { return source.lastIndexOf("\n", at - 1) + 1; }
function lineEnd(source: string, at: number) { const next = source.indexOf("\n", at); return next < 0 ? source.length : next; }
function offsets(node: Node): [number, number] | null {
  const from = node.position?.start.offset, to = node.position?.end.offset;
  return from === undefined || to === undefined ? null : [from, to];
}

export function validTaskDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function taskOverdue(task: Pick<Task, "completed" | "endDate">, today: string): boolean {
  return !task.completed && validTaskDate(task.endDate) && task.endDate < today;
}

function parseCreationTime(value: string): string {
  if (value.length !== 24) return "";
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value ? value : "";
}

function parseField(source: string, node: Node, limit: number): { key: FieldKey; field: Field; issue?: string } | null {
  const range = offsets(node);
  if (!range) return null;
  const from = range[0], to = Math.min(range[1], limit);
  if (from >= to) return null;
  const end = Math.min(lineEnd(source, from), to);
  const first = source.slice(from, end);
  const match = /^([-+*]|\d{1,9}[.)])([ \t]+)(开始日期|结束日期|备注|任务ID|创建时间|状态|看板顺序)[：:]([ \t]?)(.*)$/.exec(first);
  if (!match) return null;
  const key = keys[match[3] as keyof typeof keys];
  const start = lineStart(source, from);
  if (key !== "remark") {
    const simple = node.children?.length === 1 && node.children[0].type === "paragraph" &&
      (node.children[0].position?.end.offset ?? to) <= end;
    return { key, field: { from: start, to, value: match[5].trim() }, issue: simple ? undefined : `${labels[key]}格式不明确` };
  }

  const indentation = source.slice(start, from);
  const continuation = indentation + " ".repeat(match[1].length + match[2].length);
  // Markdown parsers omit trailing blank lines from node positions. Our writer
  // indents them, so include those lines when recovering an edited remark.
  let fieldEnd = to;
  let cursor = fieldEnd;
  if (cursor === end && source[cursor] === "\n" && source[cursor + 1] === "\n") cursor += 1;
  while (cursor < limit && source[cursor] === "\n") {
    const next = Math.min(lineEnd(source, cursor + 1), limit);
    const line = source.slice(cursor + 1, next);
    if (!line.startsWith(continuation) || line.trim()) break;
    fieldEnd = next; cursor = next;
  }
  const remainder = end < fieldEnd ? source.slice(end + 1, fieldEnd).split("\n") : [];
  let issue: string | undefined;
  const lines = remainder.map((line) => {
    if (line.startsWith(continuation)) return line.slice(continuation.length);
    if (!line.trim()) return "";
    issue = "备注缩进不符合任务格式";
    return line;
  });
  if (!match[5] && lines[0] === "") lines.shift(); // blank line after the field label
  const value = match[5] ? [match[5], ...lines].join("\n") : lines.join("\n");
  return { key, field: { from: start, to: fieldEnd, value }, issue };
}

export function parseTaskDocument(source: string): TaskDocument {
  const root = parser.parse(source) as unknown as Node;
  const tasks: Task[] = [], issues: string[] = [];
  const blocks = root.children ?? [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const list = blocks[blockIndex];
    if (list.type !== "list") continue;
    const items = list.children ?? [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = items[itemIndex];
      if (item.type !== "listItem") continue;
      if (typeof item.checked !== "boolean") {
        const range = offsets(item);
        if (range && /^([-+*]|\d{1,9}[.)])[ \t]+\[[ xX]?\](?:[ \t]*$)/.test(source.slice(range[0], lineEnd(source, range[0])))) issues.push("有未命名或格式不完整的任务，请在原文件中处理");
        continue;
      }
      const range = offsets(item);
      if (!range) { issues.push("存在无法定位的任务"); continue; }
      const from = range[0];
      const next = offsets(items[itemIndex + 1] ?? blocks[blockIndex + 1] ?? { type: "" });
      let limit = next ? lineStart(source, next[0]) : source.length;
      while (limit > from && source[limit - 1] === "\n") limit--;
      const to = Math.min(range[1], limit), end = lineEnd(source, from);
      const first = source.slice(from, end);
      const match = /^([-+*]|\d{1,9}[.)])([ \t]+)\[([ xX])\]([ \t]+)(.*)$/.exec(first);
      if (!match) { issues.push("有任务格式无法识别，请在原文件中处理"); continue; }
      const markerLength = match[1].length + match[2].length;
      const titleFrom = from + markerLength + 3 + match[4].length;
      const prefix = source.slice(lineStart(source, from), from);
      const task: Task = {
        from, to, raw: source.slice(from, to), stateAt: from + markerLength + 1, titleFrom, titleTo: end,
        indent: prefix + " ".repeat(markerLength), title: match[5], completed: item.checked,
        startDate: "", endDate: "", remark: "", id: "", createdAt: "", statusText: "", boardOrderText: "", status: item.checked ? "done" : "todo", boardOrder: null, boardIssues: [], fields: {}, issues: [],
      };
      const children = item.children ?? [];
      for (let childIndex = 0; childIndex < children.length; childIndex++) {
        const child = children[childIndex];
        if (child.type !== "list") continue;
        const fields = child.children ?? [];
        for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
          const entry = fields[fieldIndex];
          const entryRange = offsets(entry);
          const following = offsets(fields[fieldIndex + 1] ?? children[childIndex + 1] ?? { type: "" });
          let fieldLimit = following ? Math.min(limit, lineStart(source, following[0])) : limit;
          while (fieldLimit > (entryRange?.[0] ?? from) && source[fieldLimit - 1] === "\n") fieldLimit--;
          const parsed = parseField(source, entry, fieldLimit);
          if (!parsed) continue;
          if (parsed.key === "createdAt") {
            // Ignore ambiguous timestamps for sorting and leave their Markdown intact.
            task.createdAt = task.fields.createdAt || parsed.issue ? "" : parseCreationTime(parsed.field.value);
            task.fields.createdAt ??= parsed.field;
            continue;
          }
          if (task.fields[parsed.key]) { (["id", "statusText", "boardOrderText"].includes(parsed.key) ? task.boardIssues : task.issues).push(`${labels[parsed.key]}重复`); continue; }
          task.fields[parsed.key] = parsed.field;
          task[parsed.key] = parsed.field.value;
          if (parsed.field.to > task.to) { task.to = parsed.field.to; task.raw = source.slice(task.from, task.to); }
          if (parsed.issue) (["id", "statusText", "boardOrderText"].includes(parsed.key) ? task.boardIssues : task.issues).push(parsed.issue);
        }
      }
      if (task.startDate && !validTaskDate(task.startDate)) task.issues.push("开始日期无效");
      if (task.endDate && !validTaskDate(task.endDate)) task.issues.push("结束日期无效");
      if (validTaskDate(task.startDate) && validTaskDate(task.endDate) && task.startDate > task.endDate) task.issues.push("结束日期早于开始日期");
      if (task.fields.id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(task.id)) task.boardIssues.push("任务ID无效");
      const stated = (Object.keys(taskStatusLabels) as TaskStatus[]).find((key) => taskStatusLabels[key] === task.statusText);
      if (task.fields.statusText && (!stated || task.boardIssues.includes("状态重复") || task.boardIssues.includes("状态格式不明确"))) {
        task.status = null; task.boardIssues.push("状态无法确定");
      } else {
        task.status = task.completed ? "done" : stated === "doing" ? "doing" : "todo";
        if (stated && (stated === "done") !== task.completed) task.boardIssues.push("状态与完成框不一致");
      }
      if (task.fields.boardOrderText) {
        const order = Number(task.boardOrderText);
        if (!/^\d+$/.test(task.boardOrderText) || !Number.isSafeInteger(order) || order < 0) task.boardIssues.push("看板顺序无效");
        else task.boardOrder = order;
      }
      tasks.push(task);
    }
  }
  const ids = new Map<string, Task[]>();
  for (const task of tasks) if (task.id) { const entries = ids.get(task.id) ?? []; entries.push(task); ids.set(task.id, entries); }
  for (const entries of ids.values()) if (entries.length > 1) for (const task of entries) task.boardIssues.push("任务ID在分类内重复");
  return { tasks, issues };
}

function verify(source: string, task: Task) {
  if (source.slice(task.from, task.to) !== task.raw) throw new Error("任务内容已变化，请刷新后重试");
}
function replace(source: string, from: number, to: number, value: string) { return source.slice(0, from) + value + source.slice(to); }

export function setTaskCompleted(source: string, task: Task, completed: boolean): string {
  verify(source, task);
  return replace(source, task.stateAt, task.stateAt + 1, completed ? "x" : " ");
}
export function setTaskTitle(source: string, task: Task, title: string): string {
  verify(source, task);
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error("任务名称不能为空，也不能换行");
  return replace(source, task.titleFrom, task.titleTo, title);
}
export function setTaskField(source: string, task: Task, key: FieldKey, value: string): string {
  return patchTaskFields(source, task, { [key]: value });
}

// Every range is checked against one content revision; apply edits backwards,
// preserving task bodies and surrounding Markdown instead of serializing a board.
export function patchTaskFields(source: string, task: Task, values: Partial<Record<TaskFieldKey, string>>, options: { completed?: boolean; title?: string } = {}): string {
  verify(source, task);
  if (task.issues.length && Object.keys(values).length) throw new Error("任务字段存在问题，请先在原文件中处理");
  const start = values.startDate ?? task.startDate, end = values.endDate ?? task.endDate;
  for (const key of ["startDate", "endDate"] as const) if (values[key] && !validTaskDate(values[key]!)) throw new Error("请输入有效的日期");
  if ((values.startDate !== undefined || values.endDate !== undefined) && start && end && start > end) throw new Error("结束日期不能早于开始日期");
  const edits: { from: number; to: number; value: string }[] = [];
  let appended = "";
  for (const [key, value] of Object.entries(values) as [TaskFieldKey, string][]) {
    let replacement = "";
    if (value) {
      if (key === "remark") {
        const normalized = value.replace(/\r\n?/g, "\n");
        replacement = task.indent + "- 备注：\n\n" + normalized.split("\n").map((line) => task.indent + "  " + line).join("\n");
      } else replacement = task.indent + "- " + labels[key] + "：" + value;
    }
    const field = task.fields[key];
    if (field) { if (field.value !== value) edits.push({ from: field.from, to: field.to, value: replacement }); }
    else if (replacement) appended += "\n" + replacement;
  }
  if (appended) edits.push({ from: task.to, to: task.to, value: appended });
  if (options.completed !== undefined) edits.push({ from: task.stateAt, to: task.stateAt + 1, value: options.completed ? "x" : " " });
  if (options.title !== undefined) {
    if (!options.title.trim() || /[\r\n]/.test(options.title)) throw new Error("任务名称不能为空，也不能换行");
    edits.push({ from: task.titleFrom, to: task.titleTo, value: options.title });
  }
  return edits.sort((a, b) => b.from - a.from).reduce((text, edit) => replace(text, edit.from, edit.to, edit.value), source);
}
export function removeTask(source: string, task: Task): string {
  verify(source, task);
  const from = lineStart(source, task.from), to = source[task.to] === "\n" ? task.to + 1 : task.to;
  return replace(source, from, to, "");
}
export function prependTask(source: string, title: string): { content: string; task: Task; tasks: Task[] } {
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error("请输入单行任务名称");
  const first = parseTaskDocument(source).tasks[0];
  const at = first ? lineStart(source, first.from) : source.length;
  const separator = first || !source || source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  // Match the first item's marker and indentation to keep it at the same Markdown list level.
  const marker = first ? source.slice(at, first.stateAt - 1) : "- ";
  const entry = `${separator}${marker}[ ] ${title.trim()}\n${first ? "\n" : ""}`;
  const content = replace(source, at, at, entry);
  const { tasks } = parseTaskDocument(content);
  const task = tasks[0];
  if (task?.from !== (first?.from ?? at + separator.length)) throw new Error("当前 Markdown 格式无法安全插入任务，请先检查原文件");
  return { content, task, tasks };
}

// Cross-category moves copy the original task bytes into the target first.
// Links to this file or reference definitions outside the task need explicit
// resolution, so refuse those moves instead of silently changing their target.
export function taskMoveIssue(source: string, task: Task): string | null {
  verify(source, task);
  const root = parser.parse(source) as unknown as Node;
  const definitions = new Map<string, Node>();
  const links: Node[] = [];
  function visit(node: Node) {
    if (["definition", "footnoteDefinition"].includes(node.type) && node.identifier) definitions.set(`${node.type}:${node.identifier.toLowerCase()}`, node);
    const range = offsets(node);
    if (range && range[0] >= task.from && range[1] <= task.to && ["link", "image", "linkReference", "imageReference", "footnoteReference"].includes(node.type)) links.push(node);
    for (const child of node.children ?? []) visit(child);
  }
  visit(root);
  for (const link of links) {
    const definitionType = link.type === "footnoteReference" ? "footnoteDefinition" : "definition";
    const definition = link.identifier ? definitions.get(`${definitionType}:${link.identifier.toLowerCase()}`) : undefined;
    const range = definition && offsets(definition);
    const url = link.url ?? definition?.url;
    if (url?.startsWith("#")) return "任务包含指向当前分类文件的锚点，请在原文件中调整链接后再移动";
    if (definition && (!range || range[0] < task.from || range[1] > task.to)) return "任务引用了任务外部的链接或脚注定义，请先在原文件中调整";
  }
  return null;
}

export function appendExistingTask(target: string, source: string, task: Task, relocate?: (text: string) => string): string {
  verify(source, task);
  const issue = taskMoveIssue(source, task);
  if (issue) throw new Error(issue);
  const separator = !target ? "" : target.endsWith("\n\n") ? "" : target.endsWith("\n") ? "\n" : "\n\n";
  const original = source.slice(lineStart(source, task.from), task.to);
  const text = relocate ? relocate(original) : original;
  const content = `${target}${separator}${text}\n`;
  const position = target.length + separator.length + (task.from - lineStart(source, task.from));
  if (!parseTaskDocument(content).tasks.some((entry) => entry.from === position)) throw new Error("目标文件末尾的 Markdown 格式无法安全插入任务");
  return content;
}
