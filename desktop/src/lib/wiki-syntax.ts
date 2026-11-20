// Link and search rules are independent of Tauri; the desktop and web
// adapters supply the list and contents of the vault's Markdown files.
import type { Text } from "@codemirror/state";
import type { Root } from "mdast";
import type { VFile } from "vfile";
import { decodeString } from "micromark-util-decode-string";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type Node = { type: string; value?: string; url?: string; identifier?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
export type WikiLink = { from: number; to: number; target: string; label: string };
type MarkdownLink = { from: number; url: string };
type Parsed = { wiki: WikiLink[]; markdown: MarkdownLink[]; textRanges: { from: number; to: number }[] };
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const wikiPattern = /\[\[([^\[\]\n]+)\]\]/g;
function wikiInText(source: string, start: number, end: number): WikiLink[] {
  const raw = source.slice(start, end);
  const results: WikiLink[] = [];
  const pattern = new RegExp(wikiPattern.source, wikiPattern.flags);
  for (const match of raw.matchAll(pattern)) {
    const index = match.index;
    const escapes = raw.slice(0, index).match(/\\+$/)?.[0].length ?? 0;
    if (escapes % 2 || raw[index - 1] === "!") continue;
    const inner = decodeString(match[1]);
    const separator = inner.indexOf("|");
    const target = (separator < 0 ? inner : inner.slice(0, separator)).trim();
    const label = (separator < 0 ? target : inner.slice(separator + 1).trim()) || target;
    if (target) results.push({ from: start + index, to: start + index + match[0].length, target, label });
  }
  return results;
}

export function parseKnowledge(source: string, root?: Root): Parsed {
  const tree = (root ?? parser.parse(source)) as unknown as Node;
  const parsed: Parsed = { wiki: [], markdown: [], textRanges: [] };
  const definitions = new Map<string, string>();
  function collectDefinitions(node: Node) {
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    node.children?.forEach(collectDefinitions);
  }
  collectDefinitions(tree);
  function visit(node: Node) {
    const from = node.position?.start.offset, to = node.position?.end.offset;
    if (node.type === "link" || node.type === "linkReference") {
      const url = node.type === "link" ? node.url : definitions.get(node.identifier ?? "");
      if (from !== undefined && url) parsed.markdown.push({ from, url });
      return;
    }
    if (["image", "imageReference", "code", "inlineCode", "math", "inlineMath", "html", "definition"].includes(node.type)) return;
    if (node.type === "text" && from !== undefined && to !== undefined) {
      parsed.textRanges.push({ from, to });
      parsed.wiki.push(...wikiInText(source, from, to));
      return;
    }
    const html: string[] = [];
    for (const child of node.children ?? []) {
      if (child.type === "html") {
        const value = child.value ?? "", closing = value.match(/^<\/([\w:-]+)\s*>$/);
        if (closing) { const index = html.lastIndexOf(closing[1].toLowerCase()); if (index >= 0) html.splice(index); }
        else {
          const opening = value.match(/^<([a-z][\w:-]*)(?:\s|\/?>)/i);
          if (opening && !/\/\s*>$/.test(value) && !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(opening[1])) html.push(opening[1].toLowerCase());
        }
      } else if (!html.length) visit(child);
    }
  }
  visit(tree);
  return parsed;
}

const documentCache = new WeakMap<Text, Parsed>();
export function knowledgeForDoc(doc: Text): Parsed {
  let result = documentCache.get(doc);
  if (!result) { result = parseKnowledge(doc.toString()); documentCache.set(doc, result); }
  return result;
}

export function wikiCompletionAllowed(source: string, from: number, to: number): boolean {
  const escapes = source.slice(0, from).match(/\\+$/)?.[0].length ?? 0;
  return escapes % 2 === 0 && source[from - 1] !== "!" && parseKnowledge(source).textRanges.some((range) => from >= range.from && to <= range.to);
}

// Transform only parsed text nodes. Code, escaped markers, images and normal
// Markdown links remain untouched; ReactMarkdown escapes the resulting labels.
export function remarkWikiLinks() {
  return (root: Root, file: VFile) => {
    const source = String(file.value);
    if (!source.includes("[[")) return;
    const parsedLinks = (file.data.notoWikiLinks as WikiLink[] | undefined) ?? parseKnowledge(source).wiki;
    if (!parsedLinks.length) return;
    const starts=[0];
    for(let i=0;i<source.length;i++) if(source[i]==="\n")starts.push(i+1);
    function point(offset:number) {
      let lo=0,hi=starts.length;
      while(lo+1<hi){const mid=(lo+hi)>>>1;if(starts[mid]<=offset)lo=mid;else hi=mid;}
      return {offset,line:lo+1,column:offset-starts[lo]+1};
    }
    function visit(node: Node) {
      if (!node.children || ["link", "linkReference", "image", "imageReference"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        const from = child.position?.start.offset, to = child.position?.end.offset;
        if (child.type !== "text" || from === undefined || to === undefined) { visit(child); return [child]; }
        let low = 0, high = parsedLinks.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (parsedLinks[middle].from < from) low = middle + 1;
          else high = middle;
        }
        const links: WikiLink[] = [];
        for (let i = low; i < parsedLinks.length && parsedLinks[i].from < to; i++) {
          if (parsedLinks[i].to <= to) links.push(parsedLinks[i]);
        }
        if (!links.length) return [child];
        const parts: Node[] = [];
        let cursor = from;
        for (const link of links) {
          if (link.from > cursor) parts.push({ type: "text", value: decodeString(source.slice(cursor, link.from)).replace(/\r\n?/g, "\n") });
          parts.push({ type: "link", url: `noto-wiki:${encodeURIComponent(link.target)}`, position: {start:point(link.from),end:point(link.to)}, children: [{ type: "text", value: link.label }] });
          cursor = link.to;
        }
        if (cursor < to) parts.push({ type: "text", value: decodeString(source.slice(cursor, to)).replace(/\r\n?/g, "\n") });
        return parts;
      });
    }
    visit(root as unknown as Node);
  };
}
