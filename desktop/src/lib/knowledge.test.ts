import { describe, expect, it } from "vitest";
import { calendarDays, dailyPath, localDate } from "./calendar";
import { findBacklinks, parseKnowledge, resolveWiki, scanNotes, searchNotes, wikiCompletionAllowed, wikiTargetForPath } from "./knowledge";
import type { Note } from "./desktop-api";

const paths = ["项目/目标.md", "其他/目标.md", "独一.md", "项目/源.md"];
const note = (path: string, content: string): Note => ({ path, content, version: "v1" });

describe("知识库链接规则", () => {
  it("按完整路径定位，遇到同名或越界时不猜测", () => {
    expect(resolveWiki("项目/目标", paths)).toEqual(["项目/目标.md"]);
    expect(resolveWiki("目标", paths)).toEqual(["其他/目标.md", "项目/目标.md"]);
    expect(resolveWiki("独一.md", paths)).toEqual(["独一.md"]);
    expect(resolveWiki("../独一", paths)).toEqual([]);
    expect(resolveWiki("C:/secret", paths)).toEqual([]);
  });

  it("补全可精确引用根目录同名笔记和不同扩展名", () => {
    const duplicates = ["目标.md", "项目/目标.md", "项目/目标.markdown"];
    for (const path of duplicates) expect(resolveWiki(wikiTargetForPath(path, duplicates), duplicates)).toEqual([path]);
    expect(wikiTargetForPath("目标.md", duplicates)).toBe("./目标");
    expect(wikiTargetForPath("项目/目标.markdown", duplicates)).toBe("项目/目标.markdown");
  });

  it("识别别名和标准链接，排除代码、转义、图片与公式", () => {
    const source = ["[[项目/目标|目标笔记]] 与 [普通](目标.md)", "\\[[独一]] `[[独一]]` ![[独一]]", "", "```md", "[[独一]]", "```", "", "$[[独一]]$", "", "[参考][id]", "", "[id]: ../独一.md"].join("\n");
    const parsed = parseKnowledge(source);
    expect(parsed.wiki.map(({ target, label }) => [target, label])).toEqual([["项目/目标", "目标笔记"]]);
    expect(parsed.markdown.map((link) => link.url)).toEqual(["目标.md", "../独一.md"]);
    expect(source.slice(parsed.wiki[0].from, parsed.wiki[0].to)).toBe("[[项目/目标|目标笔记]]");
  });

  it("只从实际目标唯一的已保存链接生成反向链接", () => {
    const notes = [note("项目/源.md", "[[项目/目标]]\n[目标](目标.md)\n[[目标]]\n`[[项目/目标]]`\n\\[[项目/目标]]"), note("独一.md", "[其他](项目/目标.md)")];
    expect(findBacklinks("项目/目标.md", notes, paths).map(({ path, line }) => [path, line])).toEqual([["独一.md", 1], ["项目/源.md", 1], ["项目/源.md", 2]]);
  });

  it("只在普通文本而非代码或转义标记中提供补全", () => {
    for (const source of ["文字 [[", "文字 [[目"]) expect(wikiCompletionAllowed(source, source.indexOf("[["), source.length)).toBe(true);
    for (const source of ["`[[目标`", "\\[[目标", "```md\n[[目标\n```", "![[]]"]) {
      const start = source.indexOf("[[");
      expect(wikiCompletionAllowed(source, start, Math.min(start + 2, source.length))).toBe(false);
    }
  });
});

describe("文件搜索与日历", () => {
  it("搜索中文路径与正文，并保留无法读取文件的反馈", async () => {
    const items = ["项目/计划.md", "坏文件.md"];
    const result = await scanNotes(items, async (path) => {
      if (path === "坏文件.md") throw new Error("无法解码");
      return note(path, "# 标题\n这是中文正文");
    }, () => false);
    expect(searchNotes("中文", result.notes)).toEqual([{ path: items[0], line: 2, snippet: "这是中文正文" }]);
    expect(searchNotes("计划", result.notes)[0].path).toBe(items[0]);
    expect(result.errors).toEqual([{ path: items[1], error: "无法解码" }]);
  });

  it("使用本地日期生成月历与每日笔记路径", () => {
    const grid = calendarDays(2024, 1);
    expect(grid).toHaveLength(42);
    expect(localDate(grid[0])).toBe("2024-01-29");
    expect(grid.map(localDate)).toContain("2024-02-29");
    expect(dailyPath("2024-02-29")).toBe("日记/2024/02/2024-02-29.md");
    expect(dailyPath("2026-01-01")).toBe("日记/2026/01/2026-01-01.md");
    expect(() => dailyPath("2026-02-29")).toThrow("日期无效");
  });
});
