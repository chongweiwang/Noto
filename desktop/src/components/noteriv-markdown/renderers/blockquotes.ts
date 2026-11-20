import { Decoration } from "@codemirror/view";
import type { BlockRenderer, BlockContext } from "../types";
import { calloutMarker } from "../../../lib/markdown-callouts";
import { RenderedMarkdownWidget } from "../widget";

const blockquoteRegex = /^(>\s*)(.*)$/;

export const blockquoteRenderer: BlockRenderer = {
  name: "blockquotes",
  process(ctx: BlockContext): boolean {
    const match = ctx.text.match(blockquoteRegex);
    if (!match) return false;

    const marker = calloutMarker(match[2]);
    ctx.builder.add(ctx.line.from, ctx.line.from, Decoration.line({
      class: marker ? "md-blockquote markdown-callout callout-" + marker.kind : "md-blockquote",
    }));

    // Hide the > prefix
    ctx.builder.add(
      ctx.line.from,
      ctx.line.from + match[1].length + (marker?.length ?? 0),
      Decoration.replace(marker ? { widget: new RenderedMarkdownWidget(marker.label + " ", "callout-title") } : {})
    );

    // Return false so inline renderers still process the content
    // But we mark the line — inline processing happens in the plugin
    return true;
  },

  /** The content portion after the `>` prefix, for inline processing. */
  getContent(text: string): { offset: number; content: string } | null {
    const match = text.match(blockquoteRegex);
    if (!match) return null;
    const length = calloutMarker(match[2])?.length ?? 0;
    return { offset: match[1].length + length, content: match[2].slice(length) };
  },
};
