import { describe, expect, it } from "vitest";
import { calendarHeatmapDays } from "./calendar";
import { documentInfo } from "./document-info";
import { summarizeVaultNotes } from "./vault-statistics";
import type { Note } from "./vault-api";

const note = (path: string, content: string): Note => ({ path, content, version: "1" });

describe("已保存的知识库统计", () => {
  it("贡献热力图用 53 周显示最近 365 天，周一换列、闰日保留", () => {
    const days = calendarHeatmapDays(new Date(2024, 2, 1, 12));
    expect(days).toHaveLength(365);
    expect(days[0]).toEqual({ date: "2023-03-03", week: 0, weekday: 4 });
    expect(days[3]).toEqual({ date: "2023-03-06", week: 1, weekday: 0 });
    expect(days.at(-2)).toEqual({ date: "2024-02-29", week: 52, weekday: 3 });
    expect(days.at(-1)).toEqual({ date: "2024-03-01", week: 52, weekday: 4 });
  });

  it("沿用编辑器字数并按笔记数聚合标签，同篇和大小写变体不重复计数", () => {
    const notes = [note("项目/说明.md", "# 混合文本\nNoto works #NAS/备份 #nas/备份"),
      note("日记/2024/02/2024-02-29.md", "复盘 #nas/备份"),
      note("学习.md", "普通笔记 #学习"), note("空白.md", "")];
    const result = summarizeVaultNotes(notes);
    expect(result.words).toBe(notes.reduce((total, item) => total + documentInfo(item.content).words, 0));
    expect(result).toMatchObject({ tags: 2, taggedNotes: 3, readableNotes: 4, averageWords: Math.round(result.words / 4) });
    expect(result.topTags).toEqual([{ label: "NAS/备份", count: 2 }, { label: "学习", count: 1 }]);
  });

  it("长笔记排行按正文篇幅取前五，空笔记不进入排行", () => {
    const notes = Array.from({ length: 8 }, (_, i) => note(`目录/${i}.md`, "字".repeat(i)));
    const { longestNotes, averageWords, topTags } = summarizeVaultNotes(notes);
    expect(longestNotes).toEqual([7, 6, 5, 4, 3].map(i => ({ path: `目录/${i}.md`, words: i })));
    expect(averageWords).toBe(4);
    expect(topTags).toEqual([]);
  });
});
