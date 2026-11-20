// Cursor-aware block rendering follows Noteriv's math and Mermaid widgets.
import { StateField, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import katex from "katex";
import { richRanges, type RichRange } from "../../lib/rich-markdown";
import { renderMermaid } from "../../lib/mermaid";

class RichWidget extends WidgetType {
  constructor(readonly range: RichRange) { super(); }
  eq(other: RichWidget) { return this.range.kind === other.range.kind && this.range.value === other.range.value && this.range.from === other.range.from; }
  toDOM(view: EditorView) {
    const block = this.range.kind !== "inlineMath";
    const element = document.createElement(block ? "div" : "span");
    element.className = this.range.kind === "mermaid" ? "mermaid-diagram live-rich-widget" : "math-widget live-rich-widget";
    element.title = "点击编辑源码";
    element.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.range.from }, scrollIntoView: true });
      view.focus();
    });
    const showError = (cause: unknown) => {
      element.classList.add("rich-error");
      element.textContent = `${this.range.kind === "mermaid" ? "Mermaid 图表" : "公式"}无法渲染：${cause instanceof Error ? cause.message : String(cause)}\n${this.range.value}`;
    };
    if (this.range.kind === "mermaid") {
      element.textContent = "正在渲染图表…";
      void renderMermaid(this.range.value).then((svg) => { if (element.isConnected) { element.innerHTML = svg; view.requestMeasure(); } })
        .catch((cause) => { if (element.isConnected) { showError(cause); view.requestMeasure(); } });
    } else {
      try { katex.render(this.range.value, element, { displayMode: block, throwOnError: true, trust: false }); }
      catch (cause) { showError(cause); }
    }
    return element;
  }
  ignoreEvent() { return false; }
}

function decorations(view: { state: import("@codemirror/state").EditorState }): DecorationSet {
  const { state } = view;
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of richRanges(state.doc)) {
    const firstLine = state.doc.lineAt(range.from), lastLine = state.doc.lineAt(range.to);
    const active = state.selection.ranges.some((selection) => selection.from <= lastLine.to && selection.to >= firstLine.from);
    // Block replacements cannot start inside a list marker or other text.
    const nestedBlock = range.kind !== "inlineMath" && state.doc.sliceString(firstLine.from, range.from).trim().length > 0;
    if (!active && !nestedBlock) builder.add(range.from, range.to, Decoration.replace({ widget: new RichWidget(range), block: range.kind !== "inlineMath" }));
  }
  return builder.finish();
}

export const richMarkdownField = StateField.define<DecorationSet>({
  create: (state) => decorations({ state }),
  update: (value, transaction) => transaction.docChanged || transaction.selection ? decorations({ state: transaction.state }) : value,
  provide: (field) => EditorView.decorations.from(field),
});
