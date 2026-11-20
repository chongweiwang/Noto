import { describe, expect, it } from "vitest";
import { calendarHeatmapDays, dateFromDailyPath } from "./calendar";
import { documentInfo } from "./document-info";
import { journalTrend, summarizeVaultNotes } from "./vault-statistics";
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

  it("沿用编辑器字数，标签大小写去重，日记须匹配真实日期目录", () => {
    const notes = [note("项目/说明.md", "# 混合文本\nNoto works #NAS/备份"),
      note("日记/2024/02/2024-02-29.md", "复盘 #nas/备份"),
      note("项目/日记/2024/02/2024-02-29.md", "普通笔记 #学习")];
    const result = summarizeVaultNotes(notes);
    expect(result.words).toBe(notes.reduce((total, item) => total + documentInfo(item.content).words, 0));
    expect(result.tags).toBe(2);
    expect([...result.journal.keys()]).toEqual(["2024-02-29"]);
    expect(dateFromDailyPath("日记/2023/02/2023-02-29.md")).toBeNull();
    expect(dateFromDailyPath("日记/2024/03/2024-02-29.md")).toBeNull();
  });

  it("周、月、年趋势按本地日期跨年补零，未来日记不计入趋势", () => {
    const { journal } = summarizeVaultNotes([
      note("日记/2025/12/2025-12-31.md", "总结"),
      note("日记/2026/01/2026-01-01.md", "新年计划"),
      note("日记/2026/01/2026-01-03.md", "明天"),
    ]);
    const today = new Date(2026, 0, 2, 12);
    const week = journalTrend(journal, today, "week");
    expect(week).toHaveLength(7);
    expect(week.slice(-3)).toEqual([{ date: "2025-12-31", words: 2 }, { date: "2026-01-01", words: 4 }, { date: "2026-01-02", words: 0 }]);
    expect(journalTrend(journal, today, "month")).toHaveLength(30);
    expect(journalTrend(journal, today, "year").slice(-2)).toEqual([{ date: "2025-12", words: 2 }, { date: "2026-01", words: 4 }]);
  });
});
