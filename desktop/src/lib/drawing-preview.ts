import {drawingToSvg} from "./drawing-svg";
import {drawingBytes} from "./drawing-document";
import {base64Text} from "./export-resources";

// Previews are derived from validated drawing elements, never arbitrary SVG.
// Keep the in-memory image bounded without modifying the source document.
export function drawingPreview(source:string):string {
 const svg=drawingToSvg(source);
 if(drawingBytes(svg)>2*1024*1024)throw new Error("白板预览超过 2 MiB，请打开原白板查看");
 return "data:image/svg+xml;base64,"+base64Text(svg);
}
