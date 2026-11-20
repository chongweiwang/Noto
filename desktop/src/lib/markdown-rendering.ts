import type {Root,RootContent} from "hast";
import katex from "katex";
import {textOf} from "./heading-ids";
export {textOf,rehypeHeadingIds} from "./heading-ids";

// Surface invalid formulas explicitly instead of silently substituting red text.
export function rehypeMathErrors() {
  return (tree: Root) => {
    function visit(node: RootContent) {
      if (node.type !== "element") return;
      const classes = node.properties.className;
      if (node.tagName === "code" && Array.isArray(classes) && (classes.includes("math-inline") || classes.includes("math-display"))) {
        const source = textOf(node);
        try { katex.renderToString(source, { displayMode: classes.includes("math-display"), throwOnError: true, trust: false }); }
        catch (cause) {
          node.properties.className = ["rich-error", "katex-error"];
          node.children = [{ type: "text", value: `公式无法渲染：${cause instanceof Error ? cause.message : String(cause)}\n${source}` }];
        }
      } else node.children.forEach(visit);
    }
    tree.children.forEach(visit);
  };
}
