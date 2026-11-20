import { describe, expect, it, vi } from "vitest";
import { organizeLegacyVault, RelocationError, relocateNotes, rewriteNoteLinks } from "./relocate-notes";
import { taskCategoryMarker } from "./tasks";
import { MemoryVault } from "../test/memory-vault";

describe("目录结构调整", () => {
  it("普通笔记跨目录移动保留共享附件，更新出链、入链和仅存在于草稿中的链接", async () => {
    const api = new MemoryVault();
    api.put("项目/笔记.md", '[需求](需求.md#说明) ![图](attachments/a%20%281%29.png "图注")');
    api.put("项目/需求.md", "说明"); api.put("项目/attachments/a (1).png", "图片内容");
    api.put("同事.md", "![共享](项目/attachments/a%20%281%29.png)");
    api.put("首页.md", "[[项目/笔记|笔记]] [笔记](项目/笔记.md#标题)");
    const base = api.put("草稿.md", "尚无链接");
    api.stored.set(base.path, { path: base.path, baseVersion: base.version, content: "草稿 [[项目/笔记]]" });
    const result = await relocateNotes([{ from: "项目/笔记.md", to: "归档/笔记.md" }], api);
    expect(decodeURIComponent(api.notes.get("归档/笔记.md")!.content)).toBe('[需求](../项目/需求.md#说明) ![图](../项目/attachments/a (1).png "图注")');
    expect(decodeURIComponent(api.notes.get("首页.md")!.content)).toBe("[[归档/笔记|笔记]] [笔记](归档/笔记.md#标题)");
    expect(api.notes.get("项目/attachments/a (1).png")?.content).toBe("图片内容");
    expect(api.notes.get("同事.md")?.content).toBe("![共享](项目/attachments/a%20%281%29.png)");
    expect(api.stored.get(base.path)?.content).toBe("草稿 [[归档/笔记]]");
    expect(api.notes.get(`${result.backup}/恢复草稿/草稿.md`)?.content).toContain("草稿 [[项目/笔记]]");
    expect(api.notes.get(`${result.backup}/迁移说明.md`)?.content).toContain("状态：已完成");
  });

  it("改名引入同名笔记时将原有无歧义 Wiki 链接固定到原目标", async () => {
    const api = new MemoryVault();
    api.put("甲/目标.md", "甲"); api.put("乙/新建.md", "乙"); api.put("首页.md", "[[目标]] [[乙/新建|乙]]");
    await relocateNotes([{ from: "乙/新建.md", to: "乙/目标.md" }], api);
    expect(api.notes.get("首页.md")?.content).toBe("[[甲/目标]] [[乙/目标|乙]]");
  });

  it("附件重命名更新图片和链接定义，文件夹移动保留内部相对引用原文", async () => {
    const api = new MemoryVault();
    const original = '![图](attachments/a.png) [文件][id]\n\n[id]: <attachments/a.png> "原题"';
    api.put("项目/笔记.md", original); api.put("项目/attachments/a.png", "图片内容");
    await relocateNotes([{ from: "项目", to: "归档/项目" }], api);
    expect(api.notes.get("归档/项目/笔记.md")?.content).toBe(original);
    await relocateNotes([{ from: "归档/项目/attachments/a.png", to: "归档/项目/attachments/b.png" }], api);
    expect(api.notes.get("归档/项目/笔记.md")?.content).toContain('![图](attachments/b.png)');
    expect(api.notes.get("归档/项目/笔记.md")?.content).toContain('[id]: <attachments/b.png> "原题"');
  });

  it("目标只有孤立草稿时仍拒绝迁入，目标文件与来源文件不受影响", async () => {
    const api = new MemoryVault(); api.put("原文.md", "原文");
    api.stored.set("归档/原文.md", { path: "归档/原文.md", content: "孤立草稿", baseVersion: "old" });
    await expect(relocateNotes([{ from: "原文.md", to: "归档/原文.md" }], api)).rejects.toThrow("目标有恢复草稿");
    expect(api.notes.get("原文.md")?.content).toBe("原文"); expect(api.notes.has("归档/原文.md")).toBe(false);
  });

  it("移动后更新入链失败时保留原文备份及进度，不重复移动或覆盖外部内容", async () => {
    const api = new MemoryVault(); api.put("原文.md", "正文"); api.put("首页.md", "[[原文]]");
    const save = api.save;
    api.save = vi.fn(async (path, content, version) => { if (path === "首页.md") throw new Error("磁盘写入失败"); return save(path, content, version); });
    let failure: RelocationError | undefined;
    try { await relocateNotes([{ from: "原文.md", to: "归档/改名.md" }], api); } catch (error) { if (!(error instanceof RelocationError)) throw error; failure = error; }
    expect(failure?.completedMoves).toEqual([{ from: "原文.md", to: "归档/改名.md" }]);
    expect(api.notes.get("归档/改名.md")?.content).toBe("正文"); expect(api.notes.get("首页.md")?.content).toBe("[[原文]]");
    expect(api.notes.get(`${failure!.backup}/原文/首页.md`)?.content).toBe("[[原文]]");
    expect(api.notes.get(`${failure!.backup}/迁移说明.md`)?.content).toContain("状态：未完成：磁盘写入失败");
    expect(api.notes.get(`${failure!.backup}/迁移说明.md`)?.content).toContain("- [x] 原文.md → 归档/改名.md");
  });

  it("备份失败不移动原文件，非法路径和移入自身在任何写入前拒绝", async () => {
    const api = new MemoryVault(); api.put("项目/笔记.md", "正文");
    await expect(relocateNotes([{ from: "项目", to: "项目/嵌套" }], api)).rejects.toThrow("自身内部");
    await expect(relocateNotes([{ from: "项目", to: "../外部" }], api)).rejects.toThrow("路径无效");
    api.createNote = vi.fn(async () => { throw new Error("备份目录只读"); });
    await expect(relocateNotes([{ from: "项目", to: "归档" }], api)).rejects.toThrow("备份目录只读");
    expect(api.notes.get("项目/笔记.md")?.content).toBe("正文"); expect(api.notes.has("归档/笔记.md")).toBe(false);
  });

  it("迁移旧分类和年月日记，改写入链、备注及定义，备份原文并迁移草稿", async () => {
    const api = new MemoryVault();
    const old = "任务/工作.md", target = "任务/默认/工作.md", diary = "日记/2026-11-13.md";
    const original = `${taskCategoryMarker}\n\n# 工作\n\n- [ ] 看文档\n  - 备注：[需求](../项目/需求.md) 和 ![图](附件/a.png)\n`;
    const base = api.put(old, original);
    api.put(diary, "# 日记\n\n[任务](../任务/工作.md#工作)\n");
    api.put("首页.md", `[[任务/工作|工作任务]] [日记](${diary})\n\n[文件][id]\n\n[id]: <任务/工作.md> "保留标题"\n`);
    api.put("任务/普通.md", "# 只有普通复选框\n\n- [ ] 普通笔记\n");
    api.put("日记/2026-02-30.md", "不是合法日记日期");
    api.stored.set(old, { path: old, content: original + "\n新草稿 [需求](../项目/需求.md)", baseVersion: base.version });
    const result = await organizeLegacyVault(api);
    expect(result.moves).toHaveLength(2);
    expect(api.notes.has(old)).toBe(false);
    expect(api.notes.get(target)!.content).toContain("../../%E9%A1%B9%E7%9B%AE/%E9%9C%80%E6%B1%82.md");
    expect(api.notes.get(target)!.content).toContain("../%E9%99%84%E4%BB%B6/a.png");
    expect(decodeURIComponent(api.notes.get("日记/2026/11/2026-11-13.md")!.content)).toContain("../../../任务/默认/工作.md#工作");
    expect(decodeURIComponent(api.notes.get("首页.md")!.content)).toContain("[[任务/默认/工作|工作任务]]");
    expect(decodeURIComponent(api.notes.get("首页.md")!.content)).toContain('[id]: <任务/默认/工作.md> "保留标题"');
    expect(api.notes.get(`${result.backup}/原文/${old}`)?.content).toBe(original);
    expect(api.notes.has("任务/普通.md")).toBe(true);
    expect(api.notes.has("日记/2026-02-30.md")).toBe(true);
    expect(api.stored.has(old)).toBe(false);
    expect(api.stored.get(target)?.baseVersion).toBe(api.notes.get(target)?.version);
    expect(decodeURIComponent(api.stored.get(target)!.content)).toContain("新草稿 [需求](../../项目/需求.md)");
    expect((await organizeLegacyVault(api)).moves).toEqual([]);
  });

  it("按分组移动文件夹，保留附件及组内链接，更新外部入链", async () => {
    const api = new MemoryVault();
    api.put("任务/工作/设计.md", "[附件](assets/a.txt) [同组](实施.md)");
    api.put("任务/工作/实施.md", "# 实施");
    api.put("任务/工作/assets/a.txt", "附件原文");
    api.put("首页.md", "[[任务/工作/设计]]");
    await relocateNotes([{ from: "任务/工作", to: "任务/项目" }], api);
    expect(api.notes.get("任务/项目/assets/a.txt")?.content).toBe("附件原文");
    expect(decodeURIComponent(api.notes.get("任务/项目/设计.md")!.content)).toBe("[附件](assets/a.txt) [同组](实施.md)");
    expect(api.notes.get("首页.md")?.content).toBe("[[任务/项目/设计]]");
  });

  it("已冲突草稿保留原基础版本，无法伪装为可覆盖的新版本", async () => {
    const api = new MemoryVault();
    api.put("日记/2026-01-01.md", "外部新内容");
    api.stored.set("日记/2026-01-01.md", { path: "日记/2026-01-01.md", content: "未保存内容", baseVersion: "old-version" });
    await organizeLegacyVault(api);
    expect(api.stored.get("日记/2026/01/2026-01-01.md")?.baseVersion).toBe("old-version");
    expect(api.notes.get("日记/2026/01/2026-01-01.md")?.content).toBe("外部新内容");
  });

  it("目标已有文件或恢复草稿时拒绝移动，保留来源", async () => {
    const api = new MemoryVault();
    api.put("任务/工作.md", taskCategoryMarker); api.put("任务/默认/工作.md", "新文件");
    await expect(organizeLegacyVault(api)).rejects.toThrow("目标已存在");
    expect(api.notes.get("任务/工作.md")?.content).toBe(taskCategoryMarker);
    api.notes.delete("任务/默认/工作.md");
    api.stored.set("任务/工作.md", { path: "任务/工作.md", content: "旧草稿", baseVersion: "v1" });
    api.stored.set("任务/默认/工作.md", { path: "任务/默认/工作.md", content: "目标草稿", baseVersion: "v2" });
    await expect(organizeLegacyVault(api)).rejects.toThrow("目标有恢复草稿");
    expect(api.notes.has("任务/工作.md")).toBe(true);
  });

  it("备份后出现外部改写时停止迁移并报告备份位置", async () => {
    const api = new MemoryVault(), from = "任务/工作.md";
    api.put(from, taskCategoryMarker);
    const create = api.createNote;
    api.createNote = vi.fn(async (path, content) => { const result = await create(path, content); if (path.endsWith("迁移说明.md")) api.put(from, "外部内容"); return result; });
    await expect(organizeLegacyVault(api)).rejects.toThrow(/外部修改.*备份保留在/);
    expect(api.notes.get(from)?.content).toBe("外部内容");
    expect(api.notes.has("任务/默认/工作.md")).toBe(false);
  });

  it("链接改写保留标题、转义和代码，仅调整目标位置", () => {
    const source = '[**[文档]**](../项目/需求.md "说明") ![图](<../附件/a (1).png>)\n\n`[不改](../项目/需求.md)`\n\n```md\n[[任务/工作]]\n```\n\n[外部](https://example.com) [锚点](#标题)';
    const result = rewriteNoteLinks(source, "任务/工作.md", "任务/默认/工作.md", [{ from: "任务/工作.md", to: "任务/默认/工作.md" }], ["任务/工作.md"]);
    expect(decodeURIComponent(result)).toContain('[**[文档]**](../../项目/需求.md "说明")');
    expect(decodeURIComponent(result)).toContain('![图](<../../附件/a (1).png>)');
    expect(result).toContain('`[不改](../项目/需求.md)`');
    expect(result).toContain('```md\n[[任务/工作]]\n```');
    expect(result).toContain('[外部](https://example.com) [锚点](#标题)');
  });
});
