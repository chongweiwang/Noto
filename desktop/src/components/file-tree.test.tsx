// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Entry } from "../lib/vault-api";
import { FileTree } from "./file-tree";
import { documentPaths } from "../lib/document-kind";
import { notePaths } from "../lib/knowledge";
import { findEntry } from "../lib/vault-structure";

afterEach(cleanup);

it("不兼容文件名显示诊断，不作为笔记打开、索引或拖动", () => {
  const unsupported = { path: "项目\\笔记.md", name: "项目\\笔记.md", isDirectory: false, children: [], issue: "文件名含不支持的反斜杠，请在文件管理器中改名后打开" };
  const normal = { path: "正常.md", name: "正常.md", isDirectory: false, children: [] };
  const callbacks = props([unsupported, normal]);
  const { container } = render(<FileTree {...callbacks} />);
  expect(screen.getByRole("note").textContent).toContain(unsupported.issue);
  expect(screen.queryByRole("button", { name: unsupported.name })).toBeNull();
  expect(container.querySelector('[draggable="true"][data-tree-path="项目\\\\笔记.md"]')).toBeNull();
  expect(documentPaths([unsupported, normal])).toEqual(["正常.md"]);
  expect(notePaths([unsupported, normal])).toEqual(["正常.md"]);
  expect(findEntry([{ ...unsupported, path: "", isDirectory: true }], "")).toBeUndefined();
  expect(callbacks.select).not.toHaveBeenCalled();
});

function entry(path: string, isDirectory: boolean, children: Entry[] = []): Entry {
  return { path, name: path.split("/").pop()!, isDirectory, children };
}

function props(entries: Entry[]) {
  return { entries, selected: "", collapsed: [], onCollapse: vi.fn(), managedFoldersExpanded: false, onManagedFoldersExpanded: vi.fn(), select: vi.fn(), context: vi.fn(), renaming: null, onRename: vi.fn().mockResolvedValue(true), onBeginRename: vi.fn(), onCancelRename: vi.fn(), onMove: vi.fn(), busy: false };
}

function rowPaths(list: Element) {
  return Array.from(list.children, (row) => row.querySelector(":scope > details > summary, :scope > div > button")?.getAttribute("data-tree-path") ?? row.querySelector(":scope > .tree-managed-toggle")?.textContent);
}

it("仅收纳根目录的任务与日记，保留真实目录的操作", () => {
  const project = entry("项目", true, [entry("项目/任务", true), entry("项目/日记", true)]);
  const task = entry("任务", true, [entry("任务/默认", true, [entry("任务/默认/分类.md", false)])]);
  const daily = entry("日记", true);
  const note = entry("笔记.md", false);
  const entries = [task, project, note, daily];
  const callbacks = { ...props(entries), selected: "笔记.md" };
  const { container, rerender } = render(<FileTree {...callbacks} />);

  const root = container.querySelector(".file-tree-root > .file-tree")!;
  expect(rowPaths(root)).toEqual(["项目", "笔记.md", "任务与日记"]);
  const projectChildren = container.querySelector('[data-tree-path="项目"]')!.nextElementSibling!;
  expect(rowPaths(projectChildren)).toEqual(["项目/任务", "项目/日记"]);
  expect(entries.map((item) => item.path)).toEqual(["任务", "项目", "笔记.md", "日记"]);

  const toggle = screen.getByRole("button", { name: "任务与日记" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector('[data-tree-path="任务"]')).toBeNull();
  fireEvent.contextMenu(toggle);
  fireEvent.keyDown(toggle, { key: "F2" });
  expect(callbacks.context).not.toHaveBeenCalled();
  expect(callbacks.onBeginRename).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(callbacks.onManagedFoldersExpanded).toHaveBeenCalledWith(true);
  rerender(<FileTree {...callbacks} managedFoldersExpanded />);
  expect(rowPaths(toggle.nextElementSibling!)).toEqual(["任务", "日记"]);

  const taskFile = container.querySelector<HTMLElement>('[data-tree-path="任务/默认/分类.md"]')!;
  fireEvent.click(taskFile);
  expect(callbacks.select).toHaveBeenCalledWith(task.children[0].children[0]);
  fireEvent.keyDown(taskFile, { key: "F2" });
  expect(callbacks.onBeginRename).toHaveBeenCalledWith("任务/默认/分类.md");

  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(container.querySelector('[data-tree-path="笔记.md"]')!, { dataTransfer: transfer });
  fireEvent.drop(toggle, { dataTransfer: transfer });
  expect(callbacks.onMove).not.toHaveBeenCalled();
  fireEvent.dragStart(container.querySelector('[data-tree-path="笔记.md"]')!, { dataTransfer: transfer });
  const destination = container.querySelector('[data-tree-path="日记"]')!;
  fireEvent.dragOver(destination, { dataTransfer: transfer });
  fireEvent.drop(destination, { dataTransfer: transfer });
  expect(callbacks.onMove).toHaveBeenCalledWith("笔记.md", "日记");
});

it("只有任务与日记目录时也能展开，普通同名文件留在文件树", () => {
  const daily = entry("日记", true), sameNameFile = entry("日记", false);
  const callbacks = props([daily]);
  const { rerender } = render(<FileTree {...callbacks} />);
  expect(screen.getByRole("button", { name: "任务与日记" }).getAttribute("aria-expanded")).toBe("false");

  rerender(<FileTree {...callbacks} entries={[sameNameFile]} />);
  expect(screen.queryByRole("button", { name: "任务与日记" })).toBeNull();
  expect(screen.getByRole("button", { name: "日记" })).toBeTruthy();
});
