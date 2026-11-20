// Adapted from Noteriv desktop/src/components/markdown/plugin.ts (MIT).
// Cursor-aware Markdown rendering, with math and diagrams in a separate field.
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { RenderedMarkdownWidget } from "./widget";
import { getBlockRenderers, getInlineRenderers } from "./registry";
import type { BlockContext, InlineReplacement } from "./types";
import { visibleRanges } from "../../lib/editor-markdown-index";
import { editorIndex, selectionTouches, shouldRender } from "./indexed-document";

function addInlineDecorations(builder: RangeSetBuilder<Decoration>, lineStart: number, text: string, protectedRanges: { from: number; to: number }[]) {
  const replacements: InlineReplacement[] = [];
  for (const renderer of getInlineRenderers()) {
    for (const replacement of renderer.find(text, lineStart)) {
      if (!protectedRanges.some((range) => replacement.from < range.to && replacement.to > range.from) && !replacements.some((existing) => replacement.from < existing.to && replacement.to > existing.from)) {
        replacements.push(replacement);
      }
    }
  }
  replacements.sort((a, b) => a.from - b.from);
  for (const replacement of replacements) {
    builder.add(replacement.from, replacement.to, Decoration.replace({
      widget: new RenderedMarkdownWidget(replacement.html, replacement.className),
    }));
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const index = editorIndex(doc);
  if (!index) return Decoration.none;
  const from = Math.max(1, doc.lineAt(view.viewport.from).number - 50);
  const to = Math.min(doc.lines, doc.lineAt(view.viewport.to).number + 50);
  const start = doc.line(from).from, end = doc.line(to).to;
  const rich = visibleRanges(index.rich, start, end);
  const protectedRanges = [...rich, ...visibleRanges(index.wiki, start, end)];
  const fences = visibleRanges(index.fences, start, end);
  for (let number = from; number <= to; number++) {
    const line = doc.line(number);
    if (selectionTouches(view.state, line.from, line.to) || !line.text.trim() ||
        fences.some(range => range.from <= line.to && range.to >= line.from) ||
        rich.some(range => range.kind === "math" && range.from <= line.to && range.to >= line.from)) continue;
    const context: BlockContext = { builder, line, text: line.text, lineNumber: number };
    let handled = false;
    for (const renderer of getBlockRenderers()) {
      if (renderer.process(context)) {
        handled = true;
        const inline = renderer.getContent?.(line.text);
        if (inline) addInlineDecorations(builder, line.from + inline.offset, inline.content, protectedRanges);
        break;
      }
    }
    if (!handled) addInlineDecorations(builder, line.from, line.text, protectedRanges);
  }
  return builder.finish();
}

export const liveMarkdownPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildDecorations(view); }
  update(update: ViewUpdate) {
    if (shouldRender(update)) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });
