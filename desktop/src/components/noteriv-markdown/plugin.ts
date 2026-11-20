// Adapted from Noteriv desktop/src/components/markdown/plugin.ts (MIT).
// Cursor-aware Markdown rendering, with math and diagrams in a separate field.
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type EditorState, RangeSetBuilder } from "@codemirror/state";
import { RenderedMarkdownWidget } from "./widget";
import { getBlockRenderers, getInlineRenderers } from "./registry";
import type { BlockContext, InlineReplacement } from "./types";
import { richRanges } from "../../lib/rich-markdown";
import { knowledgeForDoc } from "../../lib/knowledge";

function getCursorLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number;
    const end = state.doc.lineAt(range.to).number;
    for (let line = start; line <= end; line++) lines.add(line);
  }
  return lines;
}

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
  const cursorLines = getCursorLines(view.state);
  const doc = view.state.doc;
  const rich = richRanges(doc);
  const protectedRanges = [...rich, ...knowledgeForDoc(doc).wiki];
  const from = Math.max(1, doc.lineAt(view.viewport.from).number - 50);
  const to = Math.min(doc.lines, doc.lineAt(view.viewport.to).number + 50);
  let fence: string | null = null;
  // Track fenced code before the viewport as well, so its content stays source text.
  for (let number = 1; number <= to; number++) {
    const line = doc.line(number);
    const match = line.text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      continue;
    }
    if (number < from || fence || cursorLines.has(number) || !line.text.trim() || rich.some((range) => range.kind === "math" && range.from <= line.to && range.to >= line.from)) continue;
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
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });
