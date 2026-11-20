import type {Element,ElementContent,Root,RootContent} from "hast";
export const headingBase=(text:string)=>text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu,"").replace(/\s+/g,"-")||"section";

export function textOf(node: ElementContent | Element): string {
  return node.type === "text" ? node.value : "children" in node ? node.children.map(textOf).join("") : "";
}

export function rehypeHeadingIds() {
  return (tree: Root) => {
    const headings = new Map<string, number>(), used = new Set<string>();
    function reserve(node: RootContent) {
      if (node.type !== "element") return;
      if (node.properties.id) used.add(String(node.properties.id));
      node.children.forEach(reserve);
    }
    tree.children.forEach(reserve);
    function visit(node: RootContent) {
      if (node.type !== "element") return;
      if (/^h[1-6]$/.test(node.tagName)) {
        if (node.position?.start.offset !== undefined) node.properties["data-heading-from"] = node.position.start.offset;
        if (node.properties.id) { node.children.forEach(visit); return; }
        const base = headingBase(textOf(node));
        let count = headings.get(base) ?? 0, id = count ? `${base}-${count}` : base;
        while (used.has(id)) { count++; id = `${base}-${count}`; }
        headings.set(base, count + 1); used.add(id); node.properties.id = id;
      }
      node.children.forEach(visit);
    }
    tree.children.forEach(visit);
  };
}
