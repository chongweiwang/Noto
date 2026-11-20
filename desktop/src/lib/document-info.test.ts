import { expect, it } from "vitest";
import { documentInfo } from "./document-info";

it("从 Markdown 语法树提取 ATX 与 setext 标题，并按实际级别形成父子关系", () => {
  const source = "# 第一章 **基础**\n\n### 跳级 `标题`\n\n正文\n\n子节\n---\n\n```md\n# 代码示例不是标题\n```\n\n# 第二章\n";
  const { headings } = documentInfo(source);
  expect(headings.map(({ text, level, parent, from }) => [text, level, parent, source.slice(from).split("\n")[0]])).toEqual([
    ["第一章 基础", 1, null, "# 第一章 **基础**"], ["跳级 标题", 3, 0, "### 跳级 `标题`"],
    ["子节", 2, 0, "子节"], ["第二章", 1, null, "# 第二章"],
  ]);
});

it("字数排除 Markdown 标记和地址，字符数按 Unicode 计算", () => {
  const source = "# 中文 **测试**\n\nHello world [说明](https://example.com/path) 😀";
  const info = documentInfo(source);
  expect(info.words).toBe(8);
  expect(info.characters).toBe(Array.from(source).length);
  expect(info.lines).toBe(3);
  expect(documentInfo("").words).toBe(0);
});
