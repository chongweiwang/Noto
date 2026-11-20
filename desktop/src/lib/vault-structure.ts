import type { Entry } from "./desktop-api";
import { dailyFolder } from "./calendar";

export const taskRoot = "任务";
export const defaultTaskGroup = `${taskRoot}/默认`;
export function isTaskOrJournalRoot(entry: Entry): boolean {
  return !entry.issue && entry.isDirectory && (entry.path === taskRoot || entry.path === dailyFolder);
}
export const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const pathName = (path: string) => path.split("/").pop() ?? path;
export const isMarkdownPath = (path: string) => /\.(?:md|markdown)$/i.test(path);
export function taskGroupOf(path: string): string | null { return /^任务\/[^/]+\/[^/]+\.(?:md|markdown)$/i.test(path) ? parentPath(path) : null; }
export function taskLabel(path: string): string { return path.replace(/^任务\//, "").replace(/\.(?:md|markdown)$/i, "").replaceAll("/", " / "); }
export function findEntry(entries: Entry[], path: string): Entry | undefined {
  for (const entry of entries) { if (entry.issue) continue; if (entry.path === path) return entry; const child = findEntry(entry.children, path); if (child) return child; }
}
export function sameFileTree(previous: Entry[], next: Entry[]): boolean {
  return previous === next || previous.length === next.length && previous.every((entry, index) => {
    const current = next[index];
    return entry.path === current.path && entry.name === current.name && entry.isDirectory === current.isDirectory &&
      entry.issue === current.issue && sameFileTree(entry.children, current.children);
  });
}
export function taskGroups(entries: Entry[]): string[] {
  return (findEntry(entries, taskRoot)?.children ?? []).filter((entry) => !entry.issue && entry.isDirectory).map((entry) => entry.path).sort((a, b) => a.localeCompare(b, "zh-CN"));
}
export function taskFiles(entries: Entry[]): string[] {
  return (findEntry(entries, taskRoot)?.children ?? []).filter((entry) => !entry.issue && entry.isDirectory).flatMap((entry) => entry.children.filter((child) => !child.issue && !child.isDirectory && isMarkdownPath(child.path)).map((child) => child.path)).sort((a, b) => a.localeCompare(b, "zh-CN"));
}
export async function ensureDirectory(path: string, api: { entries: () => Promise<Entry[]>; createDirectory: (path: string) => Promise<void> }): Promise<void> {
  const parts = path.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const current = parts.slice(0, index).join("/");
    let entry = findEntry(await api.entries(), current);
    if (!entry) {
      try { await api.createDirectory(current); }
      catch (cause) { entry = findEntry(await api.entries(), current); if (!entry?.isDirectory) throw cause; }
    } else if (!entry.isDirectory) throw new Error(`“${current}”已存在但不是文件夹`);
  }
}
export function relativePath(source: string, target: string): string {
  const from = parentPath(source).split("/").filter(Boolean), to = target.split("/");
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => ".."), ...to].join("/") || pathName(target);
}
export function encodePath(path: string): string { return path.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/"); }
