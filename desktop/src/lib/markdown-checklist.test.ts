import { expect, it } from "vitest";
import { checkboxOffset, insertMarkdownTask, setMarkdownCheckbox } from "./markdown-checklist";

it("仅更新指定复选框的状态字符", () => {
  const source = "- [ ] 重复\n- [ ] 重复\n";
  const at = checkboxOffset(source, source.indexOf("\n") + 1)!;
  expect(setMarkdownCheckbox(source, at, true)).toBe("- [ ] 重复\n- [x] 重复\n");
  expect(checkboxOffset("1. [X] 步骤", 0)).toBe(4);
  expect(() => setMarkdownCheckbox("已变化", at, true)).toThrow("已变化");
});

it("工具栏为当前行或选中的列表插入任务框，不重复已有任务框", () => {
  expect(insertMarkdownTask("", 0, 0)).toEqual({ content: "- [ ] ", cursor: 6 });
  expect(insertMarkdownTask("\n后文", 0, 0).content).toBe("- [ ] \n后文");
  const source = "  - 步骤一\n  - [x] 步骤二";
  expect(insertMarkdownTask(source, 0, source.length).content).toBe("  - [ ] 步骤一\n  - [x] 步骤二");
});
