import { expect, it } from "vitest";
import { renderMermaid } from "./mermaid";

it("拒绝图表中的外部资源、链接和配置指令", async () => {
  for (const source of ['graph TD\nA[图] --> B[https://example.com]', 'graph TD\nclick A "javascript:alert(1)"', '%%{init: {"securityLevel":"loose"}}%%\ngraph TD\nA-->B']) {
    await expect(renderMermaid(source)).rejects.toThrow("暂不支持");
  }
});
