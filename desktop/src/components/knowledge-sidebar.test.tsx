// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useKnowledgeSnapshot } from "./knowledge-sidebar";

const read = vi.hoisted(() => vi.fn());
vi.mock("../lib/desktop-api", () => ({ desktop: { read } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("切换知识库后不会展示旧扫描任务的结果", async () => {
  let finishOld!: (value: { path: string; content: string; version: string }) => void;
  const old = new Promise<{ path: string; content: string; version: string }>((resolve) => { finishOld = resolve; });
  read.mockImplementation((path: string) => path === "旧.md" ? old : Promise.resolve({ path, content: "新知识库", version: "v2" }));
  const { result, rerender } = renderHook(({ vault, paths }) => useKnowledgeSnapshot(vault, paths, true, 0), { initialProps: { vault: "旧库", paths: ["旧.md"] } });
  await waitFor(() => expect(read).toHaveBeenCalledWith("旧.md"));
  rerender({ vault: "新库", paths: ["新.md"] });
  await waitFor(() => expect(result.current.notes.map((item) => item.path)).toEqual(["新.md"]));
  await act(async () => { finishOld({ path: "旧.md", content: "旧知识库", version: "v1" }); await old; });
  expect(result.current.notes.map((item) => item.path)).toEqual(["新.md"]);
});

it("切换操作开始后立即丢弃旧任务，取消切换后可重新扫描", async () => {
  let finishOld!: (value: { path: string; content: string; version: string }) => void;
  const old = new Promise<{ path: string; content: string; version: string }>((resolve) => { finishOld = resolve; });
  read.mockReturnValueOnce(old).mockResolvedValue({ path: "笔记.md", content: "重新读取", version: "v2" });
  const generation = { current: 0 };
  const { result, rerender } = renderHook(({ revision }) => useKnowledgeSnapshot("知识库", ["笔记.md"], true, revision, generation), { initialProps: { revision: 0 } });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  generation.current++;
  await act(async () => { finishOld({ path: "笔记.md", content: "过期内容", version: "v1" }); await old; });
  expect(result.current.notes).toEqual([]);
  rerender({ revision: 1 });
  await waitFor(() => expect(result.current.notes[0]?.content).toBe("重新读取"));
});

it("同一知识库保存后刷新时保留已有扫描结果", async () => {
  read.mockResolvedValueOnce({ path: "任务/工作.md", content: "已有分类", version: "v1" });
  let finish!: (value: { path: string; content: string; version: string }) => void;
  const next = new Promise<{ path: string; content: string; version: string }>((resolve) => { finish = resolve; });
  const { result, rerender } = renderHook(({ revision }) => useKnowledgeSnapshot("知识库", ["任务/工作.md"], true, revision), { initialProps: { revision: 0 } });
  await waitFor(() => expect(result.current.notes[0]?.content).toBe("已有分类"));
  read.mockReturnValueOnce(next);
  rerender({ revision: 1 });
  expect(result.current.loading).toBe(true);
  expect(result.current.notes[0]?.content).toBe("已有分类");
  await act(async () => { finish({ path: "任务/工作.md", content: "保存后的分类", version: "v2" }); await next; });
  expect(result.current.notes[0]?.content).toBe("保存后的分类");
});
