import type { Paragraph, PhrasingContent, Root } from "mdast";

const kinds: Record<string, [string, string]> = {
  note: ["note", "备注"], info: ["note", "信息"], abstract: ["note", "摘要"], summary: ["note", "摘要"], tldr: ["note", "摘要"],
  tip: ["tip", "提示"], hint: ["tip", "提示"], important: ["important", "重要"], success: ["tip", "完成"], check: ["tip", "完成"],
  question: ["warning", "问题"], help: ["warning", "帮助"], faq: ["warning", "常见问题"],
  warning: ["warning", "警告"], attention: ["warning", "注意"], caution: ["caution", "小心"],
  danger: ["caution", "危险"], error: ["caution", "错误"], failure: ["caution", "失败"], bug: ["caution", "缺陷"],
  example: ["important", "示例"], quote: ["note", "引用"], cite: ["note", "引用"], todo: ["note", "待办"],
};

export function calloutMarker(text: string) {
  const match = /^\[!([a-z][a-z0-9-]*)\]([+-]?)[ \t]*/i.exec(text);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const [kind, label] = Object.hasOwn(kinds, type) ? kinds[type] : ["note", match[1].toUpperCase()];
  return { length: match[0].length, kind, label, fold: match[2] };
}

export function remarkCallouts() {
  return (root: Root) => {
    function visit(parent: { children: unknown[] }) {
      for (const node of parent.children as Root["children"]) {
        if (node.type === "blockquote") {
          const paragraph = node.children[0];
          const first = paragraph?.type === "paragraph" ? paragraph.children[0] : null;
          const marker = first?.type === "text" ? calloutMarker(first.value) : null;
          if (marker && first?.type === "text" && paragraph.type === "paragraph") {
            const title: PhrasingContent[] = [], body: PhrasingContent[] = [];
            let reachedBody = false;
            for (const [index, child] of paragraph.children.entries()) {
              if (reachedBody) { body.push(child); continue; }
              if (child.type === "break") { reachedBody = true; continue; }
              if (child.type !== "text") { title.push(child); continue; }
              const text = index === 0 ? child.value.slice(marker.length) : child.value;
              const line = text.indexOf("\n");
              if (line < 0) {
                if (text) title.push({ type: "text", value: text });
              } else {
                if (line > 0) title.push({ type: "text", value: text.slice(0, line) });
                if (line + 1 < text.length) body.push({ type: "text", value: text.slice(line + 1) });
                reachedBody = true;
              }
            }
            const heading: Paragraph = {
              type: "paragraph",
              data: { hName: marker.fold ? "summary" : "div", hProperties: { className: ["callout-title"] } },
              children: title.length ? title : [{ type: "text", value: marker.label }],
            };
            node.data = { hName: marker.fold ? "details" : "blockquote", hProperties: {
              className: ["markdown-callout", "callout-" + marker.kind], ...(marker.fold === "+" ? { open: true } : {}),
            } };
            node.children.splice(0, 1, heading, ...(body.length ? [{ ...paragraph, children: body }] : []));
          }
        }
        if ("children" in node) visit(node);
      }
    }
    visit(root);
  };
}
