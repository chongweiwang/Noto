// Cursor-aware block rendering follows Noteriv's math and Mermaid widgets.
import { StateField, RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import katex from "katex";
import type { RichRange } from "../../lib/rich-markdown";
import { renderMermaid } from "../../lib/mermaid";
import { analysisReady, editorIndex } from "./indexed-document";

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

function decorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of editorIndex(state.doc)?.rich ?? []) {
    // Block replacements cannot start inside a list marker or other text.
    const nestedBlock = range.kind !== "inlineMath" && state.doc.sliceString(state.doc.lineAt(range.from).from, range.from).trim().length > 0;
    if (!nestedBlock) builder.add(range.from, range.to, Decoration.replace({ widget: new RichWidget(range), block: range.kind !== "inlineMath" }));
  }
  return builder.finish();
}

function selectedLines(state: EditorState) {
  return state.selection.ranges.map(range => ({ from: state.doc.lineAt(range.from).from, to: state.doc.lineAt(range.to).to }));
}

function hideInSelectedLines(base: DecorationSet, lines: ReturnType<typeof selectedLines>) {
  // RangeSet skips unaffected chunks. Keep one set of widgets per document,
  // including block widgets whose heights CodeMirror tracks outside the viewport.
  let visible = base;
  for (const { from, to } of lines) {
    visible = visible.update({ filterFrom: from, filterTo: to, filter: (start, end) => end < from || start > to });
  }
  return visible;
}

export const richMarkdownField = StateField.define<{ base: DecorationSet; visible: DecorationSet; lines: ReturnType<typeof selectedLines> }>({
  create(state) {
    const base = decorations(state), lines = selectedLines(state);
    return { base, lines, visible: hideInSelectedLines(base, lines) };
  },
  update(value, transaction) {
    const changed = transaction.docChanged || transaction.effects.some(effect => effect.is(analysisReady));
    if (!changed && !transaction.selection) return value;
    const lines = selectedLines(transaction.state);
    if (!changed && lines.length === value.lines.length &&
        lines.every((line, i) => line.from === value.lines[i].from && line.to === value.lines[i].to)) return value;
    const base = changed ? decorations(transaction.state) : value.base;
    return { base, lines, visible: hideInSelectedLines(base, lines) };
  },
  provide: (field) => EditorView.decorations.from(field, value => value.visible),
});
