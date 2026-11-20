import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { copyText } from "../lib/ui-actions";

const parser = unified().use(remarkParse);
export function markdownCodeBlocks(source: string): { from: number; value: string }[] {
  const blocks: { from: number; value: string }[] = [];
  function visit(node: { type: string; value?: string; children?: unknown[]; position?: { start: { offset?: number } } }) {
    if (node.type === "code" && node.position?.start.offset !== undefined) blocks.push({ from: node.position.start.offset, value: node.value ?? "" });
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  }
  visit(parser.parse(source)); return blocks;
}
class CopyWidget extends WidgetType {
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly value: string) { super(); }
  eq(other: CopyWidget) { return this.value === other.value; }
  toDOM() {
    const button = document.createElement("button"); button.type = "button"; button.className = "cm-code-copy"; button.textContent = "复制代码"; button.setAttribute("aria-label", "复制代码块");
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void copyText(this.value).then((ok) => { if (!button.isConnected) return; button.textContent = ok ? "已复制" : "手动复制"; this.timer = setTimeout(() => { button.textContent = "复制代码"; }, 1600); }); });
    return button;
  }
  ignoreEvent() { return true; }
  destroy() { if (this.timer) clearTimeout(this.timer); }
}
export const codeCopyPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  build(view: EditorView) {
    return Decoration.set(markdownCodeBlocks(view.state.doc.toString()).map((block) => Decoration.widget({ widget: new CopyWidget(block.value), side: -1 }).range(block.from)));
  }
  update(update: { docChanged: boolean; view: EditorView }) { if (update.docChanged) this.decorations = this.build(update.view); }
}, { decorations: (plugin) => plugin.decorations });
