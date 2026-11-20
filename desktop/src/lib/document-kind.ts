import type {Entry} from "./vault-api";
export const isMarkdown = (path:string) => /\.(md|markdown)$/i.test(path);
export const isCanvas = (path:string) => /\.canvas$/i.test(path);
export const isDrawing = (path:string) => /\.drawing$/i.test(path);
export const isStructuredDocument = (path:string) => isCanvas(path)||isDrawing(path);
export const isDocument = (path:string) => isMarkdown(path)||isStructuredDocument(path);
export const isFileTab = (path:string) => isDocument(path);
export const documentName = (path:string) => isDrawing(path)?"绘图白板":isCanvas(path)?"知识画布":"笔记";
export function documentPaths(entries:Entry[]):string[] {
  return entries.flatMap(entry=>entry.issue?[]:entry.isDirectory?documentPaths(entry.children):isDocument(entry.path)?[entry.path]:[]);
}
export const vaultDragType="application/x-noto-vault-path";
