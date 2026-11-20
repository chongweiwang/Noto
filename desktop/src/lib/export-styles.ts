
import { exportPapers, type ExportPreset } from "./export-presets";

const printFontSizes = { 14: 10, 16: 11, 18: 13 };

// Page structure and print layout adapted from Noteriv pdf-export.ts / publish.ts.
export function exportStyles({ paper, orientation, margin, fontSize }: ExportPreset) {
  const [width, height] = exportPapers[paper];
  const printableHeight = (orientation === "landscape" ? width : height) - 2 * margin;
  return `
@page { size:${paper} ${orientation}; margin:${margin}mm; }
* { box-sizing:border-box; }
html { color-scheme:light; background:white; color:#202124; }
body { margin:0 auto; padding:32px; max-width:880px; font:${fontSize}px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","Noto Sans CJK SC",sans-serif; overflow-wrap:anywhere; }
.export-note-embed { margin:1em 0; padding:.8em; border:1px solid #ccd0d8; border-radius:6px; }
.export-drawing-embed { margin:1em 0; padding:.8em; border:1px solid #ccd0d8; border-radius:6px; }
.export-drawing-embed figcaption { color:#555; font-size:.9em; }
.export-drawing-image { display:block; max-width:100%; height:auto; margin:.5em auto 0; }
h1,h2,h3,h4,h5,h6 { line-height:1.35; margin:1.4em 0 .55em; break-after:avoid; }
h1 { font-size:2em; } h2 { font-size:1.5em; border-bottom:1px solid #ddd; padding-bottom:.2em; }
p,ul,ol,blockquote,pre,table,figure { margin:.8em 0; }
ul,ol { padding-left:1.7em; } li>p { margin:.35em 0; }
a { color:#2459b0; text-decoration:underline; } blockquote { margin-left:0; padding:.2em 1em; border-left:3px solid #bbb; color:#555; }
code { font-family:Consolas,"Cascadia Code",monospace; font-size:.9em; background:#f3f4f5; padding:.1em .3em; }
pre { padding:14px; background:#f6f7f8; border:1px solid #ddd; border-radius:6px; white-space:pre-wrap; overflow-wrap:anywhere; tab-size:4; }
pre code { padding:0; background:transparent; } table { width:100%; border-collapse:collapse; table-layout:auto; font-size:.95em; }
th,td { border:1px solid #ccc; padding:6px 10px; overflow-wrap:anywhere; } th { background:#f2f3f4; }
img { max-width:100%; height:auto; } .export-diagram { display:block; max-width:100%; margin:1em auto; }
input[type=checkbox] { margin-right:.45em; } .task-list-item { list-style:none; }
.export-warning,.rich-error { white-space:pre-wrap; color:#9b2e24; background:#fff4ee; padding:.5em; border:1px solid #e8c3b5; }
.export-target { color:#666; border-bottom:1px dotted #999; } .export-target-note { margin-left:.3em; color:#666; font-size:.85em; } .katex-display { overflow-wrap:normal; max-width:100%; }
.hljs-keyword,.hljs-selector-tag,.hljs-built_in { color:#8250df; } .hljs-string,.hljs-attr { color:#0a6036; }
.hljs-comment,.hljs-quote { color:#66716d; } .hljs-number,.hljs-literal { color:#0550ae; } .hljs-title { color:#953800; }
.footnotes { font-size:.85em; border-top:1px solid #ccc; margin-top:2em; }
.markdown-callout { --callout-color:#315f9c; border-left:3px solid var(--callout-color); background:#f5f7fa; padding:.55em .8em; margin:.8em 0; color:#202124; }
.callout-tip { --callout-color:#247546; } .callout-important { --callout-color:#7650a6; } .callout-warning { --callout-color:#9c670d; } .callout-caution { --callout-color:#b22c30; }
.callout-title { font-weight:bold; color:var(--callout-color); }
.export-note-section { margin-top:2rem; padding-top:1rem; border-top:1px solid #ddd; }
@media print {
  body { max-width:none; margin:0; padding:0; font-size:${printFontSizes[fontSize]}pt; }
  h1,h2,h3,h4,h5,h6 { break-after:avoid; }
  p { orphans:3; widows:3; } img { break-inside:avoid; max-height:${printableHeight - 12}mm; object-fit:contain; }
  .export-drawing-embed { break-inside:avoid; }
  .export-note-section { break-before:page; border:0; padding:0; margin:0; }
  .export-drawing-image { max-height:${printableHeight - 37}mm; }
  pre,table,blockquote { break-inside:auto; } thead { display:table-header-group; } tr { break-inside:avoid; }
  pre { overflow:visible; white-space:pre-wrap; } a { color:inherit; }
  * { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
}
`;
}
