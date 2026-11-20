import { expect, it } from "vitest";
import { imageRenderer } from "./images";

it("识别包含编码括号和普通括号的本地图片路径", () => {
  for (const path of ["attachments/%E5%9B%BE%20%281%29.png", "attachments/图 (1).png"]) {
    const source = `![图](${path})`;
    const [result] = imageRenderer.find(source, 0);
    expect(result.to).toBe(source.length);
    expect(result.html).toContain(path);
  }
  expect(imageRenderer.find("![图\\]片](attachments/image.png)", 0)[0].html).toContain('alt="图]片"');
});
