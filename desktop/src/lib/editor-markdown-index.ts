import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { documentInfo } from "./document-info";
import { parseKnowledge, type WikiLink } from "./wiki-syntax";
import { blockIndex, findBlock } from "./wiki-block";
import { parseRichMarkdown, type RichRange } from "./rich-markdown";
import { parseNoteEmbeds, type NoteEmbed } from "./note-embed";

type Range = { from: number; to: number };
export type EditorMarkdownIndex = {
  fences: Range[];
  rich: RichRange[];
  wiki: WikiLink[];
  markers: (Range & { blockFrom: number; blockTo: number; standalone: boolean })[];
  embeds: NoteEmbed[];
};
export type DocumentInfo = ReturnType<typeof documentInfo>;
export type EditorAnalysisMessage =
  | { type: "index"; index: EditorMarkdownIndex }
  | { type: "info"; info: DocumentInfo }
  | { type: "error" };

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

// These ranges are non-overlapping and ordered by source offset.
export function firstIntersecting(ranges: readonly Range[], from: number) {
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].to < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function visibleRanges<T extends Range>(ranges: readonly T[], from: number, to: number): T[] {
  const first = firstIntersecting(ranges, from);
  let end = first;
  while (end < ranges.length && ranges[end].from <= to) end++;
  return ranges.slice(first, end);
}

function codeFences(source: string) {
  const ranges: Range[] = [];
  let open: { from: number; marker: string } | undefined;
  for (const match of source.matchAll(/^ {0,3}(`{3,}|~{3,})/gm)) {
    if (!open) open = { from: match.index, marker: match[1] };
    else if (match[1][0] === open.marker[0] && match[1].length >= open.marker.length) {
      const end = source.indexOf("\n", match.index);
      ranges.push({ from: open.from, to: end < 0 ? source.length : end });
      open = undefined;
    }
  }
  if (open) ranges.push({ from: open.from, to: source.length });
  return ranges;
}

export function analyzeEditorMarkdown(source: string, report: (message: EditorAnalysisMessage) => void, withInfo = false) {
  const hasWiki = source.includes("[[");
  const hasRich = source.includes("$") || /mermaid/i.test(source);
  const hasMarkers = /(?:^|\s)\^[A-Za-z0-9-]/.test(source);
  const tree = withInfo || hasWiki || hasRich || hasMarkers ? parser.parse(source) : undefined;
  const knowledge = hasWiki ? parseKnowledge(source, tree) : undefined;
  const blocks = hasMarkers ? blockIndex(source, tree) : undefined;
  const markers: EditorMarkdownIndex["markers"] = [];
  if (blocks) for (const block of blocks.blocks) {
    const marker = block.markers[0];
    if (block.markers.length === 1 && findBlock(blocks, marker.id).status === "resolved") {
      markers.push({ from: marker.from, to: marker.to, blockFrom: block.from, blockTo: block.to, standalone: marker.standalone });
    }
  }
  markers.sort((a, b) => a.from - b.from);
  const index = {
    fences: codeFences(source),
    rich: hasRich ? parseRichMarkdown(source, tree) : [],
    wiki: knowledge?.wiki ?? [],
    markers,
    embeds: source.includes("![[") ? parseNoteEmbeds(source, knowledge) : [],
  };
  report({ type: "index", index });
  if (withInfo) report({ type: "info", info: documentInfo(source, tree, index.wiki) });
}
