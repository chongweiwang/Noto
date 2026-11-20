// Adapted from Noteriv's image renderer. Local images are resolved relative to
// the current note by the Noto adapter instead of assuming a vault-root path.
import type { InlineRenderer, InlineReplacement } from "../types";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const imageRenderer: InlineRenderer = {
  name: "images",
  priority: 10,
  find(text: string, offset: number): InlineReplacement[] {
    const results: InlineReplacement[] = [];
    const regex = /!\[((?:\\.|[^\]\\])*)\]\(((?:[^()]|\([^()]*\))+?)\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const escapes = text.slice(0, match.index).match(/\\+$/)?.[0].length ?? 0;
      if (escapes % 2) continue;
      const from = offset + match.index;
      results.push({
        from, to: from + match[0].length,
        html: `<img alt="${escapeAttribute(match[1].replace(/\\([\\\]])/g, "$1"))}" data-local-src="${escapeAttribute(match[2])}" class="md-inline-img"/>`,
        className: "md-image",
      });
    }
    return results;
  },
};
