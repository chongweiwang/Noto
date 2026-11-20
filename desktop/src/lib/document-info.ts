import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {headingIndex,type HeadingEntry} from "./heading-index";
import type {Root} from "mdast";
import type { WikiLink } from "./wiki-syntax";

type Node = { type: string; depth?: number; value?: string; alt?: string; children?: Node[]; position?: { start: { offset?: number; line: number }; end: { offset?: number } } };
export type DocumentHeading = HeadingEntry;
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export const liveMarkdownSize = 256 * 1024;
export const liveMarkdownLines = 6000;

function countWords(tree: Root) {
  const text: string[] = [];
  function visit(node: Node) {
    if (["text", "inlineCode", "code", "math", "inlineMath"].includes(node.type)) { text.push(node.value ?? ""); return; }
    if (node.type === "html") return;
    node.children?.forEach(visit);
  }
  visit(tree as Node);
  const readable = text.join(" "), chinese = readable.match(/\p{Script=Han}/gu)?.length ?? 0;
  return chinese + (readable.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0);
}

export function documentWordCount(source: string) {
  return countWords(parser.parse(source));
}

export function isLargeMarkdown(source: string) {
  if (source.length >= liveMarkdownSize) return true;
  let lineBreak = -1;
  for (let lines = 1; lines < liveMarkdownLines; lines++) {
    lineBreak = source.indexOf("\n", lineBreak + 1);
    if (lineBreak === -1) return false;
  }
  return true;
}

export function documentSize(source: string) {
  let lines = 1, characters = 0;
  for (const character of source) {
    characters++;
    if (character === "\n") lines++;
  }
  return { characters, lines };
}

export function documentInfo(source: string, tree = parser.parse(source), wikiLinks?: WikiLink[]) {
  return { headings: headingIndex(source, tree, wikiLinks), words: countWords(tree), ...documentSize(source) };
}
