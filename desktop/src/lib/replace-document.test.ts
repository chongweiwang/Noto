// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { replaceDocument } from "./replace-document";

describe("外部文件更新", () => {
  it("重新载入后撤销不会把旧内容写回新文件", () => {
    const historyConfig = new Compartment();
    const view = new EditorView({ state: EditorState.create({ doc: "旧文件", extensions: [historyConfig.of(history())] }) });
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "旧编辑" } });
    replaceDocument(view, historyConfig, "外部新版本");
    undo(view);
    expect(view.state.doc.toString()).toBe("外部新版本");
    view.destroy();
  });
});
