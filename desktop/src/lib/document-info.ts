import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {headingIndex,type HeadingEntry} from "./heading-index";
import type {Root} from "mdast";

type Node = { type: string; depth?: number; value?: string; alt?: string; children?: Node[]; position?: { start: { offset?: number; line: number }; end: { offset?: number } } };
export type DocumentHeading = HeadingEntry;
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

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

export function documentInfo(source: string) {
  const tree = parser.parse(source);
  return { headings: headingIndex(source, tree), words: countWords(tree), characters: Array.from(source).length, lines: source.split("\n").length };
}
