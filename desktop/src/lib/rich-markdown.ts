import type { Text } from "@codemirror/state";
import type { Root } from "mdast";
import type { VFile } from "vfile";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type Node = { type: string; value?: string; lang?: string | null; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
export type RichRange = { from: number; to: number; kind: "inlineMath" | "math" | "mermaid"; value: string };

// remark-math treats a standalone $$x$$ as inline math. Make this common
// spelling a display formula in both the preview and CodeMirror.
function normalizeDisplayMath(node: Node, source: string) {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    if (child.type === "paragraph" && child.children?.length === 1) {
      const math = child.children[0];
      const from = math.position?.start.offset, to = math.position?.end.offset;
      if (math.type === "inlineMath" && from !== undefined && to !== undefined && /^\$\$[^\n]*\$\$$/.test(source.slice(from, to))) {
        return { ...math, type: "math", position: child.position, data: { hName: "pre", hChildren: [{ type: "element", tagName: "code", properties: { className: ["language-math", "math-display"] }, children: [{ type: "text", value: math.value ?? "" }] }] } };
      }
    }
    normalizeDisplayMath(child, source);
    return child;
  });
}

export function remarkDisplayMath() {
  return (tree: Root, file: VFile) => normalizeDisplayMath(tree as unknown as Node, String(file.value));
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export function parseRichMarkdown(source: string): RichRange[] {
  const tree = parser.parse(source) as unknown as Node;
  normalizeDisplayMath(tree, source);
  const ranges: RichRange[] = [];
  function visit(node: Node) {
    const from = node.position?.start.offset, to = node.position?.end.offset;
    const kind = node.type === "inlineMath" || node.type === "math" ? node.type :
      node.type === "code" && node.lang?.toLowerCase() === "mermaid" ? "mermaid" : null;
    if (kind && from !== undefined && to !== undefined) ranges.push({ from, to, kind, value: node.value ?? "" });
    else node.children?.forEach(visit);
  }
  visit(tree);
  return ranges;
}

const cache = new WeakMap<Text, RichRange[]>();
export function richRanges(doc: Text): RichRange[] {
  let result = cache.get(doc);
  if (!result) { result = parseRichMarkdown(doc.toString()); cache.set(doc, result); }
  return result;
}
