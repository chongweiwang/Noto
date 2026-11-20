import { StateEffect, type EditorState, type Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { liveMarkdownLines, liveMarkdownSize } from "../../lib/document-info";
import { analyzeEditorMarkdown, type DocumentInfo, type EditorMarkdownIndex } from "../../lib/editor-markdown-index";

const indexes = new WeakMap<Text, EditorMarkdownIndex>();
export const documentInfos = new WeakMap<Text, DocumentInfo>();
export const analysisReady = StateEffect.define<null>();

export function setEditorIndex(doc: Text, index: EditorMarkdownIndex) {
  indexes.set(doc, index);
}

export function editorIndex(doc: Text): EditorMarkdownIndex | undefined {
  const cached = indexes.get(doc);
  if (cached || doc.length >= liveMarkdownSize || doc.lines >= liveMarkdownLines) return cached;
  analyzeEditorMarkdown(doc.toString(), message => {
    if (message.type === "index") setEditorIndex(doc, message.index);
  });
  return indexes.get(doc);
}

export function selectionTouches(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some(selection => selection.from <= to && selection.to >= from);
}

export function shouldRender(update: ViewUpdate) {
  return update.docChanged || update.selectionSet || update.viewportChanged ||
    update.transactions.some(transaction => transaction.effects.some(effect => effect.is(analysisReady)));
}
