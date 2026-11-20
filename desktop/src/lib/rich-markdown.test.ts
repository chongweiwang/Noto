import { expect, it } from "vitest";
import { parseRichMarkdown } from "./rich-markdown";

it("解析公式和 Mermaid，但不解析代码或转义美元符号", () => {
  const source = ["行内 $x_1$，\\$5 和 `$code$`。", "", "$$", "a+b", "$$", "", "$$c^2$$", "", "```mermaid", "graph TD", "A-->B", "```", "", "```text", "$no$", "```"].join("\n");
  const ranges = parseRichMarkdown(source);
  expect(ranges.map(({ kind, value }) => [kind, value])).toEqual([
    ["inlineMath", "x_1"], ["math", "a+b"], ["math", "c^2"], ["mermaid", "graph TD\nA-->B"],
  ]);
  expect(ranges.map(({ from, to }) => source.slice(from, to))).toEqual(["$x_1$", "$$\na+b\n$$", "$$c^2$$", "```mermaid\ngraph TD\nA-->B\n```"]);
});
