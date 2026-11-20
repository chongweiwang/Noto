import type { InlineRenderer, InlineReplacement } from "../types";

interface InlinePattern {
  name: string;
  regex: RegExp;
  className: string;
  render: (captured: string) => string;
}

const patterns: InlinePattern[] = [
  {
    name: "bold-italic",
    regex: /(?<!\*)\*\*\*(.+?)\*\*\*(?!\*)/g,
    className: "md-bold-italic",
    render: (m) => `<strong><em>${m}</em></strong>`,
  },
  {
    name: "bold",
    regex: /(?<!\*)\*\*(.+?)\*\*(?!\*)/g,
    className: "md-bold",
    render: (m) => `<strong>${m}</strong>`,
  },
  {
    name: "bold-underscore",
    regex: /(?<![\p{L}\p{N}_])__(?!\s)(.+?)(?<!\s)__(?![\p{L}\p{N}_])/gu,
    className: "md-bold",
    render: (m) => `<strong>${m}</strong>`,
  },
  {
    name: "italic",
    regex: /(?<!\*)\*(.+?)\*(?!\*)/g,
    className: "md-italic",
    render: (m) => `<em>${m}</em>`,
  },
  {
    name: "italic-underscore",
    regex: /(?<![\p{L}\p{N}_])_(?!\s)(.+?)(?<!\s)_(?![\p{L}\p{N}_])/gu,
    className: "md-italic",
    render: (m) => `<em>${m}</em>`,
  },
  {
    name: "strikethrough",
    regex: /~~(.+?)~~/g,
    className: "md-strikethrough",
    render: (m) => `<del>${m}</del>`,
  },
  {
    name: "inline-code",
    regex: /(?<!`)`([^`]+)`(?!`)/g,
    className: "md-inline-code",
    render: (m) => `<code>${m}</code>`,
  },
  {
    name: "link",
    regex: /(?<!!)\[((?:\\.|[^\]\\])*)\]\(((?:[^()]|\([^()]*\))+?)\)/g,
    className: "md-link",
    render: (m) => m,
  },
];

/** Creates an InlineRenderer for a single formatting pattern. */
function makeInlineRenderer(pattern: InlinePattern): InlineRenderer {
  return {
    name: `inline-${pattern.name}`,
    priority: pattern.name === "inline-code" ? 0 : pattern.name === "link" ? 20 : 50,
    find(text: string, offset: number): InlineReplacement[] {
      const results: InlineReplacement[] = [];
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;

      while ((match = re.exec(text)) !== null) {
        const escapes = text.slice(0, match.index).match(/\\+$/)?.[0].length ?? 0;
        if (escapes % 2) continue;
        results.push({
          from: offset + match.index,
          to: offset + match.index + match[0].length,
          html: pattern.render(match[1].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")),
          className: pattern.className,
        });
      }

      return results;
    },
  };
}

/** All inline formatting renderers (bold, italic, code, etc.) */
export const inlineRenderers: InlineRenderer[] = patterns.map(makeInlineRenderer);
